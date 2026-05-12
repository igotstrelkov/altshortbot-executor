import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { logBuildingSignal } from "./check_building_signals.ts";
import type { Alert, QueuedSignal } from "./shared_types.ts";

/**
 * AltShortBot Live Scanner
 * ========================
 * Runs every hour against all active Bybit USDT perpetuals, detects
 * short squeeze and funding signals, and sends Telegram alerts.
 *
 * Data source: Bybit only (candles, funding, OI, coin discovery).
 * The 9 validated coins (HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH)
 * were used to tune the algorithm — the same parameters apply to all coins.
 *
 * Setup:
 *   1. Create a Telegram bot via @BotFather → get token
 *   2. Get chat ID: curl https://api.telegram.org/bot<TOKEN>/getUpdates
 *   3. Set env vars:
 *      export TELEGRAM_TOKEN="123456:ABC-DEF..."
 *      export TELEGRAM_CHAT_ID="-1001234567890"
 *
 * Run once (add to cron: 5 * * * * npx tsx live_scanner.ts >> logs/scanner.log 2>&1):
 *   npx tsx live_scanner.ts
 *
 * Run continuously (checks every hour on the hour):
 *   npx tsx live_scanner.ts --watch
 *
 * Scan specific coins:
 *   npx tsx live_scanner.ts --coins ORDI,KNC,HIVE
 *
 * Dry run (Telegram fires normally if creds set; queue is NOT written so the
 * executor cannot pick up signals from this scan):
 *   npx tsx live_scanner.ts --dry-run
 */

// ─── Coin discovery ──────────────────────────────────────────────────────────
// The scanner runs against ALL active USDT perpetuals — not a fixed watchlist.
// The 9 coins (HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH) were used
// to validate and tune the algorithm. Those same parameters now apply universally.
// New listings are picked up automatically; delisted coins drop off cleanly.

// Skip these regardless (index tokens, large caps that almost never fire)
const EXCLUDE_COINS = new Set(["BTC", "ETH", "BNB", "BTCDOM"]);

// Sub-penny tokens have squeeze cycles longer than the 10h detection window
// and produce unreliable exhaustion signals. Filter them out at discovery.
const MIN_PRICE_USDC = 0.001;

// Fallback if exchange info is unavailable
const FALLBACK_COINS = [
  "HYPER",
  "HIVE",
  "KNC",
  "WIF",
  "BSB",
  "SPK",
  "ENJ",
  "ORDI",
  "DASH",
];

async function fetchAllCoins(): Promise<string[]> {
  try {
    const [info, tickers] = (await Promise.all([
      fetchJSON(
        `${BB_BASE}/v5/market/instruments-info?category=linear&status=Trading&limit=1000`,
      ),
      fetchJSON(`${BB_BASE}/v5/market/tickers?category=linear`),
    ])) as [
      { result?: { list?: { symbol: string; quoteCoin: string }[] } },
      { result?: { list?: { symbol: string; lastPrice: string }[] } },
    ];

    const priceMap = new Map<string, number>();
    for (const t of tickers?.result?.list ?? [])
      priceMap.set(t.symbol, parseFloat(t.lastPrice));

    const coins = (info?.result?.list ?? [])
      .filter((s) => s.quoteCoin === "USDT")
      .filter((s) => (priceMap.get(s.symbol) ?? 0) >= MIN_PRICE_USDC)
      .map((s) => s.symbol.replace("USDT", ""))
      .filter((c) => !EXCLUDE_COINS.has(c))
      .sort();
    if (coins.length) return coins;
  } catch {
    /* fall through */
  }
  console.warn(
    "  ⚠️  Could not fetch coin list — using fallback validated set",
  );
  return FALLBACK_COINS;
}

// ─── Module-level constants ───────────────────────────────────────────────────
const HOUR = 3_600_000;
const FUNDING_COOLDOWN_MS = 8 * HOUR; // Gate 1 re-fires once per settlement cycle
// Re-fire BUILDING when funding becomes 2× more extreme than when it first fired.
// E.g.: first fire at -300% APR → re-fire when funding reaches -600% APR.
const BUILDING_REFIRE_MULTIPLIER = 2.0;
// Block BUILDING queue entry if OI increased >50% in squeeze window.
// Negative oiDropPct means OI rose — squeeze still actively building.
// Evidence: SOLV May-12 oiDropPct=-182.9% → SQUEEZED; flat OI (0%) → profitable.
// Start conservative at -50%; tune after 4+ weeks of signal data.
const BUILDING_OI_RISING_MAX = -50;
const MIN_EXHAUSTION_GAP_H = 6; // Exhaustion re-fire minimum gap (hours)
const STATE_FILE = "scanner_state.json";
const BB_BASE = "https://api.bybit.com";

