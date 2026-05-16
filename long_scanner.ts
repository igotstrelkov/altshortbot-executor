/**
 * long_scanner.ts — Long Bot Signal Scanner
 * ==========================================
 * Runs every 15 minutes. Scans all active Bybit USDT perps for positive
 * funding + OI divergence setups and writes signals to long_queue.json.
 *
 * Signal: funding > +200% APR + OI rising > +2%/4h + price flat < 2%/2h
 * This is the Gate 2 logic from backtest_longs.ts validated on 6 signals
 * at threshold=200%: 50% win rate, avg +7.17% (+21.50% at 3x), 0 stop-outs.
 *
 * Run:
 *   npx tsx long_scanner.ts --dry-run    ← detect signals, no queue write
 *   npx tsx long_scanner.ts              ← normal run
 *
 * PM2: altshortbot-long-scanner (cron every 15 minutes)
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const DRY_RUN    = process.argv.includes("--dry-run");
const COINS_ARG  = process.argv.find((_, i) => process.argv[i - 1] === "--coins");
const COINS_ONLY = COINS_ARG ? COINS_ARG.split(",").map(c => c.trim().toUpperCase()) : null;

const PARAMS = {
  fundingAprThreshold:  200,   // min positive funding APR (validated: 200% best)
  minPositiveReadings:  2,     // min positive funding readings in last 8h
  minOiChangePct:       2,     // min OI rise % in 4h window
  maxPriceChangePct:    2,     // max price change % in 2h (entry when price flat)
  cooldownH:            4,     // hours between signals for the same coin
} as const;

const LONG_QUEUE_FILE  = "long_queue.json";
const LONG_STATE_FILE  = "long_scanner_state.json";
const BB_BASE          = "https://api.bybit.com";
const HOUR             = 3_600_000;

// ─── Types ─────────────────────────────────────────────────────────────────────
interface QueuedLongSignal {
  coin:        string;
  type:        "LONG_MOMENTUM";
  firedAt:     number;
  firedAtStr:  string;
  entry:       number;
  fundingApr:  number;
  oiChange4h:  number;
  confidence:  "HIGH" | "MEDIUM";
  queuedAt:    number;
}

interface LongScannerState {
  [coin: string]: {
    lastSignalMs: number;
  };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { console.log("[no telegram creds]", msg); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }),
    });
  } catch { /* non-fatal */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep   = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const floorH  = (ms: number) => Math.floor(ms / HOUR) * HOUR;

