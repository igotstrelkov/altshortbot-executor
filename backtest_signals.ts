import { writeFileSync } from "fs";

/**
 * AltShortBot Signal Backtester
 * ================================
 * Tests the funding-pressure + OI-divergence signal strategy against
 * Binance + Bybit Futures historical data. No API key required.
 *
 * ── VALIDATED PARAMETER SET ─────────────────────────────────────────────────
 * Backtested across HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, ENA, DASH.
 * Use these params for consistent results matching validated signal quality:
 *
 *   npx tsx backtest_signals.ts --coin ORDI --days 30 \
 *     --threshold 10 --min-positive 2 --min-oi 2 --max-price 2 \
 *     --pump-pct 25 --pump-vol 5 --pump-rsi 88 --pump-funding 0 \
 *     --squeeze-pct 20 --squeeze-hours 10 --squeeze-funding -100 --squeeze-oi-drop 3 \
 *     --lookahead 48 --chart
 *
 * ── PARAMETER REFERENCE ─────────────────────────────────────────────────────
 *
 *  GATE 1 (crowded longs setup):
 *   --threshold N       Funding APR % to trigger Gate 1          (tuned: 10,  default: 50)
 *   --min-positive N    Min positive readings out of last 8       (tuned:  2,  default:  6)
 *
 *  GATE 2 (OI divergence confirmation):
 *   --min-oi N          OI change % required                      (tuned:  2,  default:  5)
 *   --max-price N       Max price change % allowed                (tuned:  2,  default:  0.5)
 *
 *  PUMP TOP detection:
 *   --pump-pct N        Min candle size %                         (tuned: 25,  default: 20)
 *   --pump-vol N        Min volume multiplier                     (tuned:  5,  default:  8)
 *   --pump-rsi N        Min RSI at trigger                        (tuned: 88,  default: 80)
 *   --pump-funding N    Min funding APR % at trigger              (tuned:  0,  default: 50)
 *
 *  SHORT SQUEEZE detection:
 *   --squeeze-pct N     Min cumulative price rise % over window   (tuned: 20,  default: 20)
 *   --squeeze-hours N   Hour window for cumulative move           (tuned: 10,  default:  6)
 *   --squeeze-funding N Max funding APR for building phase        (tuned:-100, default:-10)
 *   --squeeze-oi-drop N Min OI drop % required                   (tuned:  0,  default:  3)
 *   --exhaust-funding N Min funding APR for exhaustion phase      (tuned:-20,  default:-20)
 *                        Tighter than building threshold to block false exhaustion
 *                        when funding oscillates during active squeezes.
 *
 *  TREND BREAK detection:
 *   --trend-7d N        7-day price rise % to flag uptrend        (default: 30)
 *   --trend-14d N       14-day price rise % to flag uptrend       (default: 50)
 *   --trend-break-apr N Max building funding APR for trend break  (default: -500)
 *   --no-trend-filter   Disable trend filter entirely
 *
 *  GENERAL:
 *   --coin COIN[,...]   Coin name(s), comma-separated
 *   --days N            Lookback period in days                   (tuned: 30)
 *   --lookahead N       Hours after signal to measure outcome     (tuned: 48,  default: 24)
 *   --chart             Generate interactive HTML chart → backtest_chart.html
 *   --output FILE       Save results to CSV
 *   --json FILE         Save results to JSON (used by backtest_test.ts)
 *   --list              List all available coins
 *   --search TERM       Search coins by name
 *
 * ── SIGNAL QUALITY NOTES ────────────────────────────────────────────────────
 * Exhaustion annotation:
 *   ✅ building Xh ago  — Prior building confirmed. Confidence increases with gap:
 *                          <4h  = treat cautiously (squeeze may continue)
 *                          6h+  = high confidence
 *                          18h+ = very high confidence (multiple wave confirmation)
 *   ⚠️  no prior building — Standalone exhaustion. Lower confidence.
 *                           In live trading, require additional confirmation.
 *
 * Funding source:
 *   Merged from Binance + Bybit using LARGEST ABSOLUTE VALUE per hour.
 *   When Bybit has -1029% and Binance has 0%, Bybit wins (squeeze is real).
 *   When Binance has +150% and Bybit has 0%, Binance wins (longs are crowded).
 *
 * Coin selection guidance:
 *   Best fit:  Small-mid cap altcoins with active Bybit perpetuals
 *              (HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH)
 *   Poor fit:  Large caps with gradual moves (ALGO, ETH, BTC — rarely fire)
 *   Warning:   Coins with 10+ consecutive building alerts = mega-squeeze.
 *              Treat all exhaustion signals with extra caution.
 */

const BN_BASE = "https://fapi.binance.com";
const BN_DATA = "https://fapi.binance.com/futures/data";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Config {
  coins: string[];
  days: number;
  lookaheadHours: number;
  fundingAprThreshold: number;
  minPositiveReadings: number;
  minOiChangePct: number;
  maxPriceChangePct: number;
  pumpMinPct: number;
  pumpMinVolMult: number;
  pumpMinRsi: number;
  pumpMinFundingApr: number;
  squeezeMinPct: number;
  squeezeHours: number;
  squeezeMaxFundingApr: number; // funding must be BELOW this to count as building (default -100%)
  exhaustMaxFundingApr: number; // funding must be ABOVE this to count as exhaustion (default -20%)
  exhaustMinOiDrop: number; // OI must have dropped this % for exhaustion to fire (0 = disabled)
  squeezeMinOiDrop: number;
  trendFilter: boolean;
  trendDays7Pct: number;
  trendDays14Pct: number;
  trendBreakFundingApr: number;
  megaSqueezeHours: number;
  generateChart: boolean;
  jsonOutput?: string;
  saveFixtures?: string; // directory to save raw API responses
  useFixtures?: string; // directory to load fixtures from (skips API calls)
  outputPath?: string;
}

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
  coin: string;
  firedAtMs: number;
  firedAtStr: string;
  entryPrice: number;
  fundingApr: number;
  oiChangePct: number;
  priceChangePct: number;
  signalType: "FUNDING" | "PUMP_TOP" | "SQUEEZE"; // which strategy fired
}

interface SqueezeSignal {
  coin: string;
  firedAtMs: number;
  firedAtStr: string;
  entryPrice: number;
  cumulativePct: number;
  squeezeHours: number;
  oiDropPct: number;
  fundingApr: number;
  signalPhase: "BUILDING" | "EXHAUSTION" | "TREND_BREAK";
  trendBreak: boolean;
  msSinceBuilding: number | null; // ms since last BUILDING signal (-1 = none)  // true when fired at top of parabolic run
}

interface PumpSignal {
  coin: string;
  firedAtMs: number;
  firedAtStr: string;
  entryPrice: number;
  candlePumpPct: number; // % move in the trigger candle
  volumeMultiple: number; // volume vs 48h avg
  rsi: number; // RSI at trigger
  fundingApr: number; // funding at trigger (confirms leverage)
}

interface Outcome {
  signal: Signal | PumpSignal;
  signalType: "FUNDING" | "PUMP_TOP" | "SQUEEZE";
  maxPricePct: number;
  minPricePct: number;
  finalPricePct: number;
  verdict: string;
}

interface CoinResult {
  coin: string;
  outcomes: Outcome[]; // funding strategy signals
  pumpOutcomes: Outcome[]; // pump-top strategy signals
  squeezeOutcomes: Outcome[]; // short squeeze signals
  allHours: number[];
  priceByHour: Record<number, number>;
  fundingAprByHour: Record<number, number>;
  oiByHour: Record<number, number>;
  startMs: number;
  gate2Available: boolean;
  bybitFundingPct: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binance REST helpers
// ─────────────────────────────────────────────────────────────────────────────

async function bnGet(
  base: string,
  path: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params))
    url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString());
    if (res.status === 429 || res.status === 418) {
      const wait = Math.pow(2, attempt + 1) * 1000;
      process.stdout.write(`  Rate limited — waiting ${wait / 1000}s...\r`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.pathname}`);
    return res.json();
  }
  throw new Error(`Failed: ${path}`);
}

async function fetchKlines(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let cur = startMs;
  while (cur < endMs) {
    const batch = (await bnGet(BN_BASE, "/fapi/v1/klines", {
      symbol,
      interval: "1h",
      startTime: cur,
      endTime: endMs,
      limit: 1000,
    })) as unknown[][];
    if (!batch.length) break;
    for (const r of batch) {
      const row = r as (string | number)[];
      all.push({
        t: +row[0],
        o: +row[1],
        h: +row[2],
        l: +row[3],
        c: +row[4],
        v: +row[5],
      });
    }
    cur = +(batch[batch.length - 1] as (string | number)[])[0] + 1;
    if (batch.length < 1000) break;
    await sleep(80);
  }
  return all;
}

async function fetchFundingHistory(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<FundingRecord[]> {
  const all: FundingRecord[] = [];
  let cur = startMs;
  while (cur < endMs) {
    const batch = (await bnGet(BN_BASE, "/fapi/v1/fundingRate", {
      symbol,
      startTime: cur,
      endTime: endMs,
      limit: 1000,
    })) as { fundingTime: number; fundingRate: string }[];
    if (!batch.length) break;
    for (const r of batch) {
      const r8h = parseFloat(r.fundingRate);
      all.push({ timeMs: +r.fundingTime, rate8h: r8h, ratePerHour: r8h / 8 });
    }
    cur = +batch[batch.length - 1].fundingTime + 1;
    if (batch.length < 1000) break;
    await sleep(80);
  }
  return all;
}

async function fetchOIHistory(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<OIRecord[]> {
  const all: OIRecord[] = [];
  let cur = startMs;
  while (cur < endMs) {
    const batch = (await bnGet(BN_DATA, "/openInterestHist", {
      symbol,
      period: "1h",
      startTime: cur,
      endTime: endMs,
      limit: 500,
    })) as { timestamp: number; sumOpenInterestValue: string }[];
    if (!batch.length) break;
    for (const r of batch)
      all.push({
        timeMs: +r.timestamp,
        oiUsd: parseFloat(r.sumOpenInterestValue),
      });
    cur = +batch[batch.length - 1].timestamp + 1;
    if (batch.length < 500) break;
    await sleep(80);
  }
  return all;
}

async function fetchBybitOIHistory(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<OIRecord[]> {
  const records: OIRecord[] = [];
  let cursor = "";
  const LIMIT = 200;
  let cur = startMs;

  while (cur < endMs) {
    const params: Record<string, string> = {
      category: "linear",
      symbol,
      intervalTime: "1h",
      startTime: String(cur),
      endTime: String(endMs),
      limit: String(LIMIT),
    };
    if (cursor) params["cursor"] = cursor;

    const url =
      "https://api.bybit.com/v5/market/open-interest?" +
      new URLSearchParams(params).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      retCode: number;
      result: {
        list: { openInterest: string; timestamp: string }[];
        nextPageCursor?: string;
      };
    };

    if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode}`);
    const list = data.result?.list ?? [];
    if (!list.length) break;

    // Bybit returns newest-first — reverse for chronological order
    for (const row of [...list].reverse()) {
      records.push({
        timeMs: Number(row.timestamp),
        oiUsd: parseFloat(row.openInterest), // base units — multiplied by price later
      });
    }

    cursor = data.result?.nextPageCursor ?? "";
    cur = Number(list[0].timestamp) + 1; // advance past newest record
    if (!cursor || list.length < LIMIT) break;
    await sleep(80);
  }

  return records.sort((a, b) => a.timeMs - b.timeMs);
}