// ─── Validated parameters (from backtesting across 10 coins) ─────────────────
const PARAMS = {
  // Gate 1 — crowded longs
  fundingAprThreshold: 10,
  minPositiveReadings: 2,
  // Gate 2 — OI divergence
  minOiChangePct: 2,
  maxPriceChangePct: 2,
  // Pump top
  pumpMinPct: 19,
  pumpMinVolMult: 5,
  pumpMinRsi: 88,
  pumpMinFundingApr: 0,
  // Short squeeze — building phase
  squeezeMinPct: 20,
  squeezeHours: 10,
  squeezeMaxFundingApr: -100,
  squeezeMinOiDrop: 0,
  // Short squeeze — exhaustion phase
  exhaustMaxFundingApr: -20,
  exhaustMinOiDrop: 3, // OI must drop ≥3% — blocks flat-OI false positives (NOT coin)
  // Trend filter
  trendDays7Pct: 30,
  trendDays14Pct: 50,
  trendBreakFundingApr: -500,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────
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

interface CoinState {
  // Wave tracking
  squeezeWaveStartMs: number | null;
  squeezeWaveHighPrice: number;
  lastBuildingSignalMs: number | null;
  lastBuildingMinFunding: number; // persists across wave resets — needed for TREND_BREAK
  lastSqueezePhase: "BUILDING" | "EXHAUSTION" | "TREND_BREAK" | null;
  // Per-wave fired flags
  waveAlertedBuilding: boolean; // BUILDING fires once per wave
  lastBuildingFundingApr: number; // funding APR when last BUILDING fired — used for re-fire
  waveAlertedTrendBreak: boolean; // TREND_BREAK fires once per trending episode
  // Exhaustion: timestamp-based (6h minimum gap) — allows re-fire after early bad signal
  lastExhaustionMs: number | null;
  // Funding cooldown
  lastFundingAlertMs: number | null;
  // Trend tracking (detects uptrend exit to reset waveAlertedTrendBreak)
  wasTrending: boolean;
}

// ─── Module-level helpers ─────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const floorH = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const avgArr = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function getPriceHoursAgo(candles: Candle[], hoursAgo: number): number | null {
  return candles.length > hoursAgo
    ? candles[candles.length - 1 - hoursAgo].c
    : null;
}

function getLast8HourlyFundingReadings(
  merged: Record<number, number>,
  nowTs: number,
): number[] {
  const readings: number[] = [];
  for (let i = 7; i >= 0; i--) {
    readings.push(merged[floorH(nowTs - i * HOUR)] ?? 0);
  }
  return readings;
}

// ─── State persistence ────────────────────────────────────────────────────────
function defaultState(): CoinState {
  return {
    squeezeWaveStartMs: null,
    squeezeWaveHighPrice: 0,
    lastBuildingSignalMs: null,
    lastBuildingMinFunding: 0,
    lastSqueezePhase: null,
    waveAlertedBuilding: false,
    lastBuildingFundingApr: 0,
    waveAlertedTrendBreak: false,
    lastExhaustionMs: null,
    lastFundingAlertMs: null,
    wasTrending: false,
  };
}

function loadState(): Record<string, CoinState> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state: Record<string, CoinState>): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ─── Signal queue (consumed by hl_executor.ts) ───────────────────────────────
const QUEUE_FILE = "signal_queue.json";

function appendToQueue(alert: Alert): void {
  let queue: QueuedSignal[] = [];
  try {
    if (existsSync(QUEUE_FILE))
      queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    queue = [];
  }

  queue.push({ ...alert, queuedAt: Date.now() });
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
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
  throw new Error(`fetchJSON failed after 3 attempts: ${url}`);
}

