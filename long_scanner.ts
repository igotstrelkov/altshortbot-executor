/**
 * long_scanner.ts — Long Bot Signal Scanner
 * ==========================================
 * Batch-fetches all Bybit tickers in one call, pre-filters to coins above
 * funding threshold, then runs full Gate 1 + Gate 2 checks on candidates only.
 * All data fetchers and gate logic match live_scanner.ts exactly.
 *
 * Signal: funding > +200% APR + OI +2%/4h + price flat <2%/4h
 * Validated: 50% win rate, avg +7.17% (+21.50% at 3x), 0 stop-outs
 *
 * Run:  npx tsx long_scanner.ts --dry-run
 *       npx tsx long_scanner.ts --coins LAB,IRYS,SOLAYER
 *       npx tsx long_scanner.ts
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const COINS_ARG = process.argv.find(
  (_, i) => process.argv[i - 1] === "--coins",
);
const COINS_ENV = process.env.SCANNER_COINS; // alternative to --coins flag
const COINS_ONLY =
  (COINS_ARG ?? COINS_ENV)?.split(",").map((c) => c.trim().toUpperCase()) ??
  null;

const PARAMS = {
  fundingAprThreshold: 200, // validated optimal threshold
  minPositiveReadings: 2, // Gate 1: min positive readings in last 8h
  minOiChangePct: 2, // Gate 2: min OI rise % over 4h
  maxPriceChangePct: 2, // Gate 2: max price change % over 4h
  cooldownH: 4, // hours between signals per coin
} as const;

const LONG_QUEUE_FILE = "long_queue.json";
const LONG_STATE_FILE = "long_scanner_state.json";
const BB_BASE = "https://api.bybit.com";
const BN_BASE = "https://fapi.binance.com";
const HOUR = 3_600_000;
const floorH = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Types ─────────────────────────────────────────────────────────────────────
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
  ratePerHour: number;
}
interface OIRecord {
  timeMs: number;
  oiUsd: number;
}
interface TickerSnapshot {
  coin: string;
  lastPrice: number;
  fundingRate: number;
  apr: number;
}
interface LongScannerState {
  [coin: string]: { lastSignalMs: number };
}

interface QueuedLongSignal {
  coin: string;
  type: "LONG_MOMENTUM";
  firedAt: number;
  firedAtStr: string;
  entry: number;
  fundingApr: number;
  oiChange4h: number;
  confidence: "HIGH" | "MEDIUM";
  queuedAt: number;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[telegram]", msg);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    /* non-fatal */
  }
}

// ─── HTTP — matches live_scanner.ts fetchJSON exactly ────────────────────────
async function fetchJSON(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 403) throw new Error("403 — coin may be delisted");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`fetchJSON failed: ${url}`);
}

