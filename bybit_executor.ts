/**
 * AltShortBot Bybit Executor
 * ==========================
 * Runs every 5 minutes via PM2 cron. Reads signal_queue.json, opens shorts
 * on Bybit USDT perpetuals, manages open positions (stop loss, 48h timeout).
 *
 * Why Bybit instead of Hyperliquid:
 *   Scanner detects squeezes on Bybit USDT perps. Only ~14% of signals were
 *   listed on Hyperliquid — all signals are executable on Bybit.
 *
 * Modes:
 *   --paper    Simulate trades (no orders). Uses live Bybit prices for P&L.
 *   --status   Print open positions and P&L, then exit.
 *
 * Environment:
 *   BYBIT_API_KEY          API key (not needed in paper mode)
 *   BYBIT_API_SECRET       API secret (not needed in paper mode)
 *   BYBIT_TESTNET=1        Use testnet (api-testnet.bybit.com)
 *   BYBIT_PAPER_ACCOUNT    Paper account size in USDT (default: 10000)
 *
 * Run:
 *   npx tsx bybit_executor.ts --paper    ← paper mode (safe)
 *   npx tsx bybit_executor.ts --status   ← check positions
 *   npx tsx bybit_executor.ts            ← LIVE — real orders
 */

import { RestClientV5 } from "bybit-api";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import type {
  PaperTrade,
  PositionRecord,
  PositionStore,
  QueuedSignal,
} from "./shared_types.ts";

// ─── Config ───────────────────────────────────────────────────────────────────
const IS_PAPER = process.argv.includes("--paper");
const IS_STATUS = process.argv.includes("--status");
const IS_TESTNET = process.env.BYBIT_TESTNET === "1";

const BYBIT_API_KEY = process.env.BYBIT_API_KEY ?? "";
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET ?? "";
const PAPER_ACCOUNT = parseFloat(process.env.BYBIT_PAPER_ACCOUNT ?? "10000");

const RISK = {
  maxLeverage: 3,
  riskPerTrade: 0.03,
  stopLossPct: 0.15, // ← was 0.20
  maxPositions: 10,
  timeoutH: 24,
  // Re-entry cooldown: after a coin stops out, do not re-short it for this many
  // hours. Drawdown insurance — halves bad-regime drawdown in the universe sim
  // by not re-stacking into a still-squeezing coin. Costs some return in benign
  // regimes (a deliberate risk trade). Kept in sync with the KuCoin executor.
  reentryCooldownH: 24,
} as const;

// Coins never traded regardless of signal. H is mid-redenomination and prices
// chaotically across venues (Bybit/KuCoin ~2× apart) — junk signals. Kept in
// sync with the KuCoin executor's exclude list.
const EXCLUDE_COINS = new Set(["H"]);

// Funding ceiling: never trade BUILDING beyond this carry extreme (mega-squeeze
// trap — net loser after funding). Kept in sync with live_scanner and
// kucoin_executor MAX_EXTREME_FUNDING_APR. See HISTORY.md → Funding ceiling.
const MAX_EXTREME_FUNDING_APR = -2000;

// Staleness guard: the scanner and this executor are both on Bybit, so this
// catches a price that ran away between the scan and execution (the signal's
// `entry` no longer describes the live market). Same threshold as the KuCoin
// executor's venue-agreement guard.
const MAX_SIGNAL_DIVERGENCE = 0.15; // 15%

const QUEUE_FILE = "signal_queue.json";
const POSITIONS_FILE = "bybit_positions.json";
const BB_BASE = "https://api.bybit.com";

// ─── Bybit REST client ────────────────────────────────────────────────────────
const client = new RestClientV5({
  key: BYBIT_API_KEY,
  secret: BYBIT_API_SECRET,
  testnet: false,
  demoTrading: true, // new flag
});

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID ?? "";

async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_GROUP_ID) {
    console.log("[telegram]", msg);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_GROUP_ID,
        text: msg,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    /* non-fatal */
  }
}