// ─── Data fetching ────────────────────────────────────────────────────────────
async function fetchCandles(coin: string, limit: number): Promise<Candle[]> {
  const raw = (await fetchJSON(
    `${BB_BASE}/v5/market/kline?category=linear&symbol=${coin}USDT&interval=60&limit=${limit}`,
  )) as { result?: { list?: string[][] } };
  // Bybit returns newest-first — reverse to get chronological order
  return (raw?.result?.list ?? []).reverse().map((r) => ({
    t: parseInt(r[0]),
    o: parseFloat(r[1]),
    h: parseFloat(r[2]),
    l: parseFloat(r[3]),
    c: parseFloat(r[4]),
    v: parseFloat(r[5]),
  }));
}

async function fetchFundingBybit(coin: string): Promise<FundingRecord[]> {
  // Fetch actual settlement interval (varies: 4h or 8h per coin)
  let intervalHours = 8;
  try {
    const info = (await fetchJSON(
      `${BB_BASE}/v5/market/instruments-info?category=linear&symbol=${coin}USDT`,
    )) as { result?: { list?: { fundingInterval?: number }[] } };
    const fi = info?.result?.list?.[0]?.fundingInterval;
    if (fi) intervalHours = fi / 60;
  } catch {
    /* use default 8h */
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
    .reverse();
}

// ── Binance funding (supplementary source) ───────────────────────────────────
// Fetches Binance funding history for the last ~200 settlement periods.
// Used alongside Bybit to capture squeeze dynamics visible on either exchange.
const BN_BASE = "https://fapi.binance.com";

async function fetchFundingBinance(coin: string): Promise<FundingRecord[]> {
  try {
    const url = `${BN_BASE}/fapi/v1/fundingRate?symbol=${coin}USDT&limit=200`;
    const raw = (await fetchJSON(url)) as {
      fundingTime: number;
      fundingRate: string;
    }[];
    // Binance settles every 8h — divide by 8 for per-hour rate
    return raw.map((r) => ({
      timeMs: r.fundingTime,
      ratePerHour: parseFloat(r.fundingRate) / 8,
    }));
  } catch {
    return []; // non-fatal — Bybit funding still used
  }
}

// ── Merged funding by hour ────────────────────────────────────────────────────
// Combines Bybit and Binance funding, taking the most extreme rate per hour.
// Captures squeeze signals visible on either exchange (e.g. HYPER/SPK show
// more extreme negative funding on Binance than Bybit).
function buildMergedFundingByHour(
  bybit: FundingRecord[],
  binance: FundingRecord[],
): Record<number, number> {
  // Build forward-filled maps for each source
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

  const bbMap = forwardFill(bybit);
  const bnMap = forwardFill(binance);

  // Union of all timestamps — take most extreme (highest absolute) per hour
  const allTs = Array.from(
    new Set([...Object.keys(bbMap), ...Object.keys(bnMap)].map(Number)),
  );
  const merged: Record<number, number> = {};
  for (const ts of allTs) {
    const bb = bbMap[ts] ?? 0;
    const bn = bnMap[ts] ?? 0;
    merged[ts] = Math.abs(bb) >= Math.abs(bn) ? bb : bn;
  }
  return merged;
}

async function fetchOIHistory(
  coin: string,
  candles: Candle[],
): Promise<OIRecord[]> {
  const raw = (await fetchJSON(
    `${BB_BASE}/v5/market/open-interest?category=linear&symbol=${coin}USDT&intervalTime=1h&limit=20`,
  )) as { result?: { list?: { timestamp: string; openInterest: string }[] } };

  // Build price lookup for USD conversion (Bybit OI is in contracts, not USD)
  const priceByHour: Record<number, number> = {};
  for (const c of candles) priceByHour[floorH(c.t)] = c.c;
  const currentPrice = candles[candles.length - 1].c;

  return (raw?.result?.list ?? []).reverse().map((r) => {
    const ts = parseInt(r.timestamp);
    const price = priceByHour[floorH(ts)] ?? currentPrice;
    return { timeMs: ts, oiUsd: parseFloat(r.openInterest) * price };
  });
}

// ─── Funding by hour ─────────────────────────────────────────────────────────
// Forward-fill Bybit funding records to a per-hour lookup.
function buildFundingByHour(records: FundingRecord[]): Record<number, number> {
  const sorted = [...records].sort((a, b) => a.timeMs - b.timeMs);
  if (!sorted.length) return {};

  // Forward-fill between Bybit settlement timestamps (every 4h or 8h).
  // Without this, non-settlement hours return 0 via ?? 0, causing
  // squeeze detection to fail for 7 of every 8 hours on 8h-settlement coins.
  const byHour: Record<number, number> = {};
  let last = 0;
  let rIdx = 0;
  const startTs = floorH(sorted[0].timeMs);
  const endTs = floorH(Date.now()) + HOUR;

  for (let ts = startTs; ts <= endTs; ts += HOUR) {
    while (rIdx < sorted.length && floorH(sorted[rIdx].timeMs) <= ts) {
      last = sorted[rIdx].ratePerHour;
      rIdx++;
    }
    byHour[ts] = last;
  }
  return byHour;
}

// ─── Signal detection ─────────────────────────────────────────────────────────
function computeRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].c - candles[i - 1].c;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / period / (losses / period));
}

