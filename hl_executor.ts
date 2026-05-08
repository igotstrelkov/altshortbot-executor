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
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
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

async function fetchAssetIndex(): Promise<Map<string, { idx: number; szDecimals: number; maxLeverage: number }>> {
  const { universe } = await hlPost({ type: "meta" }) as { universe: AssetMeta[] };
  const map = new Map<string, { idx: number; szDecimals: number; maxLeverage: number }>();
  universe.forEach((a, idx) => {
    if (!a.isDelisted) map.set(a.name, { idx, szDecimals: a.szDecimals, maxLeverage: a.maxLeverage });
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

// ─── Hyperliquid order execution (signed /exchange endpoint, agent key) ──────
// EIP-712 action hashing on Hyperliquid uses msgpack with strict key ordering;
// the SDK handles this. Do NOT roll signing manually.

function getExchangeClient(): ExchangeClient {
  if (!AGENT_KEY) throw new Error("HL_AGENT_KEY not set");
  const wallet = privateKeyToAccount(AGENT_KEY as `0x${string}`);
  // The agent wallet is approved via app.hyperliquid.xyz → Settings → API.
  // Hyperliquid maps agent → approver internally; no vaultAddress needed.
  return new ExchangeClient({
    transport: new HttpTransport({ isTestnet: IS_TESTNET }),
    wallet,
  });
}

// Hyperliquid perp price rules: max (6 - szDecimals) decimal places AND max 5
// significant figures. The plan's hard-coded .toFixed(4) is correct only for
// szDecimals ≤ 2 (most altcoins, ORDI etc.) — fails for szDecimals ≥ 3.
function formatPrice(price: number, szDecimals: number): string {
  const decByDp = Math.max(0, 6 - szDecimals);
  // 5-sig-fig cap only bites for price >= 1 (sub-1 prices: leading zeros after
  // decimal don't count, and sub-$0.001 coins are filtered upstream by the scanner).
  let decBySig = decByDp;
  if (price >= 1) {
    const intDigits = Math.floor(Math.log10(price)) + 1;
    decBySig = Math.max(0, 5 - intDigits);
  }
  return price.toFixed(Math.min(decByDp, decBySig));
}

function formatSize(size: number, szDecimals: number): string {
  // Size must be a multiple of 10^-szDecimals on Hyperliquid.
  return size.toFixed(szDecimals > 4 ? 4 : szDecimals);
}

async function openShort(
  assetIdx:   number,
  szDecimals: number,
  sizeCoin:   number,
  markPrice:  number,
  leverage:   number,
): Promise<number | null> {
  if (IS_PAPER) return -1;

  const client  = getExchangeClient();

  // Set leverage BEFORE the order. HL leverage is per-position-at-entry: if
  // we don't set it, HL uses whatever was last set for this asset (default
  // can be 20×). Our notional sizing is correct either way, but a higher-than-
  // expected leverage means a closer-than-expected liquidation price, which
  // could trip BEFORE our 12% stop fires. Caller must pre-clamp leverage
  // against asset.maxLeverage — HL rejects values above the asset cap.
  try {
    await client.updateLeverage({
      asset:    assetIdx,
      isCross:  true,
      leverage,
    });
  } catch (err) {
    console.error(`updateLeverage failed for asset ${assetIdx}: ${(err as Error).message}`);
    return null;  // do not open at unknown leverage
  }

  const limitPx = formatPrice(markPrice * 0.995, szDecimals);
  const sizeStr = formatSize(sizeCoin, szDecimals);

  try {
    const result = await client.order({
      orders: [{
        a: assetIdx,
        b: false,                    // false = sell (short)
        p: limitPx,
        s: sizeStr,
        r: false,                    // not reduce-only — opening new position
        t: { limit: { tif: "Ioc" } },// IOC = fill immediately or cancel
      }],
      grouping: "na",
    });
    const status = result.response.data.statuses[0];
    if (typeof status === "object" && "filled" in status) {
      // IOC may partially fill. status.filled.totalSz is the actual filled size.
      // For simplicity we proceed with the full requested size — the stop-loss
      // will be slightly oversized on a partial fill, erring toward protection.
      return status.filled.oid;
    }
    if (typeof status === "object" && "resting" in status) return status.resting.oid;
    console.error(`Order status: ${JSON.stringify(status)}`);
    return null;
  } catch (err) {
    console.error(`openShort failed: ${(err as Error).message}`);
    return null;
  }
}

async function placeStopLoss(
  assetIdx:   number,
  szDecimals: number,
  sizeCoin:   number,
  stopPx:     number,
): Promise<number | null> {
  if (IS_PAPER) return -1;

  const client  = getExchangeClient();
  const stopStr = formatPrice(stopPx, szDecimals);
  const sizeStr = formatSize(sizeCoin, szDecimals);

  try {
    const result = await client.order({
      orders: [{
        a: assetIdx,
        b: true,                     // buy to close short
        p: stopStr,
        s: sizeStr,
        r: true,                     // reduce-only
        t: {
          trigger: {
            triggerPx: stopStr,
            isMarket:  true,
            tpsl:      "sl",
          },
        },
      }],
      grouping: "na",
    });
    const status = result.response.data.statuses[0];
    if (typeof status === "object" && "resting" in status) return status.resting.oid;
    console.error(`Stop-loss status: ${JSON.stringify(status)}`);
    return null;
  } catch (err) {
    console.error(`placeStopLoss failed: ${(err as Error).message}`);
    return null;
  }
}

async function cancelOrder(assetIdx: number, oid: number): Promise<void> {
  if (IS_PAPER || oid === -1) return;
  const client = getExchangeClient();
  try {
    await client.cancel({ cancels: [{ a: assetIdx, o: oid }] });
  } catch (err) {
    console.error(`cancelOrder failed: ${(err as Error).message}`);
  }
}

async function closePosition(
  assetIdx:   number,
  szDecimals: number,
  sizeCoin:   number,
  markPx:     number,
): Promise<void> {
  if (IS_PAPER) return;

  const client  = getExchangeClient();
  const limitPx = formatPrice(markPx * 1.005, szDecimals);
  const sizeStr = formatSize(sizeCoin, szDecimals);

  try {
    await client.order({
      orders: [{
        a: assetIdx,
        b: true,                     // buy to close short
        p: limitPx,
        s: sizeStr,
        r: true,                     // reduce-only
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });
  } catch (err) {
    console.error(`closePosition failed: ${(err as Error).message}`);
  }
}

// ─── Position sizing ──────────────────────────────────────────────────────────
// Sized to risk exactly riskPerTrade of account on the stop loss.
//   We want:  notional × stopLossPct = riskUsd
//   So:       notional = riskUsd / stopLossPct
//                      = (accountValue × riskPerTrade) / stopLossPct
//
// At account=$10k, riskPerTrade=0.02, stopLossPct=0.12:
//   notional = $1,667 → loss at +12% stop = $200 = 2% of account ✓
//
// Leverage does NOT enter sizing. It only determines margin posted:
// margin = notional / leverage (e.g. $1,667 / 3 = $556). RISK.maxLeverage stays
// informational and would be used for a future margin-sufficiency check
// (margin > withdrawable → reject). This is a deliberate departure from the
// plan's `notional = marginUsed × maxLeverage`, which inflated notional by 3×
// and risked 6% per trade despite the 2% riskPerTrade label.
function calcPositionSize(
  accountValueUsdc: number,
  markPrice:        number,
  szDecimals:       number,
): number {
  const riskUsd  = accountValueUsdc * RISK.riskPerTrade;
  const notional = riskUsd / RISK.stopLossPct;
  const rawSize  = notional / markPrice;
  // Round DOWN to szDecimals precision (never up — could push notional over budget).
  const factor = Math.pow(10, szDecimals);
  return Math.floor(rawSize * factor) / factor;
}

// ─── Signal execution ────────────────────────────────────────────────────────
async function executeSignal(
  signal:       QueuedSignal,
  assetIndex:   Map<string, { idx: number; szDecimals: number; maxLeverage: number }>,
  markPrices:   Map<string, number>,
  positions:    PositionStore,
  accountValue: number,
): Promise<void> {
  const { coin, type, confidence, entry } = signal;

  // Validation guards.
  // confidence === "LOW" check is defense-in-depth — the scanner queue filter
  // already excludes LOW (Stage 1c), but a corrupted queue file could carry one.
  if (!TRADEABLE.has(type))    { console.log(`${coin}: not tradeable (${type})`); return; }
  if (confidence === "LOW")    { console.log(`${coin}: LOW confidence — skip`); return; }
  if (positions[coin])         { console.log(`${coin}: already in position`); return; }
  if (Object.keys(positions).length >= RISK.maxPositions) {
    console.log(`Max positions (${RISK.maxPositions}) reached — skip ${coin}`);
    return;
  }

  const asset = assetIndex.get(coin);
  if (!asset) { console.log(`${coin}: not listed on Hyperliquid`); return; }

  // Use mark price (current state) for sizing, not signal.entry (potentially stale
  // by up to 5 minutes between scanner write and executor pickup).
  const markPx = markPrices.get(coin) ?? entry;

  const size     = calcPositionSize(accountValue, markPx, asset.szDecimals);
  const notional = size * markPx;
  if (notional < RISK.minNotionalUsdc) {
    console.log(`${coin}: notional $${notional.toFixed(2)} below minimum $${RISK.minNotionalUsdc}`);
    return;
  }

  const stopLossPx = markPx * (1 + RISK.stopLossPct);
  const targetPx   = markPx * (1 - RISK.initialTargetPct);
  const leverage   = Math.min(RISK.maxLeverage, asset.maxLeverage);

  let stopOid: number | undefined = undefined;

  if (IS_PAPER) {
    console.log(`📝 [PAPER] Short ${coin} @ $${markPx.toFixed(4)} | size: ${size} | stop: $${stopLossPx.toFixed(4)}`);
  } else {
    const oid = await openShort(asset.idx, asset.szDecimals, size, markPx, leverage);
    if (oid === null) { console.log(`${coin}: order failed`); return; }

    stopOid = await placeStopLoss(asset.idx, asset.szDecimals, size, stopLossPx) ?? undefined;
    if (stopOid === undefined) {
      // Stop-loss failed — close immediately to avoid an unprotected short.
      await closePosition(asset.idx, asset.szDecimals, size, markPx);
      await sendTelegram(`⚠️ *${coin}* — stop-loss placement failed. Position closed for safety.`);
      return;
    }
    console.log(`✅ Short ${coin} @ $${markPx.toFixed(4)} | oid=${oid} stopOid=${stopOid} lev=${leverage}×`);
  }

  positions[coin] = {
    coin,
    openedAt:         Date.now(),
    entryPx:          markPx,
    sizeCoin:         size,
    notionalUsdc:     notional,
    stopLossPx,
    targetPx,
    trailingActive:   false,
    signalType:       type       as "EXHAUSTION" | "TREND_BREAK",
    signalConfidence: confidence as "HIGH" | "MEDIUM",
    stopOid,
    isPaper:          IS_PAPER,
  };

  await sendTelegram(
    `${IS_PAPER ? "📝 [PAPER]" : "✅"} *SHORT OPENED — ${coin}*\n` +
    `Entry: $${markPx.toFixed(4)}\n` +
    `Size: ${size} ${coin} ($${notional.toFixed(0)})\n` +
    `Stop: $${stopLossPx.toFixed(4)} (+${(RISK.stopLossPct * 100).toFixed(0)}%)\n` +
    `Target: $${targetPx.toFixed(4)} (-${(RISK.initialTargetPct * 100).toFixed(0)}%)\n` +
    `Signal: ${type} [${confidence}]`
  );
}

// Stages 8-9 will add: position management, status command, and the main loop.
