/**
 * backtest_longs.ts — Long Bot Backtester
 * ========================================
 * Tests long positions using positive funding + OI divergence signals.
 * Mirror analysis of backtest_signals.ts Gate 2 logic.
 *
 * Signal logic: when funding is extremely positive (longs crowded, paying shorts)
 * and OI is diverging upward while price is still flat, momentum tends to continue.
 * Going LONG captures this move. Same coins, same data, opposite position.
 *
 * Usage:
 *   npx tsx backtest_longs.ts --coin RAVE,SOLAYER,SNT --days 60 --chart
 *   npx tsx backtest_longs.ts --coin SOLAYER --days 60 --threshold 100 --chart
 *
 * Key parameters:
 *   --coin        Coins to test (comma-separated)
 *   --days        Lookback window in days (default: 60)
 *   --lookahead   Hours to track after entry (default: 48)
 *   --threshold   Min positive funding APR to qualify (default: 100)
 *   --min-oi      Min OI rise % in 4h window (default: 2)
 *   --max-price   Max price change % in 2h — entry when price still flat (default: 2)
 *   --stop-loss   Stop loss % below entry (default: 12)
 *   --min-positive Min positive funding readings in 8h window (default: 2)
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const BB_BASE = "https://api.bybit.com";
const BN_BASE = "https://fapi.binance.com";
const BN_DATA = "https://dapi.binance.com";
const HOUR = 3_600_000;

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
interface FundingRecord {
  timeMs: number;
  rate8h: number;
  ratePerHour: number;
}
interface OIRecord {
  timeMs: number;
  oiUsd: number;
}

interface Signal {
  timeMs: number;
  dateStr: string;
  entry: number;
  funding: number;
  oiChange4h: number;
  outcome?: SignalOutcome;
}

interface SignalOutcome {
  maxUp: number;
  maxDown: number;
  final: number;
  label: "SQUEEZED" | "DROPPED" | "NEUTRAL" | "STOPPED";
  icon: string;
  stopHit: boolean;
}

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const g = (f: string, fb: string) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fb;
};

const COINS = g("--coin", "RAVE,SOLAYER,SNT,MBOX,MLN,WAL,SONIC,XION")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);
const DAYS = parseInt(g("--days", "60"), 10);
const LOOKAHEAD = parseInt(g("--lookahead", "48"), 10);
const THRESHOLD = parseFloat(g("--threshold", "100"));
const MIN_OI = parseFloat(g("--min-oi", "2"));
const MAX_PRICE = parseFloat(g("--max-price", "2"));
const STOP_LOSS = parseFloat(g("--stop-loss", "12"));
const MIN_POSITIVE = parseInt(g("--min-positive", "2"), 10);
const CHART = argv.includes("--chart");

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJSON(url: string, retries = 4): Promise<unknown> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return res.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `  fetch failed (attempt ${attempt + 1}/${retries}): ${msg} — retrying...`,
      );
      await sleep(3000 * (attempt + 1)); // 3s, 6s, 9s backoff
    }
  }
  throw new Error("unreachable");
}

function floorH(ms: number): number {
  return Math.floor(ms / HOUR) * HOUR;
}
function avgArr(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// ── Data fetchers ─────────────────────────────────────────────────────────────
async function fetchCandles(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let curEnd = endMs;
  while (true) {
    const url =
      `${BB_BASE}/v5/market/kline?` +
      new URLSearchParams({
        category: "linear",
        symbol: `${coin}USDT`,
        interval: "60",
        end: String(curEnd),
        limit: "1000",
      });
    const data = (await fetchJSON(url)) as {
      retCode: number;
      result?: { list?: string[][] };
    };
    if (data.retCode !== 0 || !data.result?.list?.length) break;
    const list = data.result.list;
    for (const r of [...list].reverse()) {
      const t = parseInt(r[0]);
      if (t < startMs) continue;
      all.push({ t, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const oldestTs = parseInt(list[list.length - 1][0]);
    if (oldestTs <= startMs || list.length < 1000) break;
    curEnd = oldestTs - 1;
    await sleep(80);
  }
  const seen = new Set<number>();
  return all
    .sort((a, b) => a.t - b.t)
    .filter((c) => {
      if (seen.has(c.t)) return false;
      seen.add(c.t);
      return true;
    });
}

async function fetchBybitFunding(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<FundingRecord[]> {
  // Fetch funding interval first (4h or 8h varies by symbol)
  let intervalHours = 8.0;
  try {
    const info = (await fetchJSON(
      `${BB_BASE}/v5/market/instruments-info?category=linear&symbol=${coin}USDT`,
    )) as {
      result?: { list?: { fundingInterval: number }[] };
    };
    const interval = info.result?.list?.[0]?.fundingInterval;
    if (interval) intervalHours = interval / 60;
  } catch {
    /* use default 8h */
  }

  const all: FundingRecord[] = [];
  let cursor = "";
  while (true) {
    const params: Record<string, string> = {
      category: "linear",
      symbol: `${coin}USDT`,
      startTime: String(startMs),
      endTime: String(endMs),
      limit: "200",
    };
    if (cursor) params["cursor"] = cursor;
    const data = (await fetchJSON(
      `${BB_BASE}/v5/market/funding/history?` + new URLSearchParams(params),
    )) as {
      retCode: number;
      result?: {
        list?: { fundingRateTimestamp: string; fundingRate: string }[];
        nextPageCursor?: string;
      };
    };
    if (data.retCode !== 0 || !data.result?.list?.length) break;
    for (const r of [...(data.result.list ?? [])].reverse()) {
      const rate = parseFloat(r.fundingRate);
      all.push({
        timeMs: Number(r.fundingRateTimestamp),
        rate8h: rate,
        ratePerHour: rate / intervalHours,
      });
    }
    cursor = data.result.nextPageCursor ?? "";
    if (!cursor || (data.result.list?.length ?? 0) < 200) break;
    await sleep(80);
  }
  return all.sort((a, b) => a.timeMs - b.timeMs);
}