function detectPumpTop(
  candles: Candle[],
  fundingNow: number,
): { triggered: boolean; candlePct: number; volMult: number; rsi: number } {
  if (candles.length < 50)
    return { triggered: false, candlePct: 0, volMult: 0, rsi: 0 };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const candlePct = ((last.h - prev.c) / (prev.c || 1)) * 100;
  const avgVol = avgArr(candles.slice(-49, -1).map((c) => c.v));
  const volMult = avgVol > 0 ? last.v / avgVol : 0;
  const rsi = computeRSI(candles);
  const fundingApr = fundingNow * 8760 * 100;
  return {
    triggered:
      candlePct >= PARAMS.pumpMinPct &&
      volMult >= PARAMS.pumpMinVolMult &&
      rsi >= PARAMS.pumpMinRsi &&
      fundingApr >= PARAMS.pumpMinFundingApr,
    candlePct,
    volMult,
    rsi,
  };
}

function detectShortSqueeze(
  candleWindow: Candle[],
  oiSeries: number[],
  fundingNow: number,
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
  const N = PARAMS.squeezeHours;
  if (candleWindow.length < N + 2) return none;

  const startClose = candleWindow[candleWindow.length - N - 1].c;
  const windowHigh = Math.max(...candleWindow.slice(-N).map((c) => c.h));
  const cumulativePct =
    startClose > 0 ? ((windowHigh - startClose) / startClose) * 100 : 0;
  const fundingApr = fundingNow * 8760 * 100;
  let oiDropPct = 0;

  if (oiSeries.length >= 2) {
    const oiStart = oiSeries[Math.max(0, oiSeries.length - N - 1)];
    const oiNow = oiSeries[oiSeries.length - 1];
    oiDropPct = oiStart > 0 ? ((oiStart - oiNow) / oiStart) * 100 : 0;
  }

  const isSqueeze =
    cumulativePct >= PARAMS.squeezeMinPct &&
    fundingApr <= PARAMS.squeezeMaxFundingApr;

  const avgCandleMove = avgArr(
    candleWindow
      .slice(-N)
      .map((c) => Math.abs(((c.c - c.o) / (c.o || 1)) * 100)),
  );
  const c1 = candleWindow[candleWindow.length - 1];
  const c2 = candleWindow[candleWindow.length - 2];
  const recentAvg =
    (Math.abs(((c1.c - c1.o) / (c1.o || 1)) * 100) +
      Math.abs(((c2.c - c2.o) / (c2.o || 1)) * 100)) /
    2;
  const lowerHigh =
    candleWindow.length >= 3 && c1.h < candleWindow[candleWindow.length - 3].h;

  const exhaustOiOk =
    PARAMS.exhaustMinOiDrop <= 0 || oiDropPct >= PARAMS.exhaustMinOiDrop;

  const isExhausting =
    cumulativePct >= PARAMS.squeezeMinPct * 0.8 &&
    fundingApr > PARAMS.exhaustMaxFundingApr &&
    fundingApr < 5 &&
    recentAvg < avgCandleMove * 0.5 &&
    lowerHigh &&
    exhaustOiOk;

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
  return none;
}

function isTrendingFull(
  priceNow: number,
  price7dAgo: number,
  price14dAgo: number,
): boolean {
  const rise7d =
    price7dAgo > 0 ? ((priceNow - price7dAgo) / price7dAgo) * 100 : 0;
  const rise14d =
    price14dAgo > 0 ? ((priceNow - price14dAgo) / price14dAgo) * 100 : 0;
  return rise7d >= PARAMS.trendDays7Pct && rise14d >= PARAMS.trendDays14Pct;
}