function applyPriceToBybitOI(
  oiRecords: OIRecord[],
  priceByHour: Record<number, number>,
): OIRecord[] {
  // Bybit OI is in base coin units. Multiply by mark price to get USD notional.
  return oiRecords
    .map((rec) => {
      const price = priceByHour[floorH(rec.timeMs)] ?? 0;
      return { timeMs: rec.timeMs, oiUsd: rec.oiUsd * price };
    })
    .filter((r) => r.oiUsd > 0);
}
async function fetchBybitFundingHistory(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<FundingRecord[]> {
  // Bybit: GET /v5/market/funding/history
  // Returns fundingRate (per interval) + fundingRateTimestamp
  // Interval varies by symbol — fetch from instruments first
  const records: FundingRecord[] = [];

  // First: get the funding interval for this symbol
  let intervalHours = 8.0; // default
  try {
    const infoRes = await fetch(
      `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`,
    );
    if (infoRes.ok) {
      const infoData = (await infoRes.json()) as {
        result: { list: { fundingInterval: number }[] };
      };
      const inst = infoData.result?.list?.[0];
      if (inst?.fundingInterval) intervalHours = inst.fundingInterval / 60;
    }
  } catch {
    /* use default */
  }

  // Fetch funding history with cursor pagination
  let cursor = "";
  const LIMIT = 200;
  let cur = startMs;

  while (cur < endMs) {
    const params: Record<string, string> = {
      category: "linear",
      symbol,
      startTime: String(cur),
      endTime: String(endMs),
      limit: String(LIMIT),
    };
    if (cursor) params["cursor"] = cursor;

    const url =
      "https://api.bybit.com/v5/market/funding/history?" +
      new URLSearchParams(params).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      retCode: number;
      result: {
        list: { fundingRate: string; fundingRateTimestamp: string }[];
        nextPageCursor?: string;
      };
    };

    if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode}`);
    const list = data.result?.list ?? [];
    if (!list.length) break;

    // Bybit returns newest-first — reverse for chronological order
    for (const row of [...list].reverse()) {
      const rate = parseFloat(row.fundingRate);
      records.push({
        timeMs: Number(row.fundingRateTimestamp),
        rate8h: rate,
        ratePerHour: rate / intervalHours, // normalise to per-hour
      });
    }

    cursor = data.result?.nextPageCursor ?? "";
    cur = Number(list[0].fundingRateTimestamp) + 1;
    if (!cursor || list.length < LIMIT) break;
    await sleep(80);
  }

  return records.sort((a, b) => a.timeMs - b.timeMs);
}

function mergeToHighestFunding(
  binanceRecords: FundingRecord[],
  bybitRecords: FundingRecord[],
): { merged: Record<number, number>; source: Record<number, string> } {
  // At each 1h slot, keep whichever exchange had the higher per-hour rate.
  // Returns: merged[hourTs] = per-hour rate, source[hourTs] = "binance"|"bybit"
  const merged: Record<number, number> = {};
  const source: Record<number, string> = {};

  const allTs = new Set([
    ...binanceRecords.map((r) => floorH(r.timeMs)),
    ...bybitRecords.map((r) => floorH(r.timeMs)),
  ]);

  // Forward-fill each exchange to hourly slots
  const bnByHour: Record<number, number> = {};
  const bbByHour: Record<number, number> = {};

  const sfBn = [...binanceRecords].sort((a, b) => a.timeMs - b.timeMs);
  const sfBb = [...bybitRecords].sort((a, b) => a.timeMs - b.timeMs);

  let lastBn = 0,
    lastBb = 0;
  const allHoursArr = Array.from(allTs).sort((a, b) => a - b);

  for (const ts of allHoursArr) {
    for (const r of sfBn) {
      if (r.timeMs <= ts) lastBn = r.ratePerHour;
      else break;
    }
    for (const r of sfBb) {
      if (r.timeMs <= ts) lastBb = r.ratePerHour;
      else break;
    }
    bnByHour[ts] = lastBn;
    bbByHour[ts] = lastBb;
  }

  for (const ts of allHoursArr) {
    const bn = bnByHour[ts] ?? 0;
    const bb = bbByHour[ts] ?? 0;
    // Pick the most extreme rate (largest absolute value) — not the highest algebraic.
    // When Bybit has -1029% and Binance has 0%, the squeeze is on Bybit and we want -1029%.
    // When Binance has +150% and Bybit has 0%, the crowded longs are on Binance and we want +150%.
    if (Math.abs(bb) >= Math.abs(bn)) {
      merged[ts] = bb;
      source[ts] = "bybit";
    } else {
      merged[ts] = bn;
      source[ts] = "binance";
    }
  }

  return { merged, source };
}

function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function detectPumpTop(
  candles: Candle[], // chronological 1h candles
  fundingNow: number, // per-hour rate at this hour
  config: Config,
): {
  triggered: boolean;
  candlePumpPct: number;
  volumeMultiple: number;
  rsi: number;
  fundingApr: number;
} {
  const result = {
    triggered: false,
    candlePumpPct: 0,
    volumeMultiple: 0,
    rsi: 0,
    fundingApr: 0,
  };
  if (candles.length < 50) return result;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Candle pump % — high of this candle vs close of previous
  const candlePumpPct = ((last.h - prev.c) / prev.c) * 100;

  // Volume multiple — this candle's volume vs 48h average
  const avgVol = avgArr(candles.slice(-49, -1).map((c) => c.v));
  const volumeMultiple = avgVol > 0 ? last.v / avgVol : 0;

  // RSI on last 15 closes
  const closes = candles.slice(-16).map((c) => c.c);
  const rsi = computeRSI(closes, 14);

  // Funding APR at this moment
  const fundingApr = fundingNow * 8760 * 100;

  result.candlePumpPct = candlePumpPct;
  result.volumeMultiple = volumeMultiple;
  result.rsi = rsi;
  result.fundingApr = fundingApr;
  result.triggered =
    candlePumpPct >= config.pumpMinPct &&
    volumeMultiple >= config.pumpMinVolMult &&
    rsi >= config.pumpMinRsi &&
    fundingApr >= config.pumpMinFundingApr;

  return result;
}

function detectShortSqueeze(
  candleWindow: Candle[],
  oiSeriesArr: number[],
  fundingNow: number,
  config: Config,
  waveHours: number = 0,
  waveHighPrice: number = 0,
  exhaustMaxFunding: number = -20,
): {
  triggered: boolean;
  phase: "BUILDING" | "EXHAUSTION" | null;
  cumulativePct: number;
  oiDropPct: number;
  fundingApr: number;
} {
  const none = {
    triggered: false,
    phase: null as null,
    cumulativePct: 0,
    oiDropPct: 0,
    fundingApr: 0,
  };
  const N = config.squeezeHours;
  if (candleWindow.length < N + 2) return none;

  // Cumulative move: use highest HIGH in window vs close N hours ago
  // Catches multi-candle grind-up (not just close-to-close)
  const startClose = candleWindow[candleWindow.length - N - 1].c;
  const windowHigh = Math.max(...candleWindow.slice(-N).map((c) => c.h));
  const nowClose = candleWindow[candleWindow.length - 1].c;
  const cumulativePct =
    startClose > 0 ? ((windowHigh - startClose) / startClose) * 100 : 0;

  // OI drop — computed when squeezeMinOiDrop OR exhaustMinOiDrop > 0
  // (USD OI is unreliable during squeezes because price rise inflates it)
  let oiDropPct = 0;
  if (
    (config.squeezeMinOiDrop > 0 || config.exhaustMinOiDrop > 0) &&
    oiSeriesArr.length >= 2
  ) {
    const oiStart = oiSeriesArr[Math.max(0, oiSeriesArr.length - N - 1)];
    const oiNow = oiSeriesArr[oiSeriesArr.length - 1];
    oiDropPct = oiStart > 0 ? ((oiStart - oiNow) / oiStart) * 100 : 0;
  }

  const fundingApr = fundingNow * 8760 * 100;
  const oiOk =
    config.squeezeMinOiDrop <= 0 || oiDropPct >= config.squeezeMinOiDrop;
  const exhaustOiOk =
    config.exhaustMinOiDrop <= 0 || oiDropPct >= config.exhaustMinOiDrop;

  const isSqueeze =
    cumulativePct >= config.squeezeMinPct &&
    fundingApr <= config.squeezeMaxFundingApr &&
    oiOk;

  const avgCandleMove =
    candleWindow
      .slice(-N)
      .reduce((s, c) => s + Math.abs(((c.c - c.o) / (c.o || 1)) * 100), 0) / N;
  const c1 = candleWindow[candleWindow.length - 1];
  const c2 = candleWindow[candleWindow.length - 2];
  const recentAvg =
    (Math.abs(((c1.c - c1.o) / (c1.o || 1)) * 100) +
      Math.abs(((c2.c - c2.o) / (c2.o || 1)) * 100)) /
    2;
  const lowerHigh =
    candleWindow.length >= 3 &&
    candleWindow[candleWindow.length - 1].h <
      candleWindow[candleWindow.length - 3].h;

  // Exhaustion requires funding to be genuinely normalised (> exhaustMaxFunding).
  // Using a tighter threshold than building (-20% vs -100%) to avoid false exhaustion
  // when funding oscillates between deep-negative and moderately-negative during squeezes.
  const isExhausting =
    cumulativePct >= config.squeezeMinPct * 0.8 &&
    fundingApr > exhaustMaxFunding && // must be above -20% (genuinely normalised)
    fundingApr < 5 && // not yet strongly positive
    recentAvg < avgCandleMove * 0.5 &&
    lowerHigh &&
    exhaustOiOk; // OI must have dropped if --exhaust-oi-drop > 0

  if (isSqueeze)
    return {
      triggered: true,
      phase: "BUILDING",
      cumulativePct,
      oiDropPct,
      fundingApr,
    };
  if (isExhausting)
    return {
      triggered: true,
      phase: "EXHAUSTION",
      cumulativePct,
      oiDropPct,
      fundingApr,
    };
  return {
    triggered: false,
    phase: null,
    cumulativePct,
    oiDropPct,
    fundingApr,
  };
}

function isTrending(priceSeries: number[], config: Config): boolean {
  // Returns true when the coin is in a parabolic uptrend.
  // In this regime, all short signals should be suppressed —
  // extreme funding during genuine bull runs does not predict reversals.
  //
  // Uses the rolling priceSeries (max 10 entries, 1h each).
  // To detect 7d and 14d trends we need allHours/priceByHour — this function
  // is called from inside the simulation loop where we pass extra context.
  // For simplicity we use a 6h proxy from the rolling series here.
  // The full trend check uses priceByHour passed directly.
  if (!config.trendFilter) return false;
  if (priceSeries.length < 8) return false;
  const now = priceSeries[priceSeries.length - 1];
  const ago6h = priceSeries[0]; // oldest in rolling 10-entry window ≈ 6-10h ago
  if (ago6h <= 0) return false;
  // Simple proxy: if price is up >15% in the rolling window, treat as trending
  // The real 7d/14d check happens via priceByHour in the loop
  return ((now - ago6h) / ago6h) * 100 > 15;
}

function isTrendingFull(
  ts: number,
  priceByHour: Record<number, number>,
  config: Config,
): boolean {
  if (!config.trendFilter) return false;
  const now = priceByHour[ts];
  if (!now) return false;
  const ago7d = priceByHour[ts - 7 * 24 * 3600_000];
  const ago14d = priceByHour[ts - 14 * 24 * 3600_000];
  const rise7d = ago7d > 0 ? ((now - ago7d) / ago7d) * 100 : 0;
  const rise14d = ago14d > 0 ? ((now - ago14d) / ago14d) * 100 : 0;
  return rise7d >= config.trendDays7Pct && rise14d >= config.trendDays14Pct;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate logic (1h resolution)
// ─────────────────────────────────────────────────────────────────────────────

function gate1Passes(fundingSeries: number[], config: Config): boolean {
  if (fundingSeries.length < 8) return false;
  const last8 = fundingSeries.slice(-8);
  const apr = last8[last8.length - 1] * 8760 * 100;
  const positive = last8.filter((r) => r > 0).length;
  return (
    apr > config.fundingAprThreshold && positive >= config.minPositiveReadings
  );
}

function gate2Passes(
  oiSeries: number[],
  priceSeries: number[],
  config: Config,
): boolean {
  if (oiSeries.length < 6 || priceSeries.length < 5) return false;
  const oiNow = avgArr(oiSeries.slice(-2)),
    oi4h = avgArr(oiSeries.slice(-5, -3));
  if (oi4h === 0) return false;
  const px4h = priceSeries[priceSeries.length - 5],
    pxNow = priceSeries[priceSeries.length - 1];
  if (px4h === 0) return false;
  return (
    ((oiNow - oi4h) / oi4h) * 100 > config.minOiChangePct &&
    Math.abs(((pxNow - px4h) / px4h) * 100) < config.maxPriceChangePct
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation engine
// ─────────────────────────────────────────────────────────────────────────────

async function backtestCoin(coin: string, config: Config): Promise<CoinResult> {
  const symbol = `${coin}USDT`;
  const nowMs = Date.now();
  const startMs = nowMs - config.days * 24 * 3600_000;
  // Binance openInterestHist only retains the latest 30 days regardless of period requested
  // Cap the fetch window accordingly
  // OI history: Binance hard limit is 30 days regardless of requested window
  const oiFetchFrom = nowMs - 30 * 24 * 3600_000;
  // Price + funding use the full requested window (--days)
  const fetchFrom = startMs - 8 * 3600_000;

  let candles: Candle[] = [],
    funding: FundingRecord[] = [],
    oi: OIRecord[] = [];
  let bybitFunding: FundingRecord[] = [];

  // ── Fixture support: load from saved data or fetch live ──────────────────
  const fixtureDir = config.useFixtures ?? config.saveFixtures;
  const fixturePath = fixtureDir ? `${fixtureDir}/${coin}.json` : null;
  const { mkdirSync, existsSync: fsExists } = require("fs");

  if (config.useFixtures && fixturePath && fsExists(fixturePath)) {
    // Load from fixture
    const fx = JSON.parse(require("fs").readFileSync(fixturePath, "utf8")) as {
      candles: Candle[];
      fundingBinance: FundingRecord[];
      fundingBybit: FundingRecord[];
      oi: OIRecord[];
      capturedAt: string;
    };
    candles = fx.candles;
    funding = fx.fundingBinance;
    bybitFunding = fx.fundingBybit;
    oi = fx.oi;
    console.log(`  Fetching price data... ${candles.length} bars`);
    console.log(
      `  Fetching funding history (Binance)... ${funding.length} records`,
    );
    console.log(
      `  Fetching funding history (Bybit)... ${bybitFunding.length} records`,
    );
    console.log(`  Fetching OI history... ${oi.length} records`);
    console.log(
      `  [FIXTURE] Loaded from ${fixturePath} (captured ${fx.capturedAt})`,
    );
  } else {
    // Fetch live
    try {
      process.stdout.write(`  Fetching price data...`);
      candles = await fetchKlines(symbol, fetchFrom, nowMs);
      console.log(` ${candles.length} bars`);
    } catch (e: unknown) {
      console.log(
        `\n  ❌ Price (klines) fetch failed: ${e instanceof Error ? e.message : e}`,
      );
      console.log(`     This coin may have been listed recently or delisted.`);
    }

    try {
      process.stdout.write(`  Fetching funding history (Binance)...`);
      funding = await fetchFundingHistory(symbol, fetchFrom, nowMs);
      console.log(` ${funding.length} records`);
    } catch (e: unknown) {
      console.log(
        `\n  ❌ Binance funding fetch failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    // Also fetch Bybit funding — use whichever exchange had higher rate at each hour
    try {
      process.stdout.write(`  Fetching funding history (Bybit)...`);
      bybitFunding = await fetchBybitFundingHistory(symbol, fetchFrom, nowMs);
      console.log(` ${bybitFunding.length} records`);
    } catch (e: unknown) {
      console.log(` unavailable (${e instanceof Error ? e.message : e})`);
    }
  }

  // priceByHour/volumeByHour/highByHour — needed for Bybit OI conversion and pump detection
  const priceByHour: Record<number, number> = {};
  const volumeByHour: Record<number, number> = {};
  const highByHour: Record<number, number> = {};
  for (const c of candles) {
    const h = floorH(c.t);
    priceByHour[h] = c.c;
    volumeByHour[h] = c.v;
    highByHour[h] = c.h;
  }

  let gate2Available = true;
  if (!config.useFixtures || !oi.length) {
    // Only fetch OI if we didn't load it from a fixture
    try {
      process.stdout.write(`  Fetching OI history (Binance)...`);
      oi = await fetchOIHistory(symbol, oiFetchFrom, nowMs);
      console.log(` ${oi.length} records`);
    } catch (_e: unknown) {
      process.stdout.write(`  Binance OI unavailable — trying Bybit...`);
      try {
        const raw = await fetchBybitOIHistory(symbol, oiFetchFrom, nowMs);
        oi = applyPriceToBybitOI(raw, priceByHour);
        if (!oi.length) throw new Error("no USD-convertible OI records");
        console.log(` ${oi.length} records (Bybit)`);
      } catch (e2: unknown) {
        gate2Available = false;
        const msg = e2 instanceof Error ? e2.message : String(e2);
        console.log(
          `\n  ⚠️  OI history unavailable on Binance and Bybit for ${coin} (${msg}).`,
        );
        console.log(
          `     Falling back to Gate 1 only — signals will be FUNDING_ONLY.`,
        );
      }
    }
  }

  if (!candles.length) {
    console.log(`  ⚠️  No price data returned for ${coin}. Try --days 30.`);
  }
  if (!funding.length) {
    console.log(`  ⚠️  No funding history returned for ${coin}.`);
  }

  // Save fixture if requested
  if (config.saveFixtures && fixturePath && candles.length) {
    mkdirSync(config.saveFixtures, { recursive: true });
    writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          coin,
          capturedAt: new Date().toISOString(),
          days: config.days,
          candles,
          fundingBinance: funding,
          fundingBybit: bybitFunding,
          oi,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`  [FIXTURE] Saved → ${fixturePath}`);
  }

  // Merge Binance and Bybit funding — use whichever exchange had higher rate each hour
  const { merged: rawFundingByHour, source: fundingSource } =
    mergeToHighestFunding(funding, bybitFunding);

  // Fill any gaps in the merged map with 0
  for (let ts = floorH(fetchFrom); ts <= nowMs; ts += 3_600_000) {
    if (rawFundingByHour[ts] === undefined) rawFundingByHour[ts] = 0;
  }

  // Log which exchange dominated funding
  const bybitSlots = Object.values(fundingSource).filter(
    (s) => s === "bybit",
  ).length;
  const totalSlots = Object.keys(fundingSource).length;
  if (bybitFunding.length && totalSlots > 0) {
    const bybitPct = Math.round((bybitSlots / totalSlots) * 100);
    console.log(
      `  Funding source: Bybit higher in ${bybitPct}% of hours, Binance in ${100 - bybitPct}%`,
    );
  }

  const oiByHour: Record<number, number> = {};
  for (const o of oi) oiByHour[floorH(o.timeMs)] = o.oiUsd;

  // Diagnostics — track why signals didn't fire
  let maxAprSeen = 0;
  let maxAprPositive = 0;
  let gate1PassCount = 0;
  let gate2FailOI = 0;
  let gate2FailPX = 0;

  const fSeries: number[] = [],
    oiSeries: number[] = [],
    pSeries: number[] = [];
  const signals: Signal[] = [];
  const pumpSignals: PumpSignal[] = [];
  const sigSet = new Set<string>();
  const pumpSigSet = new Set<string>();
  const COOL = 4 * 3600_000;
  const allHours = Object.keys(priceByHour)
    .map(Number)
    .sort((a, b) => a - b);
  const candleWindow: Candle[] = []; // rolling window of candles for pump detection
  let maxPumpCandlePct = 0,
    maxPumpCandleAt = "",
    maxPumpVolMult = 0,
    maxPumpRsi = 0,
    maxPumpFunding = 0;
  const squeezeSignals: SqueezeSignal[] = [];
  const squeezeSigSet = new Set<string>();
  let lastSqueezePhase: "BUILDING" | "EXHAUSTION" | "TREND_BREAK" | null = null;
  let lastBuildingMinFunding = 0; // most negative funding during last BUILDING phase
  let squeezeWaveStartMs: number | null = null;
  let squeezeWaveHighPrice: number = 0;
  let lastBuildingSignalMs: number | null = null; // when last BUILDING signal was pushed

  let maxSqueezeCumul = 0,
    maxSqueezeCumulAt = "",
    maxSqueezeFunding = 0;
  let trendingHours = 0;

  for (const ts of allHours) {
    const price = priceByHour[ts];
    if (!price) continue;
    const fRate = rawFundingByHour[ts] ?? 0;
    fSeries.push(fRate);
    oiSeries.push(oiByHour[ts] ?? oiSeries[oiSeries.length - 1] ?? 0);
    pSeries.push(price);
    if (fSeries.length > 10) fSeries.shift();
    if (oiSeries.length > 10) oiSeries.shift();
    if (pSeries.length > 10) pSeries.shift();

    // Use real candle high and volume from Binance klines
    const prevPrice = pSeries.length > 1 ? pSeries[pSeries.length - 2] : price;
    const candleHigh = highByHour[ts] ?? Math.max(price, prevPrice);
    const candleVol = volumeByHour[ts] ?? 1;
    candleWindow.push({
      t: ts,
      o: prevPrice,
      h: candleHigh,
      l: Math.min(price, prevPrice),
      c: price,
      v: candleVol,
    });
    if (candleWindow.length > 60) candleWindow.shift();

    if (ts < startMs) continue;

    const apr = (fSeries[fSeries.length - 1] ?? 0) * 8760 * 100;
    if (apr > maxAprSeen) {
      maxAprSeen = apr;
      maxAprPositive = fSeries.slice(-8).filter((r) => r > 0).length;
    }

    // ── Pump top detection — runs independently of funding gates ──────────────
    if (candleWindow.length >= 50) {
      const pump = detectPumpTop(candleWindow, fRate, config);
      // Track peak values for diagnostic output
      if (pump.candlePumpPct > maxPumpCandlePct) {
        maxPumpCandlePct = pump.candlePumpPct;
        maxPumpCandleAt = fmtDate(ts);
        maxPumpVolMult = pump.volumeMultiple;
        maxPumpRsi = pump.rsi;
        maxPumpFunding = pump.fundingApr;
      }
      if (pump.triggered) {
        const pumpKey = `pump:${coin}:${Math.floor(ts / COOL)}`;
        if (!pumpSigSet.has(pumpKey)) {
          pumpSigSet.add(pumpKey);
          pumpSignals.push({
            coin,
            firedAtMs: ts,
            firedAtStr: fmtDate(ts),
            entryPrice: price,
            candlePumpPct: Math.round(pump.candlePumpPct * 10) / 10,
            volumeMultiple: Math.round(pump.volumeMultiple * 10) / 10,
            rsi: Math.round(pump.rsi),
            fundingApr: Math.round(pump.fundingApr * 10) / 10,
          });
        }
      }
    }

    // ── Trend filter — suppress most short signals during parabolic uptrends ───
    const trending = isTrendingFull(ts, priceByHour, config);
    if (trending) trendingHours++;

    // ── Short squeeze detection — runs always; trend filter controls phase ────
    if (candleWindow.length >= config.squeezeHours + 2) {
      const waveHours = squeezeWaveStartMs
        ? (ts - squeezeWaveStartMs) / 3_600_000
        : 0;
      const waveHighPrice = squeezeWaveHighPrice || price;
      const sq = detectShortSqueeze(
        candleWindow,
        [...oiSeries],
        fRate,
        config,
        waveHours,
        waveHighPrice,
        config.exhaustMaxFundingApr,
      );
      if (sq.cumulativePct > maxSqueezeCumul) {
        maxSqueezeCumul = sq.cumulativePct;
        maxSqueezeCumulAt = fmtDate(ts);
        maxSqueezeFunding = sq.fundingApr;
      }

      if (sq.triggered && sq.phase) {
        const isTrendBreak =
          trending &&
          sq.phase === "EXHAUSTION" &&
          lastBuildingMinFunding <= config.trendBreakFundingApr;

        const isMegaSqueezeExhaustion =
          sq.phase === "EXHAUSTION" &&
          config.megaSqueezeHours > 0 &&
          waveHours >= config.megaSqueezeHours;

        const allowNormal =
          !trending &&
          (sq.phase === "BUILDING" ||
            (sq.phase === "EXHAUSTION" && !isMegaSqueezeExhaustion));

        if (isTrendBreak || allowNormal) {
          const phase: "BUILDING" | "EXHAUSTION" | "TREND_BREAK" = isTrendBreak
            ? "TREND_BREAK"
            : sq.phase;
          const sqKey = `sq:${coin}:${phase}:${Math.floor(ts / COOL)}`;
          if (!squeezeSigSet.has(sqKey)) {
            squeezeSigSet.add(sqKey);
            squeezeSignals.push({
              coin,
              firedAtMs: ts,
              firedAtStr: fmtDate(ts),
              entryPrice: price,
              cumulativePct: Math.round(sq.cumulativePct * 10) / 10,
              squeezeHours: config.squeezeHours,
              oiDropPct: Math.round(sq.oiDropPct * 10) / 10,
              fundingApr: Math.round(sq.fundingApr * 10) / 10,
              signalPhase: phase,
              trendBreak: isTrendBreak,
              msSinceBuilding:
                phase === "EXHAUSTION"
                  ? lastBuildingSignalMs !== null
                    ? ts - lastBuildingSignalMs
                    : null
                  : null,
            });
            if (phase === "BUILDING") lastBuildingSignalMs = ts;
          }
        }

        // Track wave start time and high price
        if (sq.phase === "BUILDING") {
          if (squeezeWaveStartMs === null) squeezeWaveStartMs = ts;
          if (sq.fundingApr < lastBuildingMinFunding)
            lastBuildingMinFunding = sq.fundingApr;
        }
        if (squeezeWaveStartMs !== null && price > squeezeWaveHighPrice) {
          squeezeWaveHighPrice = price;
        }

        if (!isTrendBreak) lastSqueezePhase = sq.phase;
        else lastSqueezePhase = "TREND_BREAK";
      } else if (!sq.triggered) {
        squeezeWaveStartMs = null;
        squeezeWaveHighPrice = 0;
        // Note: lastBuildingMinFunding intentionally NOT reset here so TREND_BREAK
        // can still fire post-peak when exhaustion conditions are met after the squeeze
        if (lastSqueezePhase === "BUILDING") lastSqueezePhase = null;
      }
    }

    // ── Funding strategy gates ─────────────────────────────────────────────────
    if (trending) continue; // trend filter also blocks funding signals
    if (!gate1Passes(fSeries, config)) continue;
    gate1PassCount++;

    if (gate2Available && oiSeries.length >= 6 && pSeries.length >= 5) {
      const oiNowD = avgArr(oiSeries.slice(-2)),
        oi4hD = avgArr(oiSeries.slice(-5, -3));
      const px4hD = pSeries[pSeries.length - 5],
        pxNowD = pSeries[pSeries.length - 1];
      const oiChg = oi4hD > 0 ? ((oiNowD - oi4hD) / oi4hD) * 100 : 0;
      const pxChg = px4hD > 0 ? Math.abs(((pxNowD - px4hD) / px4hD) * 100) : 0;
      if (oiChg <= config.minOiChangePct) gate2FailOI++;
      if (pxChg >= config.maxPriceChangePct) gate2FailPX++;
    }

    if (!gate2Passes(oiSeries, pSeries, config)) continue;
    const key = `${coin}:${Math.floor(ts / COOL)}`;
    if (sigSet.has(key)) continue;
    sigSet.add(key);
    const oiNow = avgArr(oiSeries.slice(-2)),
      oi4h = avgArr(oiSeries.slice(-5, -3));
    const px4h = pSeries[pSeries.length - 5] ?? price;
    signals.push({
      coin,
      firedAtMs: ts,
      firedAtStr: fmtDate(ts),
      entryPrice: price,
      fundingApr: Math.round(fSeries[fSeries.length - 1] * 8760 * 10000) / 100,
      oiChangePct: Math.round(((oiNow - oi4h) / oi4h) * 10000) / 100,
      priceChangePct: Math.round(Math.abs((price - px4h) / px4h) * 10000) / 100,
      signalType: "FUNDING" as const,
    });
  }

  // Always show pump detection diagnostics
  // Squeeze diagnostic — always show when no squeeze signals fired
  if (!squeezeSignals.length) {
    console.log(`
  ── Squeeze detection diagnostics for ${coin} ──`);
    console.log(
      `  Max cumulative move seen: +${maxSqueezeCumul.toFixed(1)}% at ${maxSqueezeCumulAt || "—"}`,
    );
    console.log(
      `  Funding at that point:    ${maxSqueezeFunding.toFixed(1)}% APR (needs <${config.squeezeMaxFundingApr}%)`,
    );
    const sqBlockers: string[] = [];
    if (maxSqueezeCumul < config.squeezeMinPct)
      sqBlockers.push(
        `cumulative too small (+${maxSqueezeCumul.toFixed(1)}% < ${config.squeezeMinPct}%)`,
      );
    if (maxSqueezeFunding > config.squeezeMaxFundingApr)
      sqBlockers.push(
        `funding not negative enough (${maxSqueezeFunding.toFixed(1)}% > ${config.squeezeMaxFundingApr}%)`,
      );
    if (sqBlockers.length) {
      console.log(`  Blocked by: ${sqBlockers.join(", ")}`);
    } else if (maxSqueezeCumul > 0) {
      console.log(
        `  → Conditions may have been met — check if squeeze happened inside the 30-day OI window`,
      );
    }
  }

  if (!pumpSignals.length && maxPumpCandlePct > 5) {
    console.log(`\n  ── Pump detection diagnostics for ${coin} ──`);
    console.log(
      `  Biggest candle move: +${maxPumpCandlePct.toFixed(1)}% at ${maxPumpCandleAt}`,
    );
    console.log(
      `  Volume at that hour: ×${maxPumpVolMult.toFixed(1)} (needs ×${config.pumpMinVolMult})`,
    );
    console.log(
      `  RSI at that hour:    ${maxPumpRsi.toFixed(0)} (needs >${config.pumpMinRsi})`,
    );
    console.log(
      `  Funding at trigger:  ${maxPumpFunding.toFixed(1)}% APR (needs >${config.pumpMinFundingApr}%)`,
    );
    const blockers = [];
    if (maxPumpCandlePct < config.pumpMinPct)
      blockers.push(
        `candle too small (${maxPumpCandlePct.toFixed(1)}% < ${config.pumpMinPct}%)`,
      );
    if (maxPumpVolMult < config.pumpMinVolMult)
      blockers.push(
        `volume too low (×${maxPumpVolMult.toFixed(1)} < ×${config.pumpMinVolMult})`,
      );
    if (maxPumpRsi < config.pumpMinRsi)
      blockers.push(
        `RSI too low (${maxPumpRsi.toFixed(0)} < ${config.pumpMinRsi})`,
      );
    if (maxPumpFunding < config.pumpMinFundingApr)
      blockers.push(
        `funding too low (${maxPumpFunding.toFixed(1)}% < ${config.pumpMinFundingApr}%)`,
      );
    if (blockers.length) console.log(`  Blocked by: ${blockers.join(", ")}`);
  }

  if (trendingHours > 0) {
    const trendPct = Math.round(
      (trendingHours / allHours.filter((t) => t >= startMs).length) * 100,
    );
    console.log(`\n  ── Trend filter for ${coin} ──`);
    console.log(
      `  Hours suppressed by trend filter: ${trendingHours} (${trendPct}% of period)`,
    );
    console.log(
      `  Signals blocked because coin was in parabolic uptrend (+${config.trendDays7Pct}%/7d AND +${config.trendDays14Pct}%/14d).`,
    );
    if (!signals.length && !squeezeSignals.length && !pumpSignals.length) {
      console.log(
        `  → To disable: add --no-trend-filter (caution: many false signals in trends)`,
      );
    }
  }

  if (!signals.length) {
    console.log(`\n  ── Gate diagnostics for ${coin} ──`);
    console.log(
      `  Max funding APR seen:   ${maxAprSeen.toFixed(2)}%  (Gate 1 needs >${config.fundingAprThreshold}%)`,
    );

    if (maxAprSeen < config.fundingAprThreshold) {
      console.log(
        `  Gate 1 never passed:    funding never reached the threshold`,
      );
      const suggest = Math.max(1, Math.floor(maxAprSeen * 0.7));
      console.log(
        `  → Try --threshold ${suggest} to see when funding was elevated`,
      );
    } else if (gate1PassCount === 0) {
      // APR crossed threshold but positivity check blocked it
      console.log(
        `  Gate 1 blocked:         APR hit ${maxAprSeen.toFixed(2)}% but positivity check failed`,
      );
      console.log(
        `  Positive readings at peak APR: ${maxAprPositive}/8  (Gate 1 needs >=${config.minPositiveReadings})`,
      );
      console.log(
        `  → Funding spiked suddenly — not a sustained crowded-long setup`,
      );
      console.log(
        `  → This is a flash pump pattern, not the strategy's core target`,
      );
      console.log(`  → To catch it anyway: --min-positive ${maxAprPositive}`);
      console.log(
        `  → Or: --min-positive 1 to capture any hour where APR crossed threshold`,
      );
    } else {
      // Gate 1 passed but Gate 2 blocked everything
      console.log(`  Gate 1 passed:          ${gate1PassCount} hours`);
      if (gate2Available) {
        console.log(`  Gate 2 OI too flat:     ${gate2FailOI} hours`);
        console.log(`  Gate 2 price moved:     ${gate2FailPX} hours`);
        if (gate2FailOI > gate2FailPX) {
          console.log(
            `  → OI wasn't diverging when funding was elevated — try --min-oi 2`,
          );
        } else if (gate2FailPX > 0) {
          console.log(
            `  → Price moved too much alongside funding — try --max-price 2`,
          );
        }
      } else {
        console.log(`  Gate 2: skipped (no OI data)`);
        console.log(
          `  → Gate 1 passed ${gate1PassCount} hours but Gate 2 is unavailable`,
        );
      }
    }
  }

  const outcomes: Outcome[] = [];
  for (const sig of signals) {
    const fwdEnd = sig.firedAtMs + config.lookaheadHours * 3600_000;
    let maxP = sig.entryPrice,
      minP = sig.entryPrice,
      finalP = sig.entryPrice;
    for (const ts of allHours.filter((t) => t > sig.firedAtMs && t <= fwdEnd)) {
      const p = priceByHour[ts];
      if (!p) continue;
      if (p > maxP) maxP = p;
      if (p < minP) minP = p;
      finalP = p;
    }
    const maxPct = ((maxP - sig.entryPrice) / sig.entryPrice) * 100;
    const minPct = ((minP - sig.entryPrice) / sig.entryPrice) * 100;
    const finalPct = ((finalP - sig.entryPrice) / sig.entryPrice) * 100;
    const verdict =
      maxPct > 2 && finalPct < -3
        ? "PUMP+DUMP"
        : finalPct < -3
          ? "DROPPED"
          : finalPct > 3
            ? "SQUEEZED"
            : "NEUTRAL";
    outcomes.push({
      signal: sig,
      signalType: "FUNDING",
      maxPricePct: maxPct,
      minPricePct: minPct,
      finalPricePct: finalPct,
      verdict,
    });
  }

  // Pump signal outcomes
  const pumpOutcomes: Outcome[] = [];
  for (const sig of pumpSignals) {
    const fwdEnd = sig.firedAtMs + config.lookaheadHours * 3600_000;
    let maxP = sig.entryPrice,
      minP = sig.entryPrice,
      finalP = sig.entryPrice;
    for (const ts of allHours.filter((t) => t > sig.firedAtMs && t <= fwdEnd)) {
      const p = priceByHour[ts];
      if (!p) continue;
      if (p > maxP) maxP = p;
      if (p < minP) minP = p;
      finalP = p;
    }
    const maxPct = ((maxP - sig.entryPrice) / sig.entryPrice) * 100;
    const minPct = ((minP - sig.entryPrice) / sig.entryPrice) * 100;
    const finalPct = ((finalP - sig.entryPrice) / sig.entryPrice) * 100;
    // For pump top: a good outcome is price DROPPING (short was right)
    const verdict =
      maxPct > 2 && finalPct < -3
        ? "PUMP+DUMP"
        : finalPct < -3
          ? "DROPPED"
          : finalPct > 3
            ? "SQUEEZED"
            : "NEUTRAL";
    pumpOutcomes.push({
      signal: sig,
      signalType: "PUMP_TOP",
      maxPricePct: maxPct,
      minPricePct: minPct,
      finalPricePct: finalPct,
      verdict,
    });
  }

  const squeezeOutcomes: Outcome[] = [];
  for (const sig of squeezeSignals) {
    const fwdEnd = sig.firedAtMs + config.lookaheadHours * 3600_000;
    let maxP = sig.entryPrice,
      minP = sig.entryPrice,
      finalP = sig.entryPrice;
    for (const ts of allHours.filter((t) => t > sig.firedAtMs && t <= fwdEnd)) {
      const p = priceByHour[ts];
      if (!p) continue;
      if (p > maxP) maxP = p;
      if (p < minP) minP = p;
      finalP = p;
    }
    const maxPct = ((maxP - sig.entryPrice) / sig.entryPrice) * 100;
    const minPct = ((minP - sig.entryPrice) / sig.entryPrice) * 100;
    const finalPct = ((finalP - sig.entryPrice) / sig.entryPrice) * 100;
    const verdict =
      maxPct > 2 && finalPct < -3
        ? "PUMP+DUMP"
        : finalPct < -3
          ? "DROPPED"
          : finalPct > 3
            ? "SQUEEZED"
            : "NEUTRAL";
    squeezeOutcomes.push({
      signal: sig as unknown as Signal,
      signalType: "SQUEEZE",
      maxPricePct: maxPct,
      minPricePct: minPct,
      finalPricePct: finalPct,
      verdict,
    });
  }

  const fundingAprByHour: Record<number, number> = {};
  for (const [ts, r] of Object.entries(rawFundingByHour))
    fundingAprByHour[Number(ts)] = r * 8760 * 100;

  const bybitFundingPct =
    Object.keys(fundingSource).length > 0
      ? Math.round(
          (Object.values(fundingSource).filter((s) => s === "bybit").length /
            Object.keys(fundingSource).length) *
            100,
        )
      : 0;

  return {
    coin,
    outcomes,
    pumpOutcomes,
    squeezeOutcomes,
    allHours,
    priceByHour,
    fundingAprByHour,
    oiByHour,
    startMs,
    gate2Available,
    bybitFundingPct,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Console report
// ─────────────────────────────────────────────────────────────────────────────

function printReport(results: CoinResult[], config: Config): void {
  for (const result of results) {
    const { coin, outcomes } = result;
    if (!outcomes.length) continue;
    const dropped = outcomes.filter((o) => o.verdict === "DROPPED").length;
    const pumpDump = outcomes.filter((o) => o.verdict === "PUMP+DUMP").length;
    const squeezed = outcomes.filter((o) => o.verdict === "SQUEEZED").length;
    const neutral = outcomes.filter((o) => o.verdict === "NEUTRAL").length;
    const winRate = (((dropped + pumpDump) / outcomes.length) * 100).toFixed(0);
    const gateMode = result.gate2Available
      ? "Gate 1 + Gate 2"
      : "Gate 1 only (no OI data)";
    const fundingNote =
      result.bybitFundingPct > 50
        ? `Bybit had higher funding in ${result.bybitFundingPct}% of hours — key signal source`
        : result.bybitFundingPct > 0
          ? `Bybit had higher funding in ${result.bybitFundingPct}% of hours`
          : "Binance was funding source throughout";

    console.log(`\n${"═".repeat(62)}`);
    console.log(
      `  ${coin} — ${config.days}d backtest | ${config.lookaheadHours}h lookahead`,
    );
    console.log(`  Mode: ${gateMode}`);
    console.log(`  Funding: ${fundingNote}`);
    console.log(`${"═".repeat(62)}`);
    console.log(`  Signals fired:       ${outcomes.length}`);
    console.log(`  Win rate:            ${winRate}%  (dropped + pump+dump)`);
    console.log(`  Dropped cleanly:     ${dropped}`);
    console.log(
      `  Pump then dump:      ${pumpDump}  ← classic crowded-long unwind`,
    );
    console.log(`  Squeezed (bad):      ${squeezed}`);
    console.log(`  Neutral:             ${neutral}`);
    console.log(
      `  Avg final (${config.lookaheadHours}h):    ${s(avgArr(outcomes.map((o) => o.finalPricePct)))}%`,
    );
    console.log(
      `  Avg max pump:        ${s(avgArr(outcomes.map((o) => o.maxPricePct)))}%`,
    );
    console.log(
      `  Avg max drop:        ${s(avgArr(outcomes.map((o) => o.minPricePct)))}%`,
    );
    console.log();
    for (const o of outcomes) {
      const icon = ["DROPPED", "PUMP+DUMP"].includes(o.verdict)
        ? "✅"
        : o.verdict === "SQUEEZED"
          ? "❌"
          : "😐";
      const fSig = o.signal as Signal;
      console.log(
        `  ${icon} ${o.signal.firedAtStr}  entry=$${o.signal.entryPrice.toFixed(4)}  funding=${o.signal.fundingApr.toFixed(1)}%APR  OI+${fSig.oiChangePct.toFixed(1)}%`,
      );
      console.log(
        `      max:${s(o.maxPricePct)}%  min:${s(o.minPricePct)}%  final:${s(o.finalPricePct)}%  → ${o.verdict}`,
      );
    }
  }
  // ── Pump top results ────────────────────────────────────────────────────────
  const allPumpOutcomes = results.flatMap((r) => r.pumpOutcomes);
  if (allPumpOutcomes.length) {
    for (const result of results) {
      const { coin, pumpOutcomes } = result;
      if (!pumpOutcomes.length) continue;
      const dropped = pumpOutcomes.filter(
        (o) => o.verdict === "DROPPED",
      ).length;
      const pumpDump = pumpOutcomes.filter(
        (o) => o.verdict === "PUMP+DUMP",
      ).length;
      const squeezed = pumpOutcomes.filter(
        (o) => o.verdict === "SQUEEZED",
      ).length;
      const winRate = (
        ((dropped + pumpDump) / pumpOutcomes.length) *
        100
      ).toFixed(0);

      console.log(`
${"─".repeat(62)}`);
      console.log(
        `  ${coin} — PUMP TOP signals | ${pumpOutcomes.length} fired`,
      );
      console.log(`${"─".repeat(62)}`);
      console.log(`  Win rate:   ${winRate}%  (dropped + pump+dump)`);
      console.log(
        `  Dropped:    ${dropped}  Pump+dump: ${pumpDump}  Squeezed: ${squeezed}  Neutral: ${pumpOutcomes.length - dropped - pumpDump - squeezed}`,
      );
      console.log();

      for (const o of pumpOutcomes) {
        const sig = o.signal as PumpSignal;
        const icon = ["DROPPED", "PUMP+DUMP"].includes(o.verdict)
          ? "✅"
          : o.verdict === "SQUEEZED"
            ? "❌"
            : "😐";
        console.log(
          `  ${icon} ${sig.firedAtStr}  entry=$${(sig.entryPrice ?? 0).toFixed(4)}  pump+${sig.candlePumpPct.toFixed(1)}%  vol×${sig.volumeMultiple.toFixed(0)}  RSI:${sig.rsi}  funding:${(sig.fundingApr ?? 0).toFixed(1)}%APR`,
        );
        console.log(
          `      max:${s(o.maxPricePct)}%  min:${s(o.minPricePct)}%  final:${s(o.finalPricePct)}%  → ${o.verdict}`,
        );
      }
    }
  }

  // ── Short squeeze results ───────────────────────────────────────────────────
  for (const result of results) {
    const sq = result.squeezeOutcomes;
    if (!sq.length) continue;
    const building = sq.filter(
      (o: Outcome) =>
        (o.signal as unknown as SqueezeSignal).signalPhase === "BUILDING",
    );
    const exhaustion = sq.filter(
      (o: Outcome) =>
        (o.signal as unknown as SqueezeSignal).signalPhase === "EXHAUSTION",
    );
    const trendBreak = sq.filter(
      (o: Outcome) =>
        (o.signal as unknown as SqueezeSignal).signalPhase === "TREND_BREAK",
    );
    const exWin = exhaustion.filter((o: Outcome) =>
      ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
    ).length;
    const tbWin = trendBreak.filter((o: Outcome) =>
      ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
    ).length;
    console.log("\n" + "─".repeat(62));
    console.log("  " + result.coin + " — SHORT SQUEEZE signals");
    console.log("─".repeat(62));
    console.log(
      "  Building alerts:     " +
        building.length +
        "  (squeeze active — do not short yet)",
    );
    console.log(
      "  Exhaustion signals:  " + exhaustion.length + "  (squeeze ending)",
    );
    console.log(
      "  Trend break signals: " +
        trendBreak.length +
        "  (parabolic blow-off top — strong short entry)",
    );
    if (exhaustion.length) {
      console.log(
        "  Exhaustion win rate: " +
          ((exWin / exhaustion.length) * 100).toFixed(0) +
          "%",
      );
      console.log();
      for (const o of exhaustion) {
        const sig = o.signal as unknown as SqueezeSignal;
        const icon = ["DROPPED", "PUMP+DUMP"].includes(o.verdict)
          ? "✅"
          : o.verdict === "SQUEEZED"
            ? "❌"
            : "😐";
        const msSinceBld = (sig as unknown as SqueezeSignal).msSinceBuilding;
        const bldCtx =
          sig.signalPhase === "EXHAUSTION"
            ? msSinceBld !== null && msSinceBld !== undefined
              ? "  ✅ building " + Math.round(msSinceBld / 3_600_000) + "h ago"
              : "  ⚠️  no prior building"
            : "";
        console.log(
          "  " +
            icon +
            " " +
            sig.firedAtStr +
            "  entry=$" +
            (sig.entryPrice ?? 0).toFixed(4) +
            "  squeeze+" +
            (sig.cumulativePct ?? 0).toFixed(1) +
            "%(" +
            sig.squeezeHours +
            "h)" +
            "  OI-" +
            (sig.oiDropPct ?? 0).toFixed(1) +
            "%  funding:" +
            (sig.fundingApr ?? 0).toFixed(1) +
            "%APR" +
            bldCtx,
        );
        console.log(
          "      max:" +
            s(o.maxPricePct) +
            "%  min:" +
            s(o.minPricePct) +
            "%  final:" +
            s(o.finalPricePct) +
            "%  → " +
            o.verdict +
            (o.maxPricePct > 5
              ? "  ⚠️  went up " + o.maxPricePct.toFixed(1) + "% first"
              : ""),
        );
      }
    }
    if (trendBreak.length) {
      console.log();
      console.log(
        "  TREND BREAK signals (parabolic blow-off + squeeze = trend reversal):",
      );
      console.log(
        "  Win rate: " + ((tbWin / trendBreak.length) * 100).toFixed(0) + "%",
      );
      console.log();
      for (const o of trendBreak) {
        const sig = o.signal as unknown as SqueezeSignal;
        const icon = ["DROPPED", "PUMP+DUMP"].includes(o.verdict)
          ? "✅"
          : o.verdict === "SQUEEZED"
            ? "❌"
            : "😐";
        console.log(
          "  " +
            icon +
            " 🚨 " +
            sig.firedAtStr +
            "  entry=$" +
            (sig.entryPrice ?? 0).toFixed(4) +
            "  squeeze+" +
            (sig.cumulativePct ?? 0).toFixed(1) +
            "%(" +
            sig.squeezeHours +
            "h)" +
            "  prior_funding:" +
            (sig.fundingApr ?? 0).toFixed(1) +
            "%APR",
        );
        console.log(
          "      max:" +
            s(o.maxPricePct) +
            "%  min:" +
            s(o.minPricePct) +
            "%  final:" +
            s(o.finalPricePct) +
            "%  → " +
            o.verdict,
        );
      }
    }
    for (const o of building) {
      const sig = o.signal as unknown as SqueezeSignal;
      console.log(
        "  ⚠️  " +
          sig.firedAtStr +
          "  BUILDING — +" +
          (sig.cumulativePct ?? 0).toFixed(1) +
          "%(" +
          sig.squeezeHours +
          "h)" +
          "  OI-" +
          (sig.oiDropPct ?? 0).toFixed(1) +
          "%  funding:" +
          (sig.fundingApr ?? 0).toFixed(1) +
          "%APR",
      );
      console.log(
        "      Do not short while squeeze active. Await exhaustion signal.",
      );
      console.log(
        "      48h outcome: max:" +
          s(o.maxPricePct) +
          "%  min:" +
          s(o.minPricePct) +
          "%  final:" +
          s(o.finalPricePct) +
          "%  → " +
          o.verdict,
      );
    }
  }

  if (!results.some((r) => r.outcomes.length || r.pumpOutcomes.length)) {
    console.log("\n  No signals fired (funding or pump-top).");
    console.log(
      "  For pump signals: try --pump-pct 15 --pump-vol 5 --pump-rsi 75 --pump-funding 20",
    );
  }

  // Always print pump diagnostic summary if pump signals didn't fire
  for (const result of results) {
    if (!result.pumpOutcomes.length) {
      console.log(`\n  ── Pump detection note for ${result.coin} ──`);
      console.log(`  No pump-top signals fired with current thresholds.`);
      console.log(
        `  Pump params: candle >${config.pumpMinPct}%, vol ×${config.pumpMinVolMult}, RSI >${config.pumpMinRsi}, funding >${config.pumpMinFundingApr}%APR`,
      );
      console.log(
        `  → If a pump happened, check --pump-pct and --pump-vol first.`,
      );
      console.log(
        `  → Volume check requires real Binance kline volume — ensure it loaded correctly.`,
      );
    }
  }
} // end printReport

// ─────────────────────────────────────────────────────────────────────────────
// Chart generation
// ─────────────────────────────────────────────────────────────────────────────

function vColour(v: string): string {
  return v === "DROPPED"
    ? "#22c55e"
    : v === "PUMP+DUMP"
      ? "#f97316"
      : v === "SQUEEZED"
        ? "#ef4444"
        : "#94a3b8";
}

function generateChartHTML(results: CoinResult[], config: Config): string {
  // Collect all chart data into a single JSON blob embedded at page load.
  // All charts created in one window.load handler so CDN scripts are guaranteed ready.
  const chartData = results.map(
    ({
      coin,
      outcomes,
      pumpOutcomes,
      squeezeOutcomes,
      allHours,
      priceByHour,
      fundingAprByHour,
      oiByHour,
      startMs,
      gate2Available,
    }) => {
      const displayHours = allHours.filter((t) => t >= startMs);
      const labels = displayHours.map((t) => fmtDate(t));
      const prices = displayHours.map((t) => priceByHour[t] ?? null);
      const funding = displayHours.map((t) => fundingAprByHour[t] ?? null);
      const oi = displayHours.map((t) => (oiByHour[t] ?? 0) / 1e6);

      const allOutcomes = [...outcomes, ...pumpOutcomes, ...squeezeOutcomes];
      const signals = allOutcomes
        .map((o) => {
          const idx = displayHours.indexOf(o.signal.firedAtMs);
          const endIdx = displayHours.findIndex(
            (t) => t > o.signal.firedAtMs + config.lookaheadHours * 3600_000,
          );
          return {
            idx,
            endIdx: endIdx === -1 ? displayHours.length - 1 : endIdx,
            colour: vColour(o.verdict),
            verdict: o.verdict,
            fundingApr: o.signal.fundingApr,
            entryPrice: o.signal.entryPrice,
            finalPct: o.finalPricePct,
            // Detail window: 48h before + lookahead after signal
            detail: (() => {
              const winStart = o.signal.firedAtMs - 48 * 3600_000;
              const winEnd =
                o.signal.firedAtMs + config.lookaheadHours * 3600_000;
              const win = allHours.filter((t) => t >= winStart && t <= winEnd);
              const isFunding = o.signalType === "FUNDING";
              const isPump = o.signalType === "PUMP_TOP";
              const isSqueeze = o.signalType === "SQUEEZE";
              const pSig = isPump ? (o.signal as PumpSignal) : null;
              const sqSig = isSqueeze
                ? (o.signal as unknown as SqueezeSignal)
                : null;
              return {
                labels: win.map((t) => fmtDate(t)),
                prices: win.map((t) => priceByHour[t] ?? null),
                funding: win.map((t) => fundingAprByHour[t] ?? null),
                sigIdx: win.indexOf(o.signal.firedAtMs),
                verdict: o.verdict,
                colour: vColour(o.verdict),
                signalType: o.signalType,
                signalPhase: sqSig?.signalPhase ?? "",
                entryPrice: o.signal.entryPrice,
                fundingApr: o.signal.fundingApr,
                oiChange: isFunding ? (o.signal as Signal).oiChangePct : 0,
                candlePumpPct: pSig?.candlePumpPct ?? 0,
                volumeMultiple: pSig?.volumeMultiple ?? 0,
                rsi: pSig?.rsi ?? 0,
                cumulativePct: sqSig?.cumulativePct ?? 0,
                squeezeHours: sqSig?.squeezeHours ?? 0,
                squeezeFunding: sqSig?.fundingApr ?? 0,
                maxPct: o.maxPricePct,
                minPct: o.minPricePct,
                finalPct: o.finalPricePct,
                firedAtStr: o.signal.firedAtStr,
              };
            })(),
          };
        })
        .filter((sig) => sig.idx !== -1);

      const winners = outcomes.filter((o) =>
        ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
      ).length;
      const maxFunding = Math.max(
        ...funding.filter((v): v is number => v !== null),
        0,
      );

      return {
        coin,
        labels,
        prices,
        funding,
        oi,
        signals,
        gate2Available,
        outcomeCount: outcomes.length,
        winners,
        squeezed: outcomes.filter((o) => o.verdict === "SQUEEZED").length,
        winRate: outcomes.length
          ? ((winners / outcomes.length) * 100).toFixed(0)
          : null,
        avgFinal: outcomes.length
          ? avgArr(outcomes.map((o) => o.finalPricePct))
          : null,
        maxFunding,
        threshold: config.fundingAprThreshold,
        days: config.days,
        lookaheadHours: config.lookaheadHours,
      };
    },
  );

  const dataJson = JSON.stringify(chartData);

  const coinSections = results
    .map(({ coin, outcomes }) => {
      const winners = outcomes.filter((o) =>
        ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
      ).length;
      return `
<section class="coin-section" id="section-${coin}">
  <h2>${coin} <span class="tag" id="tag-${coin}">${outcomes.length} signal${outcomes.length !== 1 ? "s" : ""}</span></h2>
  <div class="overview-grid">
    <div class="stat-card"><div class="stat-v">${outcomes.length}</div><div class="stat-l">Signals fired</div></div>
    <div class="stat-card green"><div class="stat-v">${winners}</div><div class="stat-l">Winners</div></div>
    <div class="stat-card red"><div class="stat-v">${outcomes.filter((o) => o.verdict === "SQUEEZED").length}</div><div class="stat-l">Squeezed</div></div>
    <div class="stat-card"><div class="stat-v">${outcomes.length ? ((winners / outcomes.length) * 100).toFixed(0) + "%" : "—"}</div><div class="stat-l">Win rate</div></div>
    <div class="stat-card"><div class="stat-v">${outcomes.length ? s(avgArr(outcomes.map((o) => o.finalPricePct))) + "%" : "—"}</div><div class="stat-l">Avg ${config.lookaheadHours}h</div></div>
    <div class="stat-card"><div class="stat-v">${config.fundingAprThreshold}%</div><div class="stat-l">Gate 1 APR</div></div>
  </div>
  ${
    outcomes.length === 0
      ? `<div class="no-signal-banner">
    <strong>No signals fired</strong> — funding APR stayed below ${config.fundingAprThreshold}% for the entire ${config.days}-day window.
    The charts below show price, funding APR, and OI so you can see how close it got.
    Try lowering <code>--threshold</code> or picking a coin with more activity.
  </div>`
      : ""
  }
  <div class="chart-wrap big"><div class="chart-loading" id="load-p-${coin}">Loading price chart…</div><canvas id="p-${coin}"></canvas></div>
  <div class="chart-wrap med"><div class="chart-loading" id="load-f-${coin}">Loading funding chart…</div><canvas id="f-${coin}"></canvas></div>
  <div class="chart-wrap med"><div class="chart-loading" id="load-o-${coin}">Loading OI chart…</div><canvas id="o-${coin}"></canvas></div>
  ${
    outcomes.length
      ? `<h3 class="dh">Signal detail — 48h before &amp; ${config.lookaheadHours}h after each alert</h3>
  <div class="dgrid" id="details-${coin}"></div>`
      : ""
  }
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AltShortBot Backtest — ${config.coins.join(", ")}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
h1{font-size:1.5rem;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.sub{color:#64748b;font-size:.9rem;margin-bottom:24px}
.cdnwarn{background:#1e3a5f;border:1px solid #3b82f6;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:.85rem;color:#93c5fd;display:none}
.cdnwarn strong{color:#bfdbfe}
h2{font-size:1.25rem;font-weight:600;color:#f1f5f9;margin-bottom:16px;display:flex;align-items:center;gap:10px}
h3.dh{color:#94a3b8;font-size:1rem;margin:28px 0 14px}
.tag{background:#1e293b;color:#94a3b8;font-size:.78rem;padding:2px 10px;border-radius:99px}
.coin-section{margin-bottom:60px}
.overview-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:18px}
.stat-card{background:#1e293b;border-radius:10px;padding:14px 16px;border:1px solid #334155}
.stat-card.green{border-color:#22c55e44}.stat-card.red{border-color:#ef444444}
.stat-v{font-size:1.5rem;font-weight:700;color:#f1f5f9}.stat-l{font-size:.75rem;color:#64748b;margin-top:2px}
.chart-wrap{background:#1e293b;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #334155;position:relative}
.chart-wrap.big{height:320px}.chart-wrap.med{height:180px}.chart-wrap.dc{height:220px;padding:0;border:none;margin:0}
.chart-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#475569;font-size:.85rem;pointer-events:none}
.chart-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ef4444;font-size:.8rem;text-align:center;padding:16px}
canvas{display:block;width:100%!important;height:100%!important}
.dgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:16px}
.dcard{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155;border-top:3px solid}
.dhead{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.badge{font-size:.73rem;font-weight:700;padding:3px 10px;border-radius:99px;letter-spacing:.05em}
.dtime{font-size:.85rem;color:#94a3b8;font-weight:500}
.dstats{display:flex;gap:14px;flex-wrap:wrap;font-size:.8rem;color:#64748b;margin-bottom:12px}
.dstats strong{color:#e2e8f0}.g{color:#22c55e!important}.r{color:#ef4444!important}
.no-signal-banner{background:#1e3a5f;border:1px solid #3b82f6;border-radius:10px;padding:14px 18px;margin-bottom:18px;font-size:.9rem;color:#93c5fd;line-height:1.5}
.no-signal-banner strong{color:#bfdbfe}.no-signal-banner code{background:#0f172a;padding:2px 6px;border-radius:4px;font-family:monospace}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:24px}
.legend-item{display:flex;align-items:center;gap:6px;font-size:.82rem;color:#94a3b8}
.ldot{width:12px;height:12px;border-radius:3px}
@media(max-width:900px){.overview-grid{grid-template-columns:repeat(3,1fr)}.dgrid{grid-template-columns:1fr}}
</style></head>
<body>
<h1>AltShortBot Signal Backtest</h1>
<p class="sub">${config.coins.join(", ")} · Last ${config.days} days · ${config.lookaheadHours}h lookahead · Gate 1: funding &gt; ${config.fundingAprThreshold}% APR</p>
<div class="cdnwarn" id="cdnwarn">
  <strong>Charts not loading?</strong> This file needs internet access to load Chart.js from a CDN.
  If you're offline or on a restricted network, run: <code>python3 -m http.server 8080</code> in this folder, then open <code>http://localhost:8080/backtest_chart.html</code>
</div>
<div class="legend">
  <div class="legend-item"><div class="ldot" style="background:#22c55e"></div>DROPPED ✅</div>
  <div class="legend-item"><div class="ldot" style="background:#f97316"></div>PUMP+DUMP ✅</div>
  <div class="legend-item"><div class="ldot" style="background:#ef4444"></div>SQUEEZED ❌</div>
  <div class="legend-item"><div class="ldot" style="background:#94a3b8"></div>NEUTRAL 😐</div>
</div>
${coinSections}
<script>
const ALL_DATA = ${dataJson};

function showLoading(id, show) {
  const el = document.getElementById('load-' + id);
  if (el) el.style.display = show ? 'flex' : 'none';
}
function showError(canvasId, msg) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const err = document.createElement('div');
  err.className = 'chart-error';
  err.textContent = msg;
  canvas.parentNode.appendChild(err);
  canvas.style.display = 'none';
}

function makeChart(id, type, data, options, plugins) {
  showLoading(id, false);
  const canvas = document.getElementById(id);
  if (!canvas) { console.warn('Canvas not found:', id); return; }
  try {
    return new Chart(canvas, { type, data, options, plugins });
  } catch (e) {
    console.error('Chart error for', id, e);
    showError(id, 'Chart error: ' + e.message);
  }
}

function darkScales(extraY) {
  const base = {
    x: { ticks: { maxTicksLimit: 12, color: '#64748b', maxRotation: 0 }, grid: { color: '#1e293b' } },
    y: { position: 'left', ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
  };
  if (extraY) base.y2 = extraY;
  return base;
}

function sigAnnotations(signals, displayLen, lookahead) {
  const ann = {};
  signals.forEach((sig, i) => {
    ann['sl'+i] = { type:'line', xMin:sig.idx, xMax:sig.idx, borderColor:sig.colour, borderWidth:2, borderDash:[5,3] };
    ann['sb'+i] = { type:'box', xMin:sig.idx, xMax:sig.endIdx, backgroundColor:sig.colour+'18', borderWidth:0 };
    ann['lbl'+i] = { type:'label', xValue:sig.idx, yValue:'center',
      content:['🔴 SIGNAL', sig.verdict, (sig.fundingApr ?? 0).toFixed(1)+'% APR'],
      backgroundColor:sig.colour+'33', borderColor:sig.colour, borderWidth:1, borderRadius:4,
      font:{size:10}, color:'#f1f5f9', padding:5, position:{x:'center',y:'start'} };
  });
  return ann;
}

window.addEventListener('load', function() {
  // Check if Chart.js loaded
  if (typeof Chart === 'undefined') {
    document.getElementById('cdnwarn').style.display = 'block';
    document.querySelectorAll('.chart-loading').forEach(el => {
      el.textContent = 'Chart.js failed to load — check internet connection or see banner above';
      el.style.color = '#ef4444';
    });
    return;
  }

  // Register annotation plugin if available
  const CA = (typeof ChartAnnotation !== 'undefined') ? ChartAnnotation : null;
  if (CA) Chart.register(CA);

  ALL_DATA.forEach(function(d) {
    const coin = d.coin;
    const plugins = CA ? [CA] : [];
    const pAnn = sigAnnotations(d.signals, d.labels.length);
    const maxF = d.maxFunding > 0 ? d.maxFunding.toFixed(2) : '—';

    // ── Price chart ───────────────────────────────────────────────
    const fAnn = {
      thr: { type:'line', yMin:d.threshold, yMax:d.threshold,
             borderColor:'#f9731688', borderWidth:1.5, borderDash:[6,4],
             label:{content:'Gate 1: '+d.threshold+'% APR', display:true, position:'end', color:'#f97316', font:{size:10}} }
    };
    d.signals.forEach((sig,i) => { fAnn['fs'+i] = {type:'line',xMin:sig.idx,xMax:sig.idx,borderColor:sig.colour,borderWidth:1.5,borderDash:[5,3]}; });

    const oAnn = {};
    d.signals.forEach((sig,i) => { oAnn['os'+i] = {type:'line',xMin:sig.idx,xMax:sig.idx,borderColor:sig.colour,borderWidth:1.5,borderDash:[5,3]}; });

    const commonOpts = (ann, title, yFmt) => ({
      responsive:true, maintainAspectRatio:false,
      plugins: { legend:{display:false}, annotation: ann ? {annotations:ann} : {},
                 title:{display:true,text:title,color:'#94a3b8',font:{size:12}},
                 tooltip:{mode:'index',intersect:false} },
      scales: darkScales(),
      interaction:{mode:'nearest',axis:'x',intersect:false},
    });

    makeChart('p-'+coin, 'line', {
      labels: d.labels,
      datasets: [{label:coin+' Price',data:d.prices,borderColor:'#94a3b8',borderWidth:1.5,pointRadius:0,fill:false,tension:0.1}]
    }, { ...commonOpts(pAnn, coin+' Price — 🔴 marks where the bot would have alerted you') }, plugins);

    makeChart('f-'+coin, 'line', {
      labels: d.labels,
      datasets: [{label:'Funding APR%',data:d.funding,borderColor:'#f97316',borderWidth:1.5,pointRadius:0,fill:true,backgroundColor:'rgba(249,115,22,0.08)'}]
    }, { ...commonOpts(fAnn, 'Funding APR % (peak: '+maxF+'%) — dashed line = Gate 1 threshold') }, plugins);

    makeChart('o-'+coin, 'line', {
      labels: d.labels,
      datasets: [{label:'OI $M',data:d.oi,borderColor:'#8b5cf6',borderWidth:1.5,pointRadius:0,fill:true,backgroundColor:'rgba(139,92,246,0.08)'}]
    }, { ...commonOpts(oAnn, 'Open Interest ($M USD)') }, plugins);

    // ── Detail cards ──────────────────────────────────────────────
    const detailContainer = document.getElementById('details-'+coin);
    if (!detailContainer) return;

    d.signals.forEach(function(sig, i) {
      const det = sig.detail;
      const card = document.createElement('div');
      card.className = 'dcard';
      card.style.borderTopColor = det.colour;
      card.innerHTML =
        '<div class="dhead"><span class="badge" style="background:'+det.colour+'22;color:'+det.colour+';border:1px solid '+det.colour+'">'+(det.signalType==="SQUEEZE" && det.signalPhase ? det.signalPhase+' — ' : det.signalType==="PUMP_TOP" ? 'PUMP TOP — ' : '')+det.verdict+'</span>'+
        '<span class="dtime">🔴 Alert sent at '+det.firedAtStr+'</span></div>'+
        '<div class="dstats">'+
          '<span>Entry <strong>$'+det.entryPrice.toFixed(4)+'</strong></span>'+
          '<span>Funding <strong>'+det.fundingApr.toFixed(1)+'% APR</strong></span>'+
          '<span>OI <strong>+'+det.oiChange.toFixed(1)+'%</strong></span>'+
          '<span>Max <strong class="'+(det.maxPct>=0?'g':'r')+'">'+s(det.maxPct)+'%</strong></span>'+
          '<span>Min <strong class="r">'+s(det.minPct)+'%</strong></span>'+
          '<span>'+d.lookaheadHours+'h <strong class="'+(det.finalPct<0?'g':'r')+'">'+s(det.finalPct)+'%</strong></span>'+
        '</div>'+
        '<div class="chart-wrap dc"><div class="chart-loading" id="load-dc-'+coin+'-'+i+'">Loading…</div><canvas id="dc-'+coin+'-'+i+'"></canvas></div>';
      detailContainer.appendChild(card);

      const sigAnn = {
        sig: { type:'line', xMin:det.sigIdx, xMax:det.sigIdx, borderColor:det.colour, borderWidth:2.5,
               label:{content:['🔴 ALERT SENT', det.firedAtStr], display:true, position:'start',
                      color:'#f1f5f9', backgroundColor:det.colour+'cc', font:{size:11}, padding:6} },
        box: { type:'box', xMin:det.sigIdx, xMax:det.labels.length-1, backgroundColor:det.colour+'11', borderWidth:0 },
      };
      showLoading('dc-'+coin+'-'+i, false);
      const dcanvas = document.getElementById('dc-'+coin+'-'+i);
      if (dcanvas) {
        try {
          new Chart(dcanvas, {
            type:'line',
            data:{ labels:det.labels, datasets:[
              {label:'Price',data:det.prices,borderColor:'#94a3b8',borderWidth:2,pointRadius:0,fill:false,yAxisID:'y'},
              {label:'Funding%',data:det.funding,borderColor:'#f97316',borderWidth:1.5,pointRadius:0,fill:false,yAxisID:'y2',borderDash:[3,2]},
            ]},
            options:{
              responsive:true, maintainAspectRatio:false,
              plugins:{ legend:{labels:{color:'#64748b',boxWidth:10,font:{size:11}}},
                        annotation:CA?{annotations:sigAnn}:{}, tooltip:{mode:'index',intersect:false} },
              scales:{ x:{ticks:{maxTicksLimit:10,color:'#64748b',maxRotation:0},grid:{color:'#1e293b'}},
                       y:{position:'left',ticks:{color:'#94a3b8'},grid:{color:'#1e293b'}},
                       y2:{position:'right',ticks:{color:'#f97316',callback:function(v){return Number(v).toFixed(1)+'%'}},grid:{drawOnChartArea:false}} },
              interaction:{mode:'nearest',axis:'x',intersect:false},
            },
            plugins: CA ? [CA] : [],
          });
        } catch(e) { console.error('Detail chart error:', e); }
      }
    });
  });
});

// Helper (mirrored from TS)
function s(n) { return (n>=0?'+':'')+n.toFixed(2); }
<\/script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV / Utilities
// ─────────────────────────────────────────────────────────────────────────────

function saveJSON(results: CoinResult[], config: Config): void {
  const out = {
    generatedAt: new Date().toISOString(),
    params: {
      coins: config.coins,
      days: config.days,
      lookaheadHours: config.lookaheadHours,
      fundingAprThreshold: config.fundingAprThreshold,
      squeezeMaxFundingApr: config.squeezeMaxFundingApr,
      pumpMinPct: config.pumpMinPct,
      pumpMinRsi: config.pumpMinRsi,
    },
    coins: results.map((r) => {
      const fundWins = r.outcomes.filter((o) =>
        ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
      ).length;
      const pumpWins = r.pumpOutcomes.filter((o) =>
        ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
      ).length;
      const sqExhaust = r.squeezeOutcomes.filter(
        (o) =>
          (o.signal as unknown as SqueezeSignal).signalPhase === "EXHAUSTION",
      );
      const sqBuilding = r.squeezeOutcomes.filter(
        (o) =>
          (o.signal as unknown as SqueezeSignal).signalPhase === "BUILDING",
      );
      const sqTrend = r.squeezeOutcomes.filter(
        (o) =>
          (o.signal as unknown as SqueezeSignal).signalPhase === "TREND_BREAK",
      );
      const sqWins = r.squeezeOutcomes.filter((o) =>
        ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
      ).length;
      return {
        coin: r.coin,
        funding: {
          signals: r.outcomes.length,
          wins: fundWins,
          winRate: r.outcomes.length
            ? Math.round((fundWins / r.outcomes.length) * 100)
            : null,
          signals_detail: r.outcomes.map((o) => ({
            firedAt: o.signal.firedAtStr,
            entry: Math.round(o.signal.entryPrice * 10000) / 10000,
            maxPct: Math.round(o.maxPricePct * 100) / 100,
            minPct: Math.round(o.minPricePct * 100) / 100,
            finalPct: Math.round(o.finalPricePct * 100) / 100,
            verdict: o.verdict,
          })),
        },
        pump: {
          signals: r.pumpOutcomes.length,
          wins: pumpWins,
          winRate: r.pumpOutcomes.length
            ? Math.round((pumpWins / r.pumpOutcomes.length) * 100)
            : null,
          signals_detail: r.pumpOutcomes.map((o) => ({
            firedAt: o.signal.firedAtStr,
            entry: Math.round(o.signal.entryPrice * 10000) / 10000,
            maxPct: Math.round(o.maxPricePct * 100) / 100,
            minPct: Math.round(o.minPricePct * 100) / 100,
            finalPct: Math.round(o.finalPricePct * 100) / 100,
            verdict: o.verdict,
          })),
        },
        squeeze: {
          building: sqBuilding.length,
          exhaustion: sqExhaust.length,
          trendBreak: sqTrend.length,
          wins: sqWins,
          winRate: sqExhaust.length
            ? Math.round(
                (sqExhaust.filter((o) =>
                  ["DROPPED", "PUMP+DUMP"].includes(o.verdict),
                ).length /
                  sqExhaust.length) *
                  100,
              )
            : null,
          signals_detail: r.squeezeOutcomes.map((o) => {
            const sig = o.signal as unknown as SqueezeSignal;
            return {
              firedAt: sig.firedAtStr,
              phase: sig.signalPhase,
              entry: Math.round(sig.entryPrice * 10000) / 10000,
              fundingApr: sig.fundingApr,
              maxPct: Math.round(o.maxPricePct * 100) / 100,
              minPct: Math.round(o.minPricePct * 100) / 100,
              finalPct: Math.round(o.finalPricePct * 100) / 100,
              verdict: o.verdict,
            };
          }),
        },
      };
    }),
  };
  const path = config.jsonOutput!;
  writeFileSync(path, JSON.stringify(out, null, 2), "utf8");
  console.log(`JSON:    → ${path}`);
}

function saveCSV(results: CoinResult[], path: string): void {
  const h = [
    "coin",
    "fired_at",
    "entry_price",
    "funding_apr",
    "oi_change_pct",
    "max_pct",
    "min_pct",
    "final_pct",
    "verdict",
  ];
  const rows = results.flatMap((r) =>
    r.outcomes.map((o) => [
      o.signal.coin,
      o.signal.firedAtStr,
      o.signal.entryPrice,
      o.signal.fundingApr.toFixed(2),
      (o.signal as Signal).oiChangePct.toFixed(2),
      o.maxPricePct.toFixed(2),
      o.minPricePct.toFixed(2),
      o.finalPricePct.toFixed(2),
      o.verdict,
    ]),
  );
  writeFileSync(path, [h, ...rows].map((r) => r.join(",")).join("\n"), "utf8");
  console.log(`  CSV saved → ${path}`);
}

function avgArr(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function floorH(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
function s(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI + Main
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Universe helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FuturesSymbol {
  symbol: string; // e.g. "HIVEUSDT"
  coin: string; // e.g. "HIVE"
}

async function fetchAvailableCoins(): Promise<FuturesSymbol[]> {
  const info = (await bnGet(BN_BASE, "/fapi/v1/exchangeInfo", {})) as {
    symbols: { symbol: string; contractType: string; quoteAsset: string }[];
  };
  return info.symbols
    .filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
    .map((s) => ({ symbol: s.symbol, coin: s.symbol.replace(/USDT$/, "") }))
    .sort((a, b) => a.coin.localeCompare(b.coin));
}

function findSimilar(coin: string, all: FuturesSymbol[]): string[] {
  const upper = coin.toUpperCase();
  // Exact match first, then prefix, then contains.
  // Never match coins that are substrings of the query — that's what caused
  // "H" matching "HIVE" when searching for HIVE.
  const exact = all.filter((s) => s.coin === upper);
  const prefix = all.filter(
    (s) => s.coin !== upper && s.coin.startsWith(upper),
  );
  const contains = all.filter(
    (s) =>
      s.coin !== upper && !s.coin.startsWith(upper) && s.coin.includes(upper),
  );
  return [...exact, ...prefix, ...contains].map((s) => s.coin).slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  coins: string[];
  days: number;
  lookaheadHours: number;
  fundingAprThreshold: number;
  minPositiveReadings: number;
  minOiChangePct: number;
  maxPriceChangePct: number;
  pumpMinPct: number;
  pumpMinVolMult: number;
  pumpMinRsi: number;
  pumpMinFundingApr: number;
  squeezeMinPct: number;
  squeezeHours: number;
  squeezeMaxFundingApr: number; // funding must be BELOW this to count as building (default -100%)
  exhaustMaxFundingApr: number; // funding must be ABOVE this to count as exhaustion (default -20%)
  exhaustMinOiDrop: number; // OI must have dropped this % for exhaustion to fire (0 = disabled)
  squeezeMinOiDrop: number;
  trendFilter: boolean;
  trendDays7Pct: number;
  trendDays14Pct: number;
  trendBreakFundingApr: number;
  megaSqueezeHours: number;
  generateChart: boolean;
  outputPath?: string;
  jsonOutput?: string;
  saveFixtures?: string;
  useFixtures?: string;
  listCoins: boolean;
  searchCoin?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const g = (f: string, fb: string) => {
    const i = a.indexOf(f);
    return i !== -1 && a[i + 1] ? a[i + 1] : fb;
  };
  return {
    coins: g("--coin", "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
    days: parseInt(g("--days", "90"), 10),
    lookaheadHours: parseInt(g("--lookahead", "24"), 10),
    fundingAprThreshold: parseFloat(g("--threshold", "50")),
    minPositiveReadings: parseInt(g("--min-positive", "6"), 10),
    minOiChangePct: parseFloat(g("--min-oi", "5")),
    maxPriceChangePct: parseFloat(g("--max-price", "0.5")),
    pumpMinPct: parseFloat(g("--pump-pct", "20")),
    pumpMinVolMult: parseFloat(g("--pump-vol", "8")),
    pumpMinRsi: parseFloat(g("--pump-rsi", "80")),
    pumpMinFundingApr: parseFloat(g("--pump-funding", "50")),
    squeezeMinPct: parseFloat(g("--squeeze-pct", "20")),
    squeezeHours: parseInt(g("--squeeze-hours", "6"), 10),
    squeezeMaxFundingApr: parseFloat(g("--squeeze-funding", "-10")),
    exhaustMaxFundingApr: parseFloat(g("--exhaust-funding", "-20")), // tighter than building threshold
    exhaustMinOiDrop: parseFloat(g("--exhaust-oi-drop", "0")), // 0 = disabled by default
    squeezeMinOiDrop: parseFloat(g("--squeeze-oi-drop", "3")),
    trendFilter: !a.includes("--no-trend-filter"),
    trendDays7Pct: parseFloat(g("--trend-7d", "30")),
    trendDays14Pct: parseFloat(g("--trend-14d", "50")),
    trendBreakFundingApr: parseFloat(g("--trend-break-apr", "-500")),
    megaSqueezeHours: parseFloat(g("--mega-squeeze", "0")),

    generateChart: a.includes("--chart"),
    outputPath: a.includes("--output")
      ? g("--output", "results.csv")
      : undefined,
    jsonOutput: a.includes("--json")
      ? g("--json", "backtest_results.json")
      : undefined,
    saveFixtures: a.includes("--save-fixtures")
      ? g("--save-fixtures", "fixtures")
      : undefined,
    useFixtures: a.includes("--use-fixtures")
      ? g("--use-fixtures", "fixtures")
      : undefined,
    listCoins: a.includes("--list"),
    searchCoin: a.includes("--search") ? g("--search", "") : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  // ── --list: show all available Binance Futures USDT perps ────────────────
  if (args.listCoins) {
    console.log("Fetching available Binance Futures USDT perpetuals...\n");
    const all = await fetchAvailableCoins();
    const cols = 6;
    const rows: string[][] = [];
    for (let i = 0; i < all.length; i += cols) {
      rows.push(all.slice(i, i + cols).map((s) => s.coin.padEnd(10)));
    }
    console.log(`${all.length} coins available on Binance Futures:\n`);
    rows.forEach((r) => console.log("  " + r.join("")));
    console.log(`\nUsage: npx tsx backtest_signals.ts --coin HIVE --days 90`);
    console.log(`Search: npx tsx backtest_signals.ts --search HIVE`);
    return;
  }

  // ── --search: find coins matching a query ────────────────────────────────
  if (args.searchCoin) {
    console.log(`Searching for "${args.searchCoin}" on Binance Futures...\n`);
    const all = await fetchAvailableCoins();
    const query = args.searchCoin.toUpperCase();
    const matches = all.filter(
      (s) => s.coin.includes(query) || query.includes(s.coin),
    );
    if (!matches.length) {
      console.log(
        `  No coins matching "${args.searchCoin}" found on Binance Futures.`,
      );
      console.log(`  Run --list to see all available coins.`);
    } else {
      console.log(
        `  Found ${matches.length} match${matches.length !== 1 ? "es" : ""}:`,
      );
      matches.forEach((m) =>
        console.log(`    ${m.coin.padEnd(12)} (${m.symbol})`),
      );
    }
    return;
  }

  // ── Validate coins before fetching data ──────────────────────────────────
  if (!args.coins.length) {
    console.log("AltShortBot Signal Backtester");
    console.log("─".repeat(40));
    console.log("Usage:");
    console.log("  npx tsx backtest_signals.ts --coin WIF --days 90");
    console.log(
      "  npx tsx backtest_signals.ts --coin ETH,SOL --days 180 --chart",
    );
    console.log(
      "  npx tsx backtest_signals.ts --list              # show all available coins",
    );
    console.log(
      "  npx tsx backtest_signals.ts --search HIVE       # find coins by name",
    );
    return;
  }

  // Fetch the full universe once upfront for validation and suggestions
  let universe: FuturesSymbol[] = [];
  try {
    universe = await fetchAvailableCoins();
  } catch {
    // Non-fatal — continue without validation
  }
  const availableSet = new Set(universe.map((s) => s.coin));

  // Warn about any coins not listed before spending time fetching their data
  for (const coin of args.coins) {
    if (universe.length && !availableSet.has(coin)) {
      console.log(`\n⚠️  ${coin}USDT is not listed on Binance Futures.`);
      const similar = findSimilar(coin, universe);
      if (similar.length) {
        console.log(`   Similar coins available: ${similar.join(", ")}`);
      }
      console.log(
        `   Run --list to see all ${universe.length} available coins.`,
      );
      console.log(`   Run --search ${coin} to search by name.`);
    }
  }

  const validCoins = universe.length
    ? args.coins.filter((c) => availableSet.has(c))
    : args.coins; // if universe fetch failed, try anyway

  if (!validCoins.length) {
    console.log("\nNo valid coins to backtest. Exiting.");
    return;
  }

  const cfg: Config = { ...args, coins: validCoins };

  console.log("\nAltShortBot Signal Backtester\n" + "═".repeat(40));
  console.log(`Coins:   ${cfg.coins.join(", ")}`);
  console.log(
    `Period:  last ${cfg.days} days | ${cfg.lookaheadHours}h lookahead`,
  );
  if (cfg.days > 30) {
    console.log(
      `OI data:  last 30 days only (Binance openInterestHist hard limit)`,
    );
    console.log(
      `          Price + funding will use full ${cfg.days} day window.`,
    );
  }
  console.log(
    `Gate 1:  funding APR > ${cfg.fundingAprThreshold}%, ${cfg.minPositiveReadings}+ of 8 readings positive`,
  );
  console.log(
    `Pump:    candle >${cfg.pumpMinPct}%, vol \u00d7${cfg.pumpMinVolMult}, RSI >${cfg.pumpMinRsi}, funding >${cfg.pumpMinFundingApr}%APR`,
  );
  console.log(
    `Squeeze: cumul >${cfg.squeezeMinPct}% over ${cfg.squeezeHours}h, funding <${cfg.squeezeMaxFundingApr}%APR, OI drop >${cfg.squeezeMinOiDrop}%`,
  );
  console.log(
    `Exhaust: funding must normalise above ${cfg.exhaustMaxFundingApr}%APR (--exhaust-funding)`,
    ...(cfg.exhaustMinOiDrop > 0
      ? [
          `Exhaust OI: OI must drop >=${cfg.exhaustMinOiDrop}% for exhaustion (--exhaust-oi-drop)`,
        ]
      : []),
  );
  console.log(
    `Trend:   ${cfg.trendFilter ? `filter ON — block shorts if +${cfg.trendDays7Pct}%/7d AND +${cfg.trendDays14Pct}%/14d` : "filter OFF"}`,
  );
  console.log(
    `Gate 2:  OI +${cfg.minOiChangePct}% over 4h, price flat (<${cfg.maxPriceChangePct}%)`,
  );
  console.log(
    `Chart:   ${cfg.generateChart ? "→ backtest_chart.html" : "disabled (add --chart)"}`,
  );

  const results: CoinResult[] = [];
  for (const coin of cfg.coins) {
    console.log(`\n── ${coin} ${"─".repeat(36 - coin.length)}`);
    try {
      results.push(await backtestCoin(coin, cfg));
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      console.log(`  ❌ ${m}`);
    }
  }

  printReport(results, cfg);

  if (cfg.outputPath && results.some((r) => r.outcomes.length))
    saveCSV(results, cfg.outputPath);
  if (cfg.jsonOutput) saveJSON(results, cfg);

  if (cfg.generateChart) {
    writeFileSync(
      "backtest_chart.html",
      generateChartHTML(results, cfg),
      "utf8",
    );
    console.log("\n  Chart saved → backtest_chart.html");
    console.log("  Open it in your browser.");
  }
}

main().catch((e) => {
  console.error("\nFatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