async function alertError(ctx: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ERROR] ${ctx}: ${msg}`);
  await sendTelegram(`🚨 *altshortbot* — ${ctx}\n\`${msg}\``);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJSON(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

/** Round qty to lotSizeFilter.qtyStep precision */
function formatQty(qty: number, qtyStep: string): string {
  const step = parseFloat(qtyStep);
  const decimals = (qtyStep.split(".")[1] ?? "").length;
  const rounded = Math.floor(qty / step) * step;
  return rounded.toFixed(decimals);
}

/** Round price to priceFilter.tickSize precision */
function formatPrice(price: number, tickSize: string): string {
  const step = parseFloat(tickSize);
  const decimals = (tickSize.split(".")[1] ?? "").length;
  const rounded = Math.round(price / step) * step;
  return rounded.toFixed(decimals);
}

// ─── Instrument info cache ─────────────────────────────────────────────────────
interface InstrumentInfo {
  tickSize: string;
  qtyStep: string;
  minQty: string;
  maxLev: number;
}

const instrCache = new Map<string, InstrumentInfo>();

async function fetchInstrumentInfo(
  coin: string,
): Promise<InstrumentInfo | null> {
  if (instrCache.has(coin)) return instrCache.get(coin)!;
  try {
    const raw = (await fetchJSON(
      `${BB_BASE}/v5/market/instruments-info?category=linear&symbol=${coin}USDT`,
    )) as { result?: { list?: any[] } };
    const info = raw?.result?.list?.[0];
    if (!info) return null;
    const result: InstrumentInfo = {
      tickSize: info.priceFilter?.tickSize ?? "0.0001",
      qtyStep: info.lotSizeFilter?.qtyStep ?? "1",
      minQty: info.lotSizeFilter?.minOrderQty ?? "1",
      maxLev: parseFloat(info.leverageFilter?.maxLeverage ?? "10"),
    };
    instrCache.set(coin, result);
    return result;
  } catch (e) {
    console.error(`fetchInstrumentInfo(${coin}): ${(e as Error).message}`);
    return null;
  }
}

async function fetchCurrentPrice(coin: string): Promise<number | null> {
  try {
    const raw = (await fetchJSON(
      `${BB_BASE}/v5/market/tickers?category=linear&symbol=${coin}USDT`,
    )) as { result?: { list?: { lastPrice: string }[] } };
    const price = raw?.result?.list?.[0]?.lastPrice;
    return price ? parseFloat(price) : null;
  } catch {
    return null;
  }
}

// ─── Position state ────────────────────────────────────────────────────────────
interface BybitPositionStore {
  open: PositionStore;
  closed: PaperTrade[];
  paperEquityUsdt: number;
}

function loadPositions(): BybitPositionStore {
  if (!existsSync(POSITIONS_FILE)) {
    return { open: {}, closed: [], paperEquityUsdt: PAPER_ACCOUNT };
  }
  try {
    return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
  } catch {
    return { open: {}, closed: [], paperEquityUsdt: PAPER_ACCOUNT };
  }
}

function savePositions(store: BybitPositionStore): void {
  writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2), "utf8");
}