// ─── State / Queue ─────────────────────────────────────────────────────────────
function loadState(): LongScannerState {
  if (!existsSync(LONG_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LONG_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: LongScannerState): void {
  writeFileSync(LONG_STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}
function appendQueue(sig: QueuedLongSignal): void {
  let q: QueuedLongSignal[] = [];
  try {
    if (existsSync(LONG_QUEUE_FILE))
      q = JSON.parse(readFileSync(LONG_QUEUE_FILE, "utf8"));
  } catch {
    q = [];
  }
  q.push(sig);
  writeFileSync(LONG_QUEUE_FILE, JSON.stringify(q, null, 2), "utf8");
}

// ─── Data fetchers — all match live_scanner.ts patterns exactly ───────────────

async function fetchCandidates(specific?: string[]): Promise<TickerSnapshot[]> {
  const data = (await fetchJSON(
    `${BB_BASE}/v5/market/tickers?category=linear`,
  )) as {
    result?: {
      list?: { symbol: string; lastPrice: string; fundingRate: string }[];
    };
  };
  const all = (data.result?.list ?? [])
    .filter((t) => t.symbol.endsWith("USDT"))
    .map((t) => ({
      coin: t.symbol.replace("USDT", ""),
      lastPrice: parseFloat(t.lastPrice),
      fundingRate: parseFloat(t.fundingRate),
      apr: parseFloat(t.fundingRate) * 3 * 365 * 100,
    }));
  return (specific ? all.filter((t) => specific.includes(t.coin)) : all)
    .filter((t) => t.apr >= PARAMS.fundingAprThreshold)
    .sort((a, b) => b.apr - a.apr);
}

// Matches live_scanner.ts fetchCandles — Bybit newest-first, reversed
async function fetchCandles(coin: string, limit = 20): Promise<Candle[]> {
  const raw = (await fetchJSON(
    `${BB_BASE}/v5/market/kline?category=linear&symbol=${coin}USDT&interval=60&limit=${limit}`,
  )) as { result?: { list?: string[][] } };
  return (raw?.result?.list ?? []).reverse().map((r) => ({
    t: parseInt(r[0]),
    o: parseFloat(r[1]),
    h: parseFloat(r[2]),
    l: parseFloat(r[3]),
    c: parseFloat(r[4]),
    v: parseFloat(r[5]),
  }));
}

// Matches live_scanner.ts fetchFundingBybit — fetches interval from instruments-info
async function fetchFundingBybit(coin: string): Promise<FundingRecord[]> {
  let intervalHours = 8;
  try {
    const info = (await fetchJSON(
      `${BB_BASE}/v5/market/instruments-info?category=linear&symbol=${coin}USDT`,
    )) as { result?: { list?: { fundingInterval?: number }[] } };
    const fi = info?.result?.list?.[0]?.fundingInterval;
    if (fi) intervalHours = fi / 60;
  } catch {
    /* default 8h */
  }

  const raw = (await fetchJSON(
    `${BB_BASE}/v5/market/funding/history?category=linear&symbol=${coin}USDT&limit=200`,
  )) as {
    result?: { list?: { fundingRateTimestamp: string; fundingRate: string }[] };
  };

  return (raw?.result?.list ?? [])
    .map((r) => ({
      timeMs: parseInt(r.fundingRateTimestamp),
      ratePerHour: parseFloat(r.fundingRate) / intervalHours,
    }))
    .reverse(); // chronological
}

// Matches live_scanner.ts fetchFundingBinance
async function fetchFundingBinance(coin: string): Promise<FundingRecord[]> {
  try {
    const raw = (await fetchJSON(
      `${BN_BASE}/fapi/v1/fundingRate?symbol=${coin}USDT&limit=200`,
    )) as { fundingTime: number; fundingRate: string }[];
    return raw.map((r) => ({
      timeMs: r.fundingTime,
      ratePerHour: parseFloat(r.fundingRate) / 8,
    }));
  } catch {
    return [];
  }
}

// Matches live_scanner.ts buildMergedFundingByHour exactly
function buildMergedFundingByHour(
  bybit: FundingRecord[],
  binance: FundingRecord[],
): Record<number, number> {
  function forwardFill(records: FundingRecord[]): Record<number, number> {
    const sorted = [...records].sort((a, b) => a.timeMs - b.timeMs);
    if (!sorted.length) return {};
    const out: Record<number, number> = {};
    let last = 0,
      rIdx = 0;
    const startTs = floorH(sorted[0].timeMs);
    const endTs = floorH(Date.now()) + HOUR;
    for (let ts = startTs; ts <= endTs; ts += HOUR) {
      while (rIdx < sorted.length && floorH(sorted[rIdx].timeMs) <= ts) {
        last = sorted[rIdx].ratePerHour;
        rIdx++;
      }
      out[ts] = last;
    }
    return out;
  }
  const bbMap = forwardFill(bybit),
    bnMap = forwardFill(binance);
  const allTs = Array.from(
    new Set([...Object.keys(bbMap), ...Object.keys(bnMap)].map(Number)),
  );
  const merged: Record<number, number> = {};
  for (const ts of allTs) {
    const bb = bbMap[ts] ?? 0,
      bn = bnMap[ts] ?? 0;
    merged[ts] = Math.abs(bb) >= Math.abs(bn) ? bb : bn;
  }
  return merged;
}

// Matches live_scanner.ts fetchOIHistory — inline price conversion using candles
async function fetchOIHistory(
  coin: string,
  candles: Candle[],
): Promise<OIRecord[]> {
  const raw = (await fetchJSON(
    `${BB_BASE}/v5/market/open-interest?category=linear&symbol=${coin}USDT&intervalTime=1h&limit=20`,
  )) as { result?: { list?: { timestamp: string; openInterest: string }[] } };
  const priceByHour: Record<number, number> = {};
  for (const c of candles) priceByHour[floorH(c.t)] = c.c;
  const currentPrice = candles[candles.length - 1].c;
  return (raw?.result?.list ?? []).reverse().map((r) => {
    const ts = parseInt(r.timestamp);
    return {
      timeMs: ts,
      oiUsd:
        parseFloat(r.openInterest) * (priceByHour[floorH(ts)] ?? currentPrice),
    };
  });
}

// Matches live_scanner.ts getLast8HourlyFundingReadings exactly
// Matches live_scanner.ts getLast8HourlyFundingReadings exactly
function getLast8(
  fundingByHour: Record<number, number>,
  nowMs: number,
): number[] {
  const result: number[] = [];
  for (let i = 7; i >= 0; i--)
    result.push(fundingByHour[floorH(nowMs - i * HOUR)] ?? 0);
  return result;
}

// Matches live_scanner.ts checkGate2 exactly — direct point comparison
function checkGate2(
  oiHistory: OIRecord[],
  candles: Candle[],
): { passes: boolean; oiChangePct: number } {
  if (oiHistory.length < 5) return { passes: false, oiChangePct: 0 };
  const oiNow = oiHistory[oiHistory.length - 1].oiUsd;
  const oi4hAgo = oiHistory[oiHistory.length - 5].oiUsd;
  const oiChangePct = oi4hAgo > 0 ? ((oiNow - oi4hAgo) / oi4hAgo) * 100 : 0;
  const priceNow = candles[candles.length - 1].c;
  const price4hAgo =
    candles.length >= 5 ? candles[candles.length - 5].c : priceNow;
  const pxChange = Math.abs(
    ((priceNow - price4hAgo) / (price4hAgo || 1)) * 100,
  );
  return {
    passes:
      oiChangePct >= PARAMS.minOiChangePct &&
      pxChange <= PARAMS.maxPriceChangePct,
    oiChangePct,
  };
}

// ─── Per-coin scan ─────────────────────────────────────────────────────────────
async function scanCoin(
  snap: TickerSnapshot,
  nowMs: number,
): Promise<QueuedLongSignal | null> {
  const { coin, lastPrice, apr: fundingApr } = snap;

  const [candles, bbFunding, bnFunding] = await Promise.all([
    fetchCandles(coin, 20),
    fetchFundingBybit(coin),
    fetchFundingBinance(coin),
  ]);

  if (candles.length < 5) return null;

  // Gate 1: min positive readings in last 8h
  const fundingByHour = buildMergedFundingByHour(bbFunding, bnFunding);
  const last8 = getLast8(fundingByHour, nowMs);
  const positiveCount = last8.filter((r) => r > 0).length;
  if (positiveCount < PARAMS.minPositiveReadings) return null;

  // Gate 2: OI rising, price flat (separate call — needs candles for price conversion)
  const oiHistory = await fetchOIHistory(coin, candles);
  const gate2 = checkGate2(oiHistory, candles);
  if (!gate2.passes) return null;

  return {
    coin,
    type: "LONG_MOMENTUM",
    firedAt: nowMs,
    firedAtStr: new Date(nowMs).toISOString().slice(0, 16).replace("T", " "),
    entry: lastPrice,
    fundingApr,
    oiChange4h: gate2.oiChangePct,
    confidence: fundingApr >= 500 ? "HIGH" : "MEDIUM",
    queuedAt: Date.now(),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const nowMs = Date.now();
  console.log(`\nAltShortBot Long Scanner — ${new Date(nowMs).toISOString()}`);
  if (DRY_RUN) console.log("Mode: DRY RUN (no queue writes)");

  const state = loadState();
  const candidates = await fetchCandidates(COINS_ONLY ?? undefined);

  console.log(
    `\nPre-filter: ${candidates.length} coin(s) above +${PARAMS.fundingAprThreshold}% APR`,
  );
  if (!candidates.length) {
    console.log("No candidates — market not bullish enough.\n");
    return;
  }
  candidates.forEach((c) =>
    console.log(`  ${c.coin.padEnd(12)} +${c.apr.toFixed(0)}% APR`),
  );
  console.log();

  let fired = 0;

  for (const snap of candidates) {
    process.stdout.write(`  ${snap.coin}... `);

    if (
      nowMs - (state[snap.coin]?.lastSignalMs ?? 0) <
      PARAMS.cooldownH * HOUR
    ) {
      console.log("cooldown");
      continue;
    }

    try {
      const signal = await scanCoin(snap, nowMs);
      if (!signal) {
        console.log("gates failed");
        await sleep(150);
        continue;
      }

      console.log(
        `SIGNAL  funding +${signal.fundingApr.toFixed(0)}% APR  OI +${signal.oiChange4h.toFixed(1)}%`,
      );
      const icon = signal.confidence === "HIGH" ? "🟢 HIGH" : "🟡 MEDIUM";
      await sendTelegram(
        `📈 *ALTSHORTBOT LONG — ${snap.coin}*\n` +
          `Signal: *LONG_MOMENTUM*\n` +
          `Entry: $${signal.entry.toFixed(6)}\n` +
          `Funding: +${signal.fundingApr.toFixed(0)}% APR\n` +
          `OI Rise: +${signal.oiChange4h.toFixed(1)}%/4h\n` +
          `Confidence: ${icon}\n` +
          `${DRY_RUN ? "⚠️ DRY RUN" : "🚀 Queued for long executor"}`,
      );
      if (!DRY_RUN) {
        appendQueue(signal);
        state[snap.coin] = { lastSignalMs: nowMs };
      }
      fired++;
    } catch (e) {
      console.log(`error: ${(e as Error).message}`);
    }

    await sleep(150); // rate limit buffer — matches live_scanner.ts
  }

  if (!DRY_RUN) saveState(state);
  console.log(`\nDone. ${fired} long signal(s).\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