async function fetchBinanceFunding(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<FundingRecord[]> {
  try {
    const data = (await fetchJSON(
      `${BN_BASE}/fapi/v1/fundingRate?` +
        new URLSearchParams({
          symbol: `${coin}USDT`,
          startTime: String(startMs),
          endTime: String(endMs),
          limit: "1000",
        }),
    )) as { fundingTime: number; fundingRate: string }[];
    if (!Array.isArray(data)) return [];
    return data
      .map((r) => {
        const rate = parseFloat(r.fundingRate);
        return { timeMs: +r.fundingTime, rate8h: rate, ratePerHour: rate / 8 };
      })
      .sort((a, b) => a.timeMs - b.timeMs);
  } catch {
    return [];
  }
}

async function fetchBybitOI(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<OIRecord[]> {
  const records: OIRecord[] = [];
  let cursor = "";
  while (true) {
    const params: Record<string, string> = {
      category: "linear",
      symbol: `${coin}USDT`,
      intervalTime: "1h",
      startTime: String(startMs),
      endTime: String(endMs),
      limit: "200",
    };
    if (cursor) params["cursor"] = cursor;
    const data = (await fetchJSON(
      `${BB_BASE}/v5/market/open-interest?` + new URLSearchParams(params),
    )) as {
      retCode: number;
      result?: {
        list?: { openInterest: string; timestamp: string }[];
        nextPageCursor?: string;
      };
    };
    if (data.retCode !== 0 || !data.result?.list?.length) break;
    for (const r of [...data.result.list].reverse())
      records.push({
        timeMs: Number(r.timestamp),
        oiUsd: parseFloat(r.openInterest),
      });
    cursor = data.result.nextPageCursor ?? "";
    const oldest = Number(
      data.result.list[data.result.list.length - 1].timestamp,
    );
    if (!cursor || data.result.list.length < 200) break;
    if (oldest <= startMs) break;
    await sleep(80);
  }
  return records.sort((a, b) => a.timeMs - b.timeMs);
}

// ── Price-adjust Bybit OI from coin units to USD notional ───────────────────
function applyPriceToBybitOI(
  oiRecords: OIRecord[],
  priceByHour: Map<number, number>,
): OIRecord[] {
  return oiRecords
    .map((r) => ({
      timeMs: r.timeMs,
      oiUsd: r.oiUsd * (priceByHour.get(floorH(r.timeMs)) ?? 0),
    }))
    .filter((r) => r.oiUsd > 0);
}

// ── Merged funding ─────────────────────────────────────────────────────────────
function buildMergedFunding(
  bybitFunding: FundingRecord[],
  binanceFunding: FundingRecord[],
  startMs: number,
  endMs: number,
): Map<number, number> {
  // Forward-fill each exchange to hourly slots, matching backtest_signals.ts logic.
  // Returns Map<hourTs, ratePerHour> — annualise at query time: ratePerHour * 8760 * 100
  const allTs = new Set<number>();
  for (const r of [...bybitFunding, ...binanceFunding])
    allTs.add(floorH(r.timeMs));
  for (let h = startMs; h <= endMs; h += HOUR) allTs.add(h);

  const sfBb = [...bybitFunding].sort((a, b) => a.timeMs - b.timeMs);
  const sfBn = [...binanceFunding].sort((a, b) => a.timeMs - b.timeMs);

  let lastBb = 0,
    lastBn = 0;
  const hourMap = new Map<number, number>();

  for (const ts of [...allTs].sort((a, b) => a - b)) {
    for (const r of sfBb) {
      if (floorH(r.timeMs) <= ts) lastBb = r.ratePerHour;
      else break;
    }
    for (const r of sfBn) {
      if (floorH(r.timeMs) <= ts) lastBn = r.ratePerHour;
      else break;
    }
    // Pick most extreme (largest absolute value) — same as backtest_signals.ts
    hourMap.set(ts, Math.abs(lastBb) >= Math.abs(lastBn) ? lastBb : lastBn);
  }
  return hourMap;
}

// ── Signal detection ──────────────────────────────────────────────────────────
function detectLongSignals(
  candles: Candle[],
  fundingMap: Map<number, number>,
  oiRecords: OIRecord[],
  startMs: number,
): Signal[] {
  const signals: Signal[] = [];
  const COOL = 4 * HOUR; // 4h cooldown between signals — matches backtest_signals.ts
  const sigSet = new Set<string>();

  // Build hourly lookup maps (floor to hour, matching backtest_signals.ts)
  // Build hour-aligned lookups (floor to hour, matching backtest_signals.ts)
  const oiByHour = new Map<number, number>();
  for (const r of oiRecords) oiByHour.set(floorH(r.timeMs), r.oiUsd);

  const priceByHour = new Map<number, number>();
  for (const c of candles) priceByHour.set(floorH(c.t), c.c);

  // Use same allHours approach as backtest_signals.ts — iterate fundingMap hours
  const allHours = [...fundingMap.keys()].sort((a, b) => a - b);

  // Rolling series — matches exactly how backtest_signals.ts builds fSeries/oiSeries/pSeries
  const fSeries: number[] = [],
    oiSeries: number[] = [],
    pSeries: number[] = [];

  for (const ts of allHours) {
    const price = priceByHour.get(ts);
    if (!price) continue;
    const fRate = fundingMap.get(ts) ?? 0;

    fSeries.push(fRate);
    // OI: forward-fill gaps (same as original)
    oiSeries.push(oiByHour.get(ts) ?? oiSeries[oiSeries.length - 1] ?? 0);
    pSeries.push(price);
    if (fSeries.length > 10) fSeries.shift();
    if (oiSeries.length > 10) oiSeries.shift();
    if (pSeries.length > 10) pSeries.shift();

    if (ts < startMs) continue;

    // Gate 1: APR > threshold AND MIN_POSITIVE of last 8 positive (exact match to gate1Passes)
    if (fSeries.length < 8) continue;
    const last8 = fSeries.slice(-8);
    const apr = last8[last8.length - 1] * 8760 * 100;
    if (apr < THRESHOLD) continue;
    const positiveCount = last8.filter((r) => r > 0).length;
    if (positiveCount < MIN_POSITIVE) continue;

    // Gate 2: OI rising and price flat (exact match to gate2Passes)
    if (oiSeries.length < 6 || pSeries.length < 5) continue;
    const oiNow = avgArr(oiSeries.slice(-2));
    const oi4h = avgArr(oiSeries.slice(-5, -3));
    const px4h = pSeries[pSeries.length - 5];
    const pxNow = pSeries[pSeries.length - 1];
    if (!oi4h || !px4h) continue;
    const oiChange4h = ((oiNow - oi4h) / oi4h) * 100;
    const pxChange = Math.abs(((pxNow - px4h) / px4h) * 100);
    if (oiChange4h < MIN_OI) continue;
    if (pxChange >= MAX_PRICE) continue;

    // Cooldown deduplication
    const key = String(Math.floor(ts / COOL));
    if (sigSet.has(key)) continue;
    sigSet.add(key);

    signals.push({
      timeMs: ts,
      dateStr: fmtDate(ts),
      entry: price,
      funding: apr,
      oiChange4h,
    });
  }
  return signals;
}

// ── Outcome tracking ──────────────────────────────────────────────────────────
function trackOutcome(signal: Signal, candles: Candle[]): SignalOutcome {
  const entry = signal.entry;
  const stopPx = entry * (1 - STOP_LOSS / 100);
  const fwdEnd = signal.timeMs + LOOKAHEAD * HOUR; // time-bounded, not index-bounded
  let maxUp = 0,
    maxDown = 0;
  let closePx = entry;
  let stopHit = false;

  for (const c of candles) {
    if (c.t <= signal.timeMs) continue; // strictly after signal (matches original)
    if (c.t > fwdEnd) break;

    const hiPct = ((c.h - entry) / entry) * 100;
    const loPct = ((c.l - entry) / entry) * 100;
    maxUp = Math.max(maxUp, hiPct);
    maxDown = Math.min(maxDown, loPct);

    if (c.l <= stopPx) {
      stopHit = true;
      closePx = stopPx;
      maxDown = Math.min(maxDown, -STOP_LOSS);
      break;
    }
    closePx = c.c;
  }

  const finalPct = ((closePx - entry) / entry) * 100;
  let label: SignalOutcome["label"];
  if (stopHit) {
    label = "STOPPED";
  } else if (finalPct > 3) {
    label = "SQUEEZED"; // price kept going UP — good for long
  } else if (finalPct < -3) {
    label = "DROPPED"; // price dropped — bad for long
  } else {
    label = "NEUTRAL";
  }
  const icon = finalPct > 2 ? "✅" : finalPct < -2 ? "❌" : "😐";
  return {
    maxUp,
    maxDown: Math.abs(maxDown),
    final: finalPct,
    label,
    icon,
    stopHit,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runCoin(coin: string): Promise<Signal[]> {
  const nowMs = Date.now();
  const endMs = Math.floor(nowMs / HOUR) * HOUR; // align to hour boundary
  const startMs = endMs - DAYS * 24 * HOUR; // already aligned

  process.stdout.write(`── ${coin} ${"─".repeat(40 - coin.length)}\n`);

  const oiFetchFrom = endMs - 30 * 24 * HOUR; // Bybit OI capped at 30 days
  const [candles, bybitFunding, binanceFunding, rawOI] = await Promise.all([
    fetchCandles(coin, startMs, endMs),
    fetchBybitFunding(coin, startMs, endMs),
    fetchBinanceFunding(coin, startMs, endMs),
    fetchBybitOI(coin, oiFetchFrom, endMs),
  ]);

  // Build priceByHour for OI USD conversion (Bybit OI is in base coin units)
  const priceByHour = new Map<number, number>();
  for (const c of candles) priceByHour.set(floorH(c.t), c.c);
  const oiRecords = applyPriceToBybitOI(rawOI, priceByHour);

  process.stdout.write(
    `  ${candles.length} candles | ${bybitFunding.length} Bybit funding | ${binanceFunding.length} Binance funding | ${oiRecords.length} OI records (USD-adjusted)\n`,
  );

  const fundingMap = buildMergedFunding(
    bybitFunding,
    binanceFunding,
    startMs,
    endMs,
  );
  const signals = detectLongSignals(candles, fundingMap, oiRecords, startMs);

  // Track outcomes
  for (const sig of signals) {
    sig.outcome = trackOutcome(sig, candles);
  }

  const withOutcome = signals.filter((s) => s.outcome);
  const wins = withOutcome.filter((s) => (s.outcome?.final ?? 0) > 2);
  const stops = withOutcome.filter((s) => s.outcome?.stopHit);
  const avgFinal = withOutcome.length
    ? withOutcome.reduce((a, s) => a + (s.outcome?.final ?? 0), 0) /
      withOutcome.length
    : 0;
  const avgMax = withOutcome.length
    ? withOutcome.reduce((a, s) => a + (s.outcome?.maxUp ?? 0), 0) /
      withOutcome.length
    : 0;

  // ── Print results ─────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  ${coin} — ${DAYS}d long backtest | ${LOOKAHEAD}h lookahead`);
  console.log(
    `  Min funding: +${THRESHOLD}% APR | OI rise: +${MIN_OI}% | Stop: -${STOP_LOSS}%`,
  );
  console.log(`${"═".repeat(62)}`);
  console.log(`  Signals:      ${withOutcome.length}`);
  console.log(
    `  Win rate:     ${wins.length}/${withOutcome.length} = ${withOutcome.length ? ((wins.length / withOutcome.length) * 100).toFixed(0) : 0}%`,
  );
  console.log(`  Stop-outs:    ${stops.length}`);
  console.log(
    `  Avg final:    ${avgFinal >= 0 ? "+" : ""}${avgFinal.toFixed(2)}%  (${(avgFinal * 3).toFixed(2)}% at 3x)`,
  );
  console.log(`  Avg max gain: +${avgMax.toFixed(2)}%`);

  for (const s of withOutcome) {
    const o = s.outcome!;
    const stopStr = o.stopHit ? " 🛑STOPPED" : "";
    console.log(
      `  ${o.icon} ${s.dateStr}  funding=+${s.funding.toFixed(1)}%APR  OI+${s.oiChange4h.toFixed(1)}%\n` +
        `      max:+${o.maxUp.toFixed(2)}%  min:-${o.maxDown.toFixed(2)}%  final:${o.final >= 0 ? "+" : ""}${o.final.toFixed(2)}%  → ${o.label}${stopStr}`,
    );
  }

  return withOutcome;
}

async function main() {
  console.log(`\nAltShortBot — Long Bot Backtester`);
  console.log(`${"═".repeat(42)}`);
  console.log(`Coins:      ${COINS.join(", ")}`);
  console.log(`Period:     last ${DAYS} days | ${LOOKAHEAD}h lookahead`);
  console.log(
    `Signal:     funding > +${THRESHOLD}% APR + OI +${MIN_OI}%/4h + price flat <${MAX_PRICE}%`,
  );
  console.log(`Stop loss:  -${STOP_LOSS}% from entry\n`);

  const allSignals: Signal[] = [];
  for (const coin of COINS) {
    const signals = await runCoin(coin);
    allSignals.push(...signals);
    await sleep(200);
  }

  // ── Aggregate summary ─────────────────────────────────────────────────────
  if (COINS.length > 1 && allSignals.length > 0) {
    const wins = allSignals.filter((s) => (s.outcome?.final ?? 0) > 2);
    const stops = allSignals.filter((s) => s.outcome?.stopHit);
    const avg =
      allSignals.reduce((a, s) => a + (s.outcome?.final ?? 0), 0) /
      allSignals.length;
    const avgMax =
      allSignals.reduce((a, s) => a + (s.outcome?.maxUp ?? 0), 0) /
      allSignals.length;

    console.log(`\n${"═".repeat(62)}`);
    console.log(
      `  AGGREGATE — ${allSignals.length} signals across ${COINS.length} coins`,
    );
    console.log(`${"═".repeat(62)}`);
    console.log(
      `  Win rate:     ${wins.length}/${allSignals.length} = ${((wins.length / allSignals.length) * 100).toFixed(0)}%`,
    );
    console.log(
      `  Stop-outs:    ${stops.length}/${allSignals.length} = ${((stops.length / allSignals.length) * 100).toFixed(0)}%`,
    );
    console.log(
      `  Avg final:    ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%  (${(avg * 3).toFixed(2)}% at 3x)`,
    );
    console.log(`  Avg max gain: +${avgMax.toFixed(2)}%`);

    // Compare: same signals as shorts would lose
    console.log(`\n  For reference — same signals as SHORTS would give:`);
    console.log(
      `  Avg final:   ${(-avg).toFixed(2)}%  (${(-avg * 3).toFixed(2)}% at 3x)`,
    );
  }

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