// ─── Signal queue ──────────────────────────────────────────────────────────────
function loadQueue(): QueuedSignal[] {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function clearQueue(): void {
  writeFileSync(QUEUE_FILE, "[]", "utf8");
}

// ─── Account state ─────────────────────────────────────────────────────────────
async function fetchAccountEquity(): Promise<number | null> {
  if (IS_PAPER) return null;
  try {
    const res = await client.getWalletBalance({
      accountType: "UNIFIED",
      coin: "USDT",
    });
    const coin = res.result?.list?.[0]?.coin?.find(
      (c: any) => c.coin === "USDT",
    );
    return coin ? parseFloat(coin.equity) : null;
  } catch (e) {
    await alertError("fetchAccountEquity", e);
    return null;
  }
}

// ─── Trading functions ─────────────────────────────────────────────────────────

/** Set leverage — must be called before every entry */
async function setLeverage(
  coin: string,
  leverage: number,
  maxLev: number,
): Promise<boolean> {
  if (IS_PAPER) return true;
  const lev = String(Math.min(leverage, maxLev));
  try {
    await client.setLeverage({
      category: "linear",
      symbol: `${coin}USDT`,
      buyLeverage: lev,
      sellLeverage: lev,
    });
    return true;
  } catch (e) {
    // Bybit returns error if leverage is already set to the same value — treat as OK
    const msg = (e as Error).message ?? "";
    if (msg.includes("leverage not modified")) return true;
    await alertError(`setLeverage(${coin})`, e);
    return false;
  }
}

interface OpenResult {
  orderId: string;
  fillPx: number; // actual average fill price (signal px in paper / on fallback)
  stopPx: number; // stop actually set, derived from fillPx
}

/**
 * Open a short, then attach a stop anchored to the ACTUAL fill price.
 * The market order is submitted WITHOUT an inline stop: a market order can fill
 * far from the scanner's signal price when the market moved between scan and
 * execution, and anchoring the stop to the stale signal price can place it
 * beyond the liquidation point so it never fires. We read the real avg fill
 * from the position and set the stop from THAT. If the fill can't be read or
 * the stop is rejected, the entry is immediately closed rather than left
 * running unprotected. Returns null on entry failure or the close-on-
 * unprotected path.
 */
async function openShort(
  coin: string,
  price: number, // signal entry price — used only for sizing & fallback
  notional: number,
  leverage: number,
  instr: InstrumentInfo,
): Promise<OpenResult | null> {
  if (IS_PAPER) {
    return {
      orderId: "PAPER",
      fillPx: price,
      stopPx: price * (1 + RISK.stopLossPct),
    };
  }

  const qty = notional / price;
  const qtyStr = formatQty(qty, instr.qtyStep);

  if (parseFloat(qtyStr) < parseFloat(instr.minQty)) {
    console.log(
      `  ${coin}: qty ${qtyStr} below minQty ${instr.minQty} — skipping`,
    );
    return null;
  }

  try {
    // 1) Market entry — no inline stop; the stop must anchor to the fill.
    const res = await client.submitOrder({
      category: "linear",
      symbol: `${coin}USDT`,
      side: "Sell",
      orderType: "Market",
      qty: qtyStr,
      positionIdx: 0, // one-way mode
    });
    if (res.retCode !== 0) {
      await alertError(
        `openShort(${coin})`,
        `retCode ${res.retCode}: ${res.retMsg}`,
      );
      return null;
    }
    const orderId = res.result?.orderId ?? null;

    // 2) Resolve the ACTUAL average fill price from the position.
    const avgPx = await fetchPositionEntry(coin);
    if (avgPx === null) {
      // Without the real fill we cannot place a correct stop. Rather than run a
      // leveraged short on a stale-price (or no) stop, close the entry now.
      await alertError(
        `openShort(${coin}) — could not read fill price; closing the entry ` +
          `to avoid an unprotected position, verify flat on app.bybit.com`,
        "getPositionInfo returned no avgPrice",
      );
      await closePosition(coin, "unprotected — fill price unreadable");
      return null;
    }
    const fillPx = avgPx;
    const stopPx = fillPx * (1 + RISK.stopLossPct);

    // 3) Attach the stop, anchored to the fill. A short's stop sits ABOVE entry.
    const stopStr = formatPrice(stopPx, instr.tickSize);
    const slRes = await client.setTradingStop({
      category: "linear",
      symbol: `${coin}USDT`,
      stopLoss: stopStr,
      slTriggerBy: "MarkPrice",
      tpslMode: "Full",
      positionIdx: 0,
    });
    if (slRes.retCode !== 0) {
      // Entry succeeded but the stop did not — do NOT run unprotected. Close it.
      await alertError(
        `openShort(${coin}) STOP REJECTED — closing the entry to avoid an ` +
          `unprotected position, verify flat on app.bybit.com`,
        `retCode ${slRes.retCode}: ${slRes.retMsg}`,
      );
      await closePosition(coin, "unprotected — stop rejected");
      return null;
    }
    return { orderId: orderId ?? "", fillPx, stopPx };
  } catch (e) {
    await alertError(`openShort(${coin})`, e);
    return null;
  }
}

/** Close an open position at market */
async function closePosition(coin: string, reason: string): Promise<boolean> {
  if (IS_PAPER) return true;
  try {
    const res = await client.submitOrder({
      category: "linear",
      symbol: `${coin}USDT`,
      side: "Buy",
      orderType: "Market",
      qty: "0",
      reduceOnly: true,
      closeOnTrigger: true,
      positionIdx: 0,
    });
    if (res.retCode !== 0) {
      await alertError(
        `closePosition(${coin}) — ${reason}`,
        `retCode ${res.retCode}: ${res.retMsg} — verify on app.bybit.com`,
      );
      return false;
    }
    return true;
  } catch (e) {
    await alertError(
      `closePosition(${coin}) — ${reason} — verify on app.bybit.com`,
      e,
    );
    return false;
  }
}

/** Fetch the live position size from Bybit (0 = closed / never opened) */
async function fetchLivePositionSize(coin: string): Promise<number> {
  if (IS_PAPER) return -1; // -1 = paper, caller handles
  try {
    const res = await client.getPositionInfo({
      category: "linear",
      symbol: `${coin}USDT`,
    });
    const pos = res.result?.list?.[0];
    return pos ? parseFloat(pos.size ?? "0") : 0;
  } catch {
    return -1;
  } // -1 = unknown, don't close
}

/**
 * Average entry price of the freshly-opened position (null if unreadable).
 * Polls a few times because the position can take a moment to reflect after a
 * market order fills. The stop and all P&L must anchor to this, not the signal
 * price — see openShort.
 */
async function fetchPositionEntry(coin: string): Promise<number | null> {
  if (IS_PAPER) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await client.getPositionInfo({
        category: "linear",
        symbol: `${coin}USDT`,
      });
      const pos = res.result?.list?.[0];
      const px = pos ? parseFloat(pos.avgPrice ?? "0") : 0;
      if (Number.isFinite(px) && px > 0) return px;
    } catch {
      /* transient — retry */
    }
    await sleep(300);
  }
  return null;
}