async function fetchJSON(url: string, retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

// ─── State ─────────────────────────────────────────────────────────────────────
function loadState(): LongScannerState {
  if (!existsSync(LONG_STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(LONG_STATE_FILE, "utf8")); } catch { return {}; }
}

function saveState(state: LongScannerState): void {
  writeFileSync(LONG_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ─── Queue ─────────────────────────────────────────────────────────────────────
function loadQueue(): QueuedLongSignal[] {
  if (!existsSync(LONG_QUEUE_FILE)) return [];
  try { return JSON.parse(readFileSync(LONG_QUEUE_FILE, "utf8")); } catch { return []; }
}

function appendQueue(signal: QueuedLongSignal): void {
  const queue = loadQueue();
  queue.push(signal);
  writeFileSync(LONG_QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
}

// ─── Data fetchers ─────────────────────────────────────────────────────────────
async function fetchAllCoins(): Promise<string[]> {
  const data = await fetchJSON(
    `${BB_BASE}/v5/market/instruments-info?category=linear&status=Trading&limit=1000`
  ) as { result?: { list?: { symbol: string }[] } };
  return (data.result?.list ?? [])
    .map(x => x.symbol)
    .filter(s => s.endsWith("USDT"))
    .map(s => s.replace("USDT", ""));
}

async function fetchTicker(coin: string): Promise<{
  lastPrice: number; fundingRate: number; openInterest: number;
} | null> {
  try {
    const data = await fetchJSON(
      `${BB_BASE}/v5/market/tickers?category=linear&symbol=${coin}USDT`
    ) as { result?: { list?: { lastPrice: string; fundingRate: string; openInterestValue: string }[] } };
    const t = data.result?.list?.[0];
    if (!t) return null;
    return {
      lastPrice:    parseFloat(t.lastPrice),
      fundingRate:  parseFloat(t.fundingRate),
      openInterest: parseFloat(t.openInterestValue),
    };
  } catch { return null; }
}

async function fetchFundingHistory(coin: string, startMs: number): Promise<
  { timeMs: number; ratePerHour: number }[]
> {
  try {
    // Fetch instrument info for funding interval
    let intervalHours = 8.0;
    const info = await fetchJSON(
      `${BB_BASE}/v5/market/instruments-info?category=linear&symbol=${coin}USDT`
    ) as { result?: { list?: { fundingInterval: number }[] } };
    const interval = info.result?.list?.[0]?.fundingInterval;
    if (interval) intervalHours = interval / 60;

    const data = await fetchJSON(
      `${BB_BASE}/v5/market/funding/history?category=linear&symbol=${coin}USDT` +
      `&startTime=${startMs}&limit=50`
    ) as { result?: { list?: { fundingRateTimestamp: string; fundingRate: string }[] } };
    return (data.result?.list ?? [])
      .map(r => ({
        timeMs:      Number(r.fundingRateTimestamp),
        ratePerHour: parseFloat(r.fundingRate) / intervalHours,
      }))
      .sort((a, b) => a.timeMs - b.timeMs);
  } catch { return []; }
}

async function fetchOIHistory(coin: string, startMs: number): Promise<
  { timeMs: number; oiUsd: number }[]
> {
  try {
    const data = await fetchJSON(
      `${BB_BASE}/v5/market/open-interest?category=linear&symbol=${coin}USDT` +
      `&intervalTime=1h&startTime=${startMs}&limit=8`
    ) as { result?: { list?: { timestamp: string; openInterest: string }[] } };
    return (data.result?.list ?? [])
      .map(r => ({ timeMs: Number(r.timestamp), oiUsd: parseFloat(r.openInterest) }))
      .sort((a, b) => a.timeMs - b.timeMs);
  } catch { return []; }
}

// ─── Signal detection ──────────────────────────────────────────────────────────
async function scanCoin(
  coin: string,
  nowMs: number,
): Promise<QueuedLongSignal | null> {
  const ticker = await fetchTicker(coin);
  if (!ticker) return null;

  const { lastPrice, fundingRate, openInterest } = ticker;
  const fundingApr = fundingRate * 3 * 365 * 100;   // annualise

  // Fast reject: funding must be above threshold
  if (fundingApr < PARAMS.fundingAprThreshold) return null;

  // Fetch 8h of funding history for Gate 1 positivity check
  const fundingHistory = await fetchFundingHistory(coin, nowMs - 10 * HOUR);
  if (fundingHistory.length < 2) return null;

  // Gate 1: MIN_POSITIVE of last 8 readings must be positive
  const last8 = fundingHistory.slice(-8);
  const positiveCount = last8.filter(r => r.ratePerHour > 0).length;
  if (positiveCount < PARAMS.minPositiveReadings) return null;

  // Gate 2: OI must be rising > minOiChangePct in last 4h
  const oiHistory = await fetchOIHistory(coin, nowMs - 6 * HOUR);
  if (oiHistory.length < 4) return null;

  // Price-adjust OI (Bybit OI in coin units)
  const oiUsd = (oi: number) => oi * lastPrice;
  const oiNow  = (oiUsd(oiHistory[oiHistory.length - 1].oiUsd) + oiUsd(oiHistory[oiHistory.length - 2]?.oiUsd ?? 0)) / 2;
  const oi4h   = (oiUsd(oiHistory[1]?.oiUsd ?? 0) + oiUsd(oiHistory[0]?.oiUsd ?? 0)) / 2;
  if (!oi4h) return null;

  const oiChange4h = ((oiNow - oi4h) / oi4h) * 100;
  if (oiChange4h < PARAMS.minOiChangePct) return null;

  // Price must be flat (not already extended)
  const candles = await fetchJSON(
    `${BB_BASE}/v5/market/kline?category=linear&symbol=${coin}USDT&interval=60&limit=4`
  ) as { result?: { list?: string[][] } };
  const cl = candles.result?.list ?? [];
  if (cl.length < 3) return null;
  const priceNow  = parseFloat(cl[0][4]);
  const price2h   = parseFloat(cl[2][4]);
  const pxChange2h = Math.abs((priceNow - price2h) / price2h * 100);
  if (pxChange2h >= PARAMS.maxPriceChangePct) return null;

  // Confidence based on funding strength
  const confidence: "HIGH" | "MEDIUM" = fundingApr >= 500 ? "HIGH" : "MEDIUM";

  const firedAtStr = new Date(nowMs).toISOString().slice(0, 16).replace("T", " ");
  return {
    coin,
    type:        "LONG_MOMENTUM",
    firedAt:     nowMs,
    firedAtStr,
    entry:       lastPrice,
    fundingApr,
    oiChange4h,
    confidence,
    queuedAt:    Date.now(),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const nowMs = Date.now();
  console.log(`\nAltShortBot Long Scanner — ${new Date(nowMs).toISOString()}`);
  if (DRY_RUN) console.log("Mode: DRY RUN (no queue writes)\n");

  const state = loadState();
  const coins = COINS_ONLY ?? await fetchAllCoins();
  console.log(`Scanning ${coins.length} coin(s)...`);

  let alertCount = 0;

  for (const coin of coins) {
    // Cooldown check
    const lastSignal = state[coin]?.lastSignalMs ?? 0;
    if (nowMs - lastSignal < PARAMS.cooldownH * HOUR) continue;

    const signal = await scanCoin(coin, nowMs);
    if (!signal) { await sleep(100); continue; }

    console.log(`\n  📈 ${coin}: funding +${signal.fundingApr.toFixed(0)}% APR | OI +${signal.oiChange4h.toFixed(1)}%/4h`);

    const confidenceIcon = signal.confidence === "HIGH" ? "🟢 HIGH" : "🟡 MEDIUM";
    const msg = (
      `📈 *ALTSHORTBOT LONG — ${coin}*\n` +
      `Signal: *LONG_MOMENTUM*\n` +
      `Entry: $${signal.entry.toFixed(6)}\n` +
      `Funding: +${signal.fundingApr.toFixed(0)}% APR\n` +
      `OI Rise: +${signal.oiChange4h.toFixed(1)}%/4h\n` +
      `Confidence: ${confidenceIcon}\n` +
      `${DRY_RUN ? "⚠️ DRY RUN — not queued" : "🚀 Long entry — funding momentum (auto-queued)"}`
    );

    await sendTelegram(msg);

    if (!DRY_RUN) {
      appendQueue(signal);
      state[coin] = { lastSignalMs: nowMs };
    }

    alertCount++;
    await sleep(200);
  }

  if (!DRY_RUN) saveState(state);

  console.log(`\nDone. ${alertCount} long signal(s) sent.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
