/**
 * AltShortBot Hyperliquid Executor
 * =================================
 * Reads signal_queue.json written by live_scanner.ts.
 * In --paper mode: simulates trades and tracks P&L.
 * In live mode: places real short orders on Hyperliquid.
 *
 * Run every 5 minutes via PM2 cron_restart.
 *
 * Usage:
 *   npx tsx hl_executor.ts --paper    ← simulate trades (safe, start here)
 *   npx tsx hl_executor.ts            ← live trading (real money)
 *   npx tsx hl_executor.ts --status   ← print open positions and P&L
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import type {
  QueuedSignal,
  PositionStore,
  PaperTrade,
} from "./shared_types.ts";

// ─── Mode and config ──────────────────────────────────────────────────────────
const IS_PAPER   = process.argv.includes("--paper");
const IS_STATUS  = process.argv.includes("--status");
const IS_TESTNET = process.env.HL_TESTNET === "1";

const API_URL = IS_TESTNET
  ? "https://api.hyperliquid-testnet.xyz"
  : "https://api.hyperliquid.xyz";

const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS ?? "";
const AGENT_KEY      = process.env.HL_AGENT_KEY      ?? "";

const QUEUE_FILE     = "signal_queue.json";
const POSITIONS_FILE = "hl_positions.json";
const PAPER_LOG_FILE = "paper_trades.jsonl";  // one JSON object per line

// Risk parameters — tune before going live
const RISK = {
  riskPerTrade:     0.02,   // 2% account per trade
  stopLossPct:      0.12,   // stop at +12% adverse (price rises 12%)
  initialTargetPct: 0.20,   // initial take-profit at -20%
  trailingStopPct:  0.05,   // trail stop by 5% once in profit
  breakevenAtPct:   0.10,   // move stop to breakeven after -10% move
  maxHoldHours:     72,     // force-close after 3 days
  maxLeverage:      3,
  maxPositions:     3,      // never hold >3 simultaneous shorts
  minNotionalUsdc:  10,     // minimum $10 per trade
} as const;

// These signals are traded. Others are Telegram-only.
const TRADEABLE = new Set(["EXHAUSTION", "TREND_BREAK"]);

// ─── State persistence ────────────────────────────────────────────────────────
function loadQueue(): QueuedSignal[] {
  if (!existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(readFileSync(QUEUE_FILE, "utf8")); }
  catch { return []; }
}

function clearQueue(): void {
  writeFileSync(QUEUE_FILE, "[]", "utf8");
}

function loadPositions(): PositionStore {
  if (!existsSync(POSITIONS_FILE)) return {};
  try { return JSON.parse(readFileSync(POSITIONS_FILE, "utf8")); }
  catch { return {}; }
}

function savePositions(store: PositionStore): void {
  writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2), "utf8");
}

function logPaperTrade(trade: PaperTrade): void {
  appendFileSync(PAPER_LOG_FILE, JSON.stringify(trade) + "\n", "utf8");
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[No Telegram]\n" + message);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error(`Telegram failed: ${(err as Error).message}`);
  }
}

// ─── Hyperliquid data fetching (read-only /info endpoint, no auth) ───────────
async function hlPost(body: object): Promise<unknown> {
  const res = await fetch(`${API_URL}/info`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}`);
  return res.json();
}

interface AssetMeta {
  name:        string;
  szDecimals:  number;
  maxLeverage: number;
  isDelisted?: boolean;
}

async function fetchAssetIndex(): Promise<Map<string, { idx: number; szDecimals: number }>> {
  const { universe } = await hlPost({ type: "meta" }) as { universe: AssetMeta[] };
  const map = new Map<string, { idx: number; szDecimals: number }>();
  universe.forEach((a, idx) => {
    if (!a.isDelisted) map.set(a.name, { idx, szDecimals: a.szDecimals });
  });
  return map;
}

interface HLPosition {
  position: {
    coin:          string;
    szi:           string;   // negative = short
    entryPx:       string;
    liquidationPx: string;
    unrealizedPnl: string;
    marginUsed:    string;
  };
}

interface AccountState {
  assetPositions: HLPosition[];
  marginSummary:  { accountValue: string; totalMarginUsed: string };
  withdrawable:   string;
}

async function fetchAccountState(): Promise<AccountState> {
  if (!WALLET_ADDRESS) throw new Error("HL_WALLET_ADDRESS not set");
  return await hlPost({ type: "clearinghouseState", user: WALLET_ADDRESS }) as AccountState;
}

async function fetchMarkPrices(): Promise<Map<string, number>> {
  const [meta, ctxs] = await hlPost({ type: "metaAndAssetCtxs" }) as [
    { universe: { name: string }[] },
    { markPx: string }[],
  ];
  const map = new Map<string, number>();
  meta.universe.forEach((a, i) => map.set(a.name, parseFloat(ctxs[i]?.markPx ?? "0")));
  return map;
}

// Stages 5-9 will add: order execution, position sizing, signal execution,
// position management, status command, and the main loop. Until then the
// constants, state helpers, and HL fetchers above are intentionally unused.