// ─── Position management ───────────────────────────────────────────────────────
async function managePositions(store: BybitPositionStore): Promise<void> {
  const nowMs = Date.now();

  for (const [coin, pos] of Object.entries(store.open)) {
    const ageH = (nowMs - pos.openedAt) / 3_600_000;
    const currentPx = await fetchCurrentPrice(coin);

    if (currentPx === null) {
      console.log(`  ${coin}: could not fetch price — skipping`);
      continue;
    }

    const pnlPct = ((pos.entryPx - currentPx) / pos.entryPx) * 100;

    // Check if stop was hit (live: position closed by exchange)
    let stopHit = false;
    if (!IS_PAPER) {
      const liveSize = await fetchLivePositionSize(coin);
      if (liveSize === 0) stopHit = true;
    } else {
      stopHit = currentPx >= pos.stopLossPx;
    }

    let closeReason: PaperTrade["closeReason"] | null = null;
    let closePx = currentPx;

    if (stopHit) {
      closeReason = "stop";
      closePx = IS_PAPER ? pos.stopLossPx : currentPx;
    } else if (ageH >= RISK.timeoutH) {
      closeReason = "timeout";
      if (!IS_PAPER) await closePosition(coin, "timeout");
    }

    if (closeReason) {
      const finalPnlPct = ((pos.entryPx - closePx) / pos.entryPx) * 100;
      const finalPnlUsdt = (finalPnlPct / 100) * pos.notionalUsdc;

      const trade: PaperTrade = {
        coin,
        openedAt: pos.openedAt,
        closedAt: nowMs,
        entryPx: pos.entryPx,
        exitPx: closePx,
        sizeCoin: pos.sizeCoin,
        pnlUsdc: finalPnlUsdt,
        pnlPct: finalPnlPct,
        closeReason,
        signalType: pos.signalType,
        confidence: pos.signalConfidence,
      };
      store.closed.push(trade);

      if (IS_PAPER) store.paperEquityUsdt += finalPnlUsdt;

      delete store.open[coin];

      const icon = finalPnlPct > 0 ? "✅" : "❌";
      const mode = IS_PAPER ? "📄 " : "";
      await sendTelegram(
        `${mode}${icon} *${coin}* closed (${closeReason})\n` +
          `Entry: $${pos.entryPx.toFixed(6)} → Exit: $${closePx.toFixed(6)}\n` +
          `P&L: ${finalPnlPct.toFixed(2)}% | USDT: ${finalPnlUsdt.toFixed(2)}`,
      );
      console.log(
        `  ${coin}: closed (${closeReason}) ${finalPnlPct.toFixed(2)}% — $${finalPnlUsdt.toFixed(2)}`,
      );
    } else {
      console.log(
        `  ${coin}: open ${ageH.toFixed(1)}h — px $${currentPx.toFixed(6)} — ${pnlPct.toFixed(2)}%`,
      );
    }
  }
}