// ─── Gate 2 ───────────────────────────────────────────────────────────────────
function checkGate2(
  oiHistory: OIRecord[],
  candles: Candle[],
): { passes: boolean; oiChangePct: number; priceChangePct: number } {
  if (oiHistory.length < 5)
    return { passes: false, oiChangePct: 0, priceChangePct: 0 };
  const oiNow = oiHistory[oiHistory.length - 1].oiUsd;
  const oi4hAgo = oiHistory[oiHistory.length - 5].oiUsd;
  const oiChangePct = oi4hAgo > 0 ? ((oiNow - oi4hAgo) / oi4hAgo) * 100 : 0;
  const priceNow = candles[candles.length - 1].c;
  const price4hAgo =
    candles.length >= 5 ? candles[candles.length - 5].c : priceNow;
  const priceChangePct = Math.abs(
    ((priceNow - price4hAgo) / (price4hAgo || 1)) * 100,
  );
  return {
    passes:
      oiChangePct >= PARAMS.minOiChangePct &&
      priceChangePct <= PARAMS.maxPriceChangePct,
    oiChangePct,
    priceChangePct,
  };
}

// ─── Confidence scoring ───────────────────────────────────────────────────────
function getConfidence(
  phase: string,
  msSinceBuilding: number | null,
): "HIGH" | "MEDIUM" | "LOW" {
  if (phase === "TREND_BREAK") return "HIGH";
  if (phase === "BUILDING") return "MEDIUM";
  if (phase === "EXHAUSTION") {
    if (msSinceBuilding === null) return "LOW";
    const hours = msSinceBuilding / HOUR;
    if (hours >= 6) return "HIGH";
    if (hours >= 2) return "MEDIUM";
    return "LOW";
  }
  return "MEDIUM";
}