// ─── Signal execution ──────────────────────────────────────────────────────────
async function executeSignal(
  sig: QueuedSignal,
  store: BybitPositionStore,
  equity: number,
): Promise<void> {
  const { coin, type: signalType, confidence, entry, fundingApr } = sig;

  // Skip if already have a position in this coin
  if (store.open[coin]) {
    console.log(`  ${coin}: already open — skipping`);
    return;
  }

  // Hard exclude (e.g. H — redenomination chaos). Never trade these.
  if (EXCLUDE_COINS.has(coin)) {
    console.log(`  ${coin}: on executor exclude list — skipping`);
    return;
  }

  // Funding ceiling: BUILDING beyond -2000% APR is a net loser after carry.
  if (signalType === "BUILDING" && fundingApr <= MAX_EXTREME_FUNDING_APR) {
    console.log(
      `  ${coin}: BUILDING funding ${fundingApr.toFixed(0)}% ≤ ${MAX_EXTREME_FUNDING_APR}% ceiling — skipping (mega-squeeze trap)`,
    );
    return;
  }

  // Re-entry cooldown: do not re-short a coin that stopped out within the last
  // reentryCooldownH. Re-stacking into a still-squeezing coin is a net loser;
  // blocking it is drawdown insurance.
  const lastStopAt = store.closed.reduce(
    (max, t) =>
      t.coin === coin && t.closeReason === "stop" && t.closedAt > max
        ? t.closedAt
        : max,
    0,
  );
  if (
    lastStopAt > 0 &&
    Date.now() - lastStopAt < RISK.reentryCooldownH * 3_600_000
  ) {
    const hSince = ((Date.now() - lastStopAt) / 3_600_000).toFixed(1);
    console.log(
      `  ${coin}: stopped out ${hSince}h ago (< ${RISK.reentryCooldownH}h cooldown) — skipping`,
    );
    return;
  }

  // Fetch instrument info — needed for precision and max leverage
  const instr = await fetchInstrumentInfo(coin);
  if (!instr) {
    console.log(
      `  ${coin}: not listed on Bybit or instrument info unavailable — skipping`,
    );
    return;
  }

  // Staleness guard. Confirm the live price still agrees with the signal's
  // `entry` before trading — a large divergence means the price ran away since
  // the scan and the signal no longer describes the live market.
  const livePx = await fetchCurrentPrice(coin);
  if (livePx === null) {
    console.log(`  ${coin}: could not fetch live price — skipping`);
    return;
  }
  const divergence = Math.abs(livePx - entry) / entry;
  if (divergence > MAX_SIGNAL_DIVERGENCE) {
    const pctStr = (divergence * 100).toFixed(0);
    console.log(
      `  ${coin}: signal $${entry.toFixed(6)} vs live $${livePx.toFixed(6)} ` +
        `diverge ${pctStr}% (> ${(MAX_SIGNAL_DIVERGENCE * 100).toFixed(0)}%) — skipping`,
    );
    await sendTelegram(
      `⚠️ *${coin}* skipped — signal $${entry.toFixed(6)} vs live $${livePx.toFixed(6)} ` +
        `diverge ${pctStr}% (stale signal)`,
    );
    return;
  }

  const leverage = Math.min(RISK.maxLeverage, instr.maxLev);
  const riskUsdt = equity * RISK.riskPerTrade;
  const notional = riskUsdt / RISK.stopLossPct;

  // Set leverage before entry
  const levOk = await setLeverage(coin, leverage, instr.maxLev);
  if (!levOk) {
    console.log(`  ${coin}: setLeverage failed — skipping`);
    return;
  }

  const opened = await openShort(coin, entry, notional, leverage, instr);
  if (!opened) return;
  const { fillPx, stopPx } = opened;

  // Anchor ALL bookkeeping to the actual fill price, not the signal price —
  // entryPx, stop and notional are meaningless if the fill diverged.
  const sizeCoin = notional / entry; // coins ordered (sized off signal price)
  const notionalUsdt = sizeCoin * fillPx; // actual USDT notional at the fill
  const record: PositionRecord = {
    coin,
    openedAt: Date.now(),
    entryPx: fillPx,
    sizeCoin,
    notionalUsdc: notionalUsdt,
    stopLossPx: stopPx,
    targetPx: fillPx * 0.75, // 25% target (informational)
    trailingActive: false,
    signalType: signalType as PositionRecord["signalType"],
    signalConfidence: confidence as PositionRecord["signalConfidence"],
    isPaper: IS_PAPER,
    ...(opened.orderId !== "PAPER" ? { stopOid: undefined } : {}),
  };

  store.open[coin] = record;

  // Flag a large gap between signal price and actual fill — the exact condition
  // that, before fill-anchored stops, placed the stop beyond liquidation.
  const slipPct = ((fillPx - entry) / entry) * 100;
  const slipNote =
    Math.abs(slipPct) > 5
      ? `\nℹ️ fill ${slipPct >= 0 ? "+" : ""}${slipPct.toFixed(1)}% vs signal $${entry.toFixed(6)}`
      : "";

  const mode = IS_PAPER ? "📄 " : "";
  await sendTelegram(
    `${mode}📉 *${coin}* SHORT opened\n` +
      `Entry: $${fillPx.toFixed(6)} | Stop: $${stopPx.toFixed(6)}\n` +
      `Signal: ${signalType} (${confidence}) | Funding: ${fundingApr.toFixed(0)}% APR\n` +
      `Notional: $${notionalUsdt.toFixed(0)} | Leverage: ${leverage}×` +
      slipNote,
  );
  console.log(
    `  ${coin}: SHORT opened — entry $${fillPx.toFixed(6)} stop $${stopPx.toFixed(6)} ` +
      `notional $${notionalUsdt.toFixed(0)} (${IS_PAPER ? "PAPER" : "LIVE"})`,
  );
}

// ─── Status display ────────────────────────────────────────────────────────────
async function printStatus(store: BybitPositionStore): Promise<void> {
  const nowMs = Date.now();
  console.log(`\nAltShortBot Bybit — ${new Date().toISOString()}`);
  console.log(`Mode: ${IS_PAPER ? "PAPER" : IS_TESTNET ? "TESTNET" : "LIVE"}`);
  console.log(`Paper equity: $${store.paperEquityUsdt.toFixed(2)} USDT\n`);

  if (Object.keys(store.open).length === 0) {
    console.log("No open positions.\n");
  } else {
    console.log("Open positions:");
    console.log(
      `${"Coin".padEnd(10)} ${"Entry".padStart(12)} ${"Now".padStart(12)} ${"P&L".padStart(8)} ${"Age".padStart(8)}`,
    );
    console.log("─".repeat(54));
    for (const [coin, pos] of Object.entries(store.open)) {
      const px = await fetchCurrentPrice(coin);
      const pnl = px
        ? (((pos.entryPx - px) / pos.entryPx) * 100).toFixed(2) + "%"
        : "?";
      const age = ((nowMs - pos.openedAt) / 3_600_000).toFixed(1) + "h";
      console.log(
        `${coin.padEnd(10)} ${("$" + pos.entryPx.toFixed(6)).padStart(12)} ` +
          `${px ? "$" + px.toFixed(6) : "?".padStart(12)} ${pnl.padStart(8)} ${age.padStart(8)}`,
      );
    }
  }

  const recent = store.closed.slice(-5).reverse();
  if (recent.length) {
    console.log("\nLast 5 closed:");
    for (const t of recent) {
      const icon = t.pnlPct > 0 ? "✅" : "❌";
      console.log(
        `  ${icon} ${t.coin.padEnd(10)} ${t.pnlPct.toFixed(2)}% (${t.closeReason})`,
      );
    }
  }
  console.log();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\nAltShortBot Bybit Executor — ${new Date().toISOString()}`);
  console.log(`Mode: ${IS_PAPER ? "PAPER" : IS_TESTNET ? "TESTNET" : "LIVE"}`);

  const store = loadPositions();

  if (IS_STATUS) {
    await printStatus(store);
    return;
  }

  // ── Manage existing positions ───────────────────────────────────────────────
  if (Object.keys(store.open).length > 0) {
    console.log(
      `\nManaging ${Object.keys(store.open).length} open position(s)...`,
    );
    try {
      await managePositions(store);
    } catch (e) {
      await alertError("managePositions", e);
    }
    savePositions(store);
  }

  // ── Execute queued signals ──────────────────────────────────────────────────
  const queue = loadQueue();
  if (!queue.length) {
    console.log("Queue empty — nothing to execute.\n");
    savePositions(store);
    return;
  }

  console.log(`\n${queue.length} signal(s) in queue...`);

  // Check position cap before clearing queue
  if (Object.keys(store.open).length >= RISK.maxPositions) {
    console.log(
      `  At max positions (${RISK.maxPositions}) — signals deferred to next run`,
    );
    savePositions(store);
    return;
  }

  // Get account equity before clearing queue — if this fails, signals are preserved
  let equity = store.paperEquityUsdt;
  if (!IS_PAPER) {
    const liveEquity = await fetchAccountEquity();
    if (liveEquity === null) {
      console.log(
        "  Could not fetch account equity — signals preserved for next run",
      );
      savePositions(store);
      return;
    }
    equity = liveEquity;
  }

  // Safe to clear now — equity confirmed, execution proceeding
  clearQueue();

  let executed = 0;
  for (const sig of queue) {
    if (Object.keys(store.open).length >= RISK.maxPositions) break;
    console.log(
      `  Processing ${sig.coin} (${sig.type} ${sig.fundingApr.toFixed(0)}% APR)...`,
    );
    try {
      await executeSignal(sig, store, equity);
      executed++;
    } catch (e) {
      await alertError(`executeSignal(${sig.coin})`, e);
    }
    await sleep(200);
  }

  savePositions(store);
  console.log(`\nDone. ${executed} new position(s) opened.\n`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(async (e) => {
    await alertError("executor crashed", e);
    process.exit(1);
  });
}