// ─── Core per-coin scanner ────────────────────────────────────────────────────
function scanCoin(
  coin: string,
  state: CoinState,
  candles: Candle[],
  mergedFunding: Record<number, number>,
  oiHistory: OIRecord[],
): { alerts: Alert[]; newState: CoinState } {
  const alerts: Alert[] = [];
  const newState: CoinState = { ...state };

  if (candles.length < PARAMS.squeezeHours + 15) return { alerts, newState };

  const price = candles[candles.length - 1].c;
  const ts = candles[candles.length - 1].t;
  const fRate = mergedFunding[floorH(ts)] ?? 0;
  const fundingApr = fRate * 8760 * 100;
  const oiSeries = oiHistory.map((r) => r.oiUsd);

  // ── Gate 1: crowded longs ─────────────────────────────────────────────────
  const last8 = getLast8HourlyFundingReadings(mergedFunding, ts);
  const positiveCount = last8.filter(
    (r) => r * 8760 * 100 >= PARAMS.fundingAprThreshold,
  ).length;
  const gate1Passes = positiveCount >= PARAMS.minPositiveReadings;
  const recentBldg =
    newState.lastBuildingSignalMs !== null &&
    ts - newState.lastBuildingSignalMs < 48 * HOUR;
  const fundingCooled =
    newState.lastFundingAlertMs === null ||
    ts - newState.lastFundingAlertMs >= FUNDING_COOLDOWN_MS;

  if (fundingApr < PARAMS.fundingAprThreshold)
    newState.lastFundingAlertMs = null;

  if (gate1Passes && !recentBldg && fundingCooled) {
    const gate2 = checkGate2(oiHistory, candles);
    if (gate2.passes) {
      alerts.push({
        coin,
        type: "FUNDING",
        firedAt: ts,
        firedAtStr: fmtDate(ts),
        entry: price,
        fundingApr,
        details: `Funding: ${fundingApr.toFixed(1)}% APR | OI: +${gate2.oiChangePct.toFixed(1)}% over 4h`,
        confidence: "MEDIUM",
        msSinceBuilding: null,
      });
      newState.lastFundingAlertMs = ts;
    }
  }

  // ── Pump top ──────────────────────────────────────────────────────────────
  const pump = detectPumpTop(candles, fRate);
  if (pump.triggered) {
    alerts.push({
      coin,
      type: "PUMP_TOP",
      firedAt: ts,
      firedAtStr: fmtDate(ts),
      entry: price,
      fundingApr,
      details: `Candle: +${pump.candlePct.toFixed(1)}% | Volume: ×${pump.volMult.toFixed(0)} | RSI: ${pump.rsi.toFixed(0)}`,
      confidence: "HIGH",
      msSinceBuilding: null,
    });
  }

  // ── Trend filter ──────────────────────────────────────────────────────────
  const price7d = getPriceHoursAgo(candles, 7 * 24);
  const price14d = getPriceHoursAgo(candles, 14 * 24);
  const trending =
    price7d !== null &&
    price14d !== null &&
    isTrendingFull(price, price7d, price14d);

  // Trend exit detection — runs every hour regardless of squeeze state
  const wasTrending = newState.wasTrending ?? false;
  if (wasTrending && !trending) newState.waveAlertedTrendBreak = false;
  newState.wasTrending = trending;

  // ── Short squeeze ─────────────────────────────────────────────────────────
  const candleWindow = candles.slice(-(PARAMS.squeezeHours + 2));
  const sq = detectShortSqueeze(candleWindow, oiSeries, fRate);

  if (sq.triggered && sq.phase) {
    if (sq.phase === "BUILDING") {
      if (newState.squeezeWaveStartMs === null)
        newState.squeezeWaveStartMs = ts;
      if (sq.fundingApr < newState.lastBuildingMinFunding)
        newState.lastBuildingMinFunding = sq.fundingApr;
    }
    if (price > newState.squeezeWaveHighPrice)
      newState.squeezeWaveHighPrice = price;

    const isTrendBreak =
      trending &&
      sq.phase === "EXHAUSTION" &&
      newState.lastBuildingMinFunding <= PARAMS.trendBreakFundingApr;
    const allowNormal =
      !trending && (sq.phase === "BUILDING" || sq.phase === "EXHAUSTION");

    if (isTrendBreak || allowNormal) {
      const phase = isTrendBreak ? "TREND_BREAK" : sq.phase!;
      const msSinceBuilding =
        newState.lastBuildingSignalMs !== null
          ? ts - newState.lastBuildingSignalMs
          : null;
      const confidence = getConfidence(phase, msSinceBuilding);

      const hoursSinceExhaustion =
        newState.lastExhaustionMs !== null
          ? (ts - newState.lastExhaustionMs) / HOUR
          : Infinity;

      // BUILDING re-fire: allow if funding is 2× more extreme than when it last fired
      const buildingRefireEligible =
        phase === "BUILDING" &&
        newState.waveAlertedBuilding &&
        newState.lastBuildingFundingApr < 0 &&
        sq.fundingApr <
          newState.lastBuildingFundingApr * BUILDING_REFIRE_MULTIPLIER;

      const alreadyFired =
        (phase === "BUILDING" &&
          newState.waveAlertedBuilding &&
          !buildingRefireEligible) ||
        (phase === "EXHAUSTION" &&
          hoursSinceExhaustion < MIN_EXHAUSTION_GAP_H) ||
        (phase === "TREND_BREAK" && newState.waveAlertedTrendBreak);

      if (!alreadyFired) {
        const isRefire = phase === "BUILDING" && newState.waveAlertedBuilding;
        const details =
          phase === "BUILDING"
            ? isRefire
              ? `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Funding: ${fundingApr.toFixed(0)}% APR (intensified from ${newState.lastBuildingFundingApr.toFixed(0)}%) | OI: ${sq.oiDropPct.toFixed(1)}%`
              : `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Funding: ${fundingApr.toFixed(0)}% APR | OI: ${sq.oiDropPct.toFixed(1)}%`
            : phase === "EXHAUSTION"
              ? `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Funding: ${fundingApr.toFixed(1)}% APR`
              : /* TREND_BREAK */ `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Prior funding: ${newState.lastBuildingMinFunding.toFixed(0)}% APR`;

        alerts.push({
          coin,
          type: phase,
          firedAt: ts,
          firedAtStr: fmtDate(ts),
          entry: price,
          fundingApr,
          details,
          confidence,
          msSinceBuilding,
          oiDropPct: sq.oiDropPct, // +ve=OI dropped, -ve=OI rose
        });

        if (phase === "BUILDING") {
          newState.waveAlertedBuilding = true;
          newState.lastBuildingSignalMs = ts;
          newState.lastBuildingFundingApr = sq.fundingApr;
        }
        if (phase === "EXHAUSTION") {
          newState.lastExhaustionMs = ts;
        }
        if (phase === "TREND_BREAK") {
          newState.waveAlertedTrendBreak = true;
        }
      }

      newState.lastSqueezePhase = phase;
    }
  } else if (!sq.triggered) {
    newState.squeezeWaveStartMs = null;
    newState.squeezeWaveHighPrice = 0;
    newState.waveAlertedBuilding = false;
    newState.lastExhaustionMs = null;
    newState.lastBuildingFundingApr = 0;
    if (newState.lastSqueezePhase === "BUILDING")
      newState.lastSqueezePhase = null;
  }

  return { alerts, newState };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const DRY_RUN = process.argv.includes("--dry-run");

function formatAlert(alert: Alert): string {
  const icons: Record<string, string> = {
    FUNDING: "💰",
    PUMP_TOP: "🚀",
    BUILDING: "⚠️",
    EXHAUSTION: "🎯",
    TREND_BREAK: "🚨",
  };
  const confIcons: Record<string, string> = {
    HIGH: "🟢",
    MEDIUM: "🟡",
    LOW: "🔴",
  };

  const lines = [
    `${icons[alert.type] ?? "📡"} *ALTSHORTBOT — ${alert.coin}*`,
    `Signal: *${alert.type.replace("_", " ")}*`,
    `Entry: $${alert.entry.toFixed(4)}`,
    `Funding: ${alert.fundingApr.toFixed(1)}% APR`,
    `Confidence: ${confIcons[alert.confidence]} ${alert.confidence}`,
    "",
    alert.details,
  ];

  if (alert.type === "EXHAUSTION" || alert.type === "TREND_BREAK") {
    if (alert.msSinceBuilding !== null) {
      const h = Math.round(alert.msSinceBuilding / HOUR);
      lines.push(`Building: ✅ ${h}h ago`);
      if (h < 4) lines.push(`⚠️ Recent building — squeeze may continue`);
    } else {
      lines.push(`Building: ⚠️ No prior building — lower confidence`);
    }
  }

  if (alert.type === "EXHAUSTION" && alert.confidence === "HIGH")
    lines.push("", `📐 Short entry — stop at -12% | target -15% to -40%`);
  if (alert.type === "BUILDING") {
    const oiRising = (alert.oiDropPct ?? 0) < BUILDING_OI_RISING_MAX;
    if (alert.fundingApr <= -200 && !oiRising) {
      lines.push("", `📐 Short entry — extreme funding squeeze (auto-queued)`);
    } else if (alert.fundingApr <= -200 && oiRising) {
      lines.push(
        "",
        `⚠️ Extreme funding but OI rising — squeeze still building (not queued)`,
      );
    } else {
      lines.push("", `⏳ Do NOT short yet — await exhaustion signal`);
    }
  }
  if (alert.type === "TREND_BREAK")
    lines.push("", `📐 Strong short — parabolic blow-off confirmed`);

  return lines.join("\n");
}

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("\n[no telegram creds]\n" + message + "\n");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      },
    );
    if (!res.ok)
      console.error(`Telegram error ${res.status}: ${await res.text()}`);
  } catch (err) {
    // Log but do not rethrow — failure is non-fatal; state still saves; scanner continues
    console.error(`Telegram send failed: ${(err as Error).message}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function getCoins(): Promise<string[]> {
  const arg = process.argv.find((_, i) => process.argv[i - 1] === "--coins");
  const env = process.env.SCANNER_COINS;
  if (arg ?? env) {
    // Explicit override — use as-is
    return (arg ?? env)!
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
  }
  // Fetch full coin universe from Bybit
  return fetchAllCoins();
}

async function main(): Promise<void> {
  const coins = await getCoins();
  const state = loadState();

  console.log(`\nAltShortBot Scanner — ${new Date().toISOString()}`);
  console.log(`Scanning ${coins.length} coin(s)...`);

  const allAlerts: Alert[] = [];

  for (const coin of coins) {
    process.stdout.write(`  ${coin}... `);
    try {
      const [candles, bbFunding, bnFunding] = await Promise.all([
        fetchCandles(coin, 500),
        fetchFundingBybit(coin),
        fetchFundingBinance(coin), // non-fatal — returns [] on error
      ]);

      if (candles.length < 50) {
        console.log("insufficient data");
        continue;
      }

      const oiHistory = await fetchOIHistory(coin, candles);
      const fundingByHour = buildMergedFundingByHour(bbFunding, bnFunding);
      const coinState = state[coin] ?? defaultState();

      const { alerts, newState } = scanCoin(
        coin,
        coinState,
        candles,
        fundingByHour,
        oiHistory,
      );
      state[coin] = newState;

      if (alerts.length) {
        console.log(
          `${alerts.length} signal(s): ${alerts.map((a) => a.type).join(", ")}`,
        );
        allAlerts.push(...alerts);
      } else {
        console.log("no signals");
      }
    } catch (err) {
      console.log(`error: ${(err as Error).message}`);
    }

    await sleep(150); // rate limit buffer
  }

  // Send alerts then save state.
  // State saves regardless of individual Telegram send success.
  for (const alert of allAlerts) {
    // FUNDING is purely informational — broad-market regimes can produce
    // hundreds per scan, drowning the chat. It never affects positions
    // (queue filter below excludes it). Still appears in PM2 logs for review.
    if (alert.type !== "FUNDING") {
      await sendTelegram(formatAlert(alert));
      await sleep(500); // Telegram rate limit
    }

    // Queue tradeable signals for the executor.
    //   • HIGH/MEDIUM EXHAUSTION & TREND_BREAK — the original tradeable set.
    //   • BUILDING with fundingApr ≤ -200% APR — validated profitable: 9/9
    //     paper-observed winners over 10d (avg +11% at 1×, ~+33% at 3×).
    //     Above -200% (e.g. -100%) entered mega-squeezes where price ran
    //     80%+ higher before reversing, so they're excluded.
    // LOW confidence stays Telegram-only — too risky for auto-execution.
    // DRY_RUN suppresses queue writes so a hand-triggered scan can't bleed into
    // the executor's pickup. Telegram still fires (above) for observability.
    if (!DRY_RUN) {
      const isExhaustionOrBreak =
        (alert.type === "EXHAUSTION" || alert.type === "TREND_BREAK") &&
        (alert.confidence === "HIGH" || alert.confidence === "MEDIUM");

      const isExtremeBuilding =
        alert.type === "BUILDING" &&
        alert.fundingApr <= -200 &&
        // Skip if OI is rising strongly — squeeze still building, not near top
        (alert.oiDropPct ?? 0) >= BUILDING_OI_RISING_MAX;

      if (isExhaustionOrBreak || isExtremeBuilding) {
        appendToQueue(alert);
      }
    }

    if (alert.type === "BUILDING") {
      // Parse squeeze % from details string e.g. "Squeeze: +20.6% over 10h | ..."
      const squeezeMatch = alert.details.match(/\+([\d.]+)%/);
      logBuildingSignal({
        coin: alert.coin,
        firedAt: new Date().toISOString(),
        firedAtMs: Date.now(),
        entry: alert.entry,
        fundingApr: alert.fundingApr,
        squeeze: squeezeMatch ? parseFloat(squeezeMatch[1]) : 0,
      });
    }
  }
  saveState(state);

  console.log(`\nDone. ${allAlerts.length} alert(s) sent.\n`);
}

async function watchMode(): Promise<void> {
  console.log("AltShortBot — watch mode (runs on the hour)");
  while (true) {
    await main();
    const now = Date.now();
    const nextHour = Math.ceil(now / HOUR) * HOUR;
    const sleepMs = nextHour - now + 5_000; // +5s past the hour
    console.log(`Next scan in ${Math.round(sleepMs / 60_000)} min`);
    await sleep(sleepMs);
  }
}

// Run only when this file is the entry point (allows scanner_test.ts to import
// scanCoin without triggering a full live scan).
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const onCrash = async (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`scanner crashed: ${msg}`);
    await sendTelegram(`🚨 *altshortbot* — scanner crashed\n\`${msg}\``);
    process.exit(1);
  };
  (process.argv.includes("--watch") ? watchMode() : main()).catch(onCrash);
}

export { buildFundingByHour, defaultState, scanCoin };
export type { CoinState };
