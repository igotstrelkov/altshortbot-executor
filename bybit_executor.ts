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
  riskPerTrade: 0.04, // 4% account risk per trade (demo only — drop to 2% when going live)
  stopLossPct: 0.12, // 12% stop loss
  maxPositions: 5, // max concurrent open positions (5 × 4% = 20% max concurrent risk)
  timeoutH: 72, // close after 72h regardless (validated: 72h > 48h across 32 building signals)
  trailActivatePct: 5, // activate trailing stop when P&L reaches 5%
  trailDistancePct: 4, // trail 4% above the lowest price seen
  minEntryPrice: 0.0001, // skip coins below this — position sizing breaks on micro-caps
} as const;

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
  maxQty: string;
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
      maxQty: info.lotSizeFilter?.maxOrderQty ?? "999999999",
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

/**
 * Open a short position with attached stop loss.
 * Returns the Bybit orderId on success, null on failure.
 */
async function openShort(
  coin: string,
  price: number,
  notional: number,
  stopPx: number,
  leverage: number,
  instr: InstrumentInfo,
): Promise<string | null> {
  if (IS_PAPER) return "PAPER";

  const qty = notional / price;
  let qtyStr = formatQty(qty, instr.qtyStep);
  const stopStr = formatPrice(stopPx, instr.tickSize);

  if (price < RISK.minEntryPrice) {
    console.log(
      `  ${coin}: price $${price} below $${RISK.minEntryPrice} — micro-cap, skipping`,
    );
    await sendTelegram(
      `⚠️ *${coin}* skipped — price $${price} too low for position sizing`,
    );
    return null;
  }
  if (parseFloat(qtyStr) < parseFloat(instr.minQty)) {
    console.log(
      `  ${coin}: qty ${qtyStr} below minQty ${instr.minQty} — skipping`,
    );
    return null;
  }
  if (parseFloat(qtyStr) > parseFloat(instr.maxQty)) {
    // Cap to exchange maximum — position will be smaller than intended but stop % is unchanged
    console.log(
      `  ${coin}: qty ${qtyStr} exceeds maxQty ${instr.maxQty} — capping to exchange limit`,
    );
    qtyStr = instr.maxQty;
  }

  try {
    const res = await client.submitOrder({
      category: "linear",
      symbol: `${coin}USDT`,
      side: "Sell",
      orderType: "Market",
      qty: qtyStr,
      stopLoss: stopStr,
      slTriggerBy: "MarkPrice",
      tpslMode: "Full",
      positionIdx: 0, // one-way mode
    });
    if (res.retCode === 10001 && res.retMsg?.includes("max_qty")) {
      // Bybit rejected qty as too large — parse actual max from error and retry once
      const match = res.retMsg.match(/max_qty:(\d+)/);
      if (match) {
        qtyStr = match[1];
        console.log(
          `  ${coin}: qty capped to error-derived max ${qtyStr} — retrying`,
        );
        const res2 = await client.submitOrder({
          category: "linear",
          symbol: `${coin}USDT`,
          side: "Sell",
          orderType: "Market",
          qty: qtyStr,
          stopLoss: stopStr,
          slTriggerBy: "MarkPrice",
          tpslMode: "Full",
          positionIdx: 0,
        });
        if (res2.retCode !== 0) {
          await alertError(
            `openShort(${coin})`,
            `retCode ${res2.retCode}: ${res2.retMsg}`,
          );
          return null;
        }
        return res2.result?.orderId ?? null;
      }
    }
    if (res.retCode !== 0) {
      await alertError(
        `openShort(${coin})`,
        `retCode ${res.retCode}: ${res.retMsg}`,
      );
      return null;
    }
    return res.result?.orderId ?? null;
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

/** Fetch the actual fill price for the most recent close from Bybit order history */
async function fetchActualClosePrice(
  coin: string,
  fallback: number,
): Promise<number> {
  if (IS_PAPER) return fallback;
  try {
    const res = await client.getClosedPnL({
      category: "linear",
      symbol: `${coin}USDT`,
      limit: 1,
    });
    const record = res.result?.list?.[0];
    if (record?.avgExitPrice) return parseFloat(record.avgExitPrice);
    return fallback;
  } catch {
    return fallback;
  }
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

    // ── Trailing stop logic ───────────────────────────────────────────────────
    // Activate when position first reaches trailActivatePct (5%) profit.
    // Once active, trail trailDistancePct (4%) above the lowest price seen.
    if (!pos.trailingActive && pnlPct >= RISK.trailActivatePct) {
      pos.trailingActive = true;
      pos.lowestPriceSeen = currentPx;
      pos.trailingStopPx = currentPx * (1 + RISK.trailDistancePct / 100);
      const tsStr = pos.trailingStopPx.toFixed(6);
      console.log(
        `  ${coin}: trailing stop ACTIVATED — stop $${tsStr} (trail ${RISK.trailDistancePct}%)`,
      );
      await sendTelegram(
        `📐 *${coin}* trailing stop activated
` + `P&L: ${pnlPct.toFixed(2)}% | Trailing stop: $${tsStr}`,
      );
    }

    if (pos.trailingActive) {
      // Update lowest price and trailing stop as position moves in our favour
      if (currentPx < (pos.lowestPriceSeen ?? currentPx)) {
        pos.lowestPriceSeen = currentPx;
        pos.trailingStopPx = currentPx * (1 + RISK.trailDistancePct / 100);
      }
      console.log(
        `  ${coin}: open ${ageH.toFixed(1)}h — px $${currentPx.toFixed(6)}` +
          ` — ${pnlPct.toFixed(2)}% 📐 trail $${(pos.trailingStopPx ?? 0).toFixed(6)}`,
      );
    } else {
      console.log(
        `  ${coin}: open ${ageH.toFixed(1)}h — px $${currentPx.toFixed(6)} — ${pnlPct.toFixed(2)}%`,
      );
    }

    // ── Close condition checks ────────────────────────────────────────────────
    let stopHit = false;
    let trailingHit = false;

    // Trailing stop takes priority when active
    if (pos.trailingActive && currentPx >= (pos.trailingStopPx ?? Infinity)) {
      trailingHit = true;
    } else if (!IS_PAPER) {
      // Check if exchange closed the position (hard stop triggered)
      const liveSize = await fetchLivePositionSize(coin);
      if (liveSize === 0) stopHit = true;
    } else {
      stopHit = currentPx >= pos.stopLossPx;
    }

    let closeReason: PaperTrade["closeReason"] | null = null;
    let closePx = currentPx;

    if (trailingHit) {
      closeReason = "trailing";
      if (!IS_PAPER) await closePosition(coin, "trailing");
    } else if (stopHit) {
      closeReason = "stop";
      closePx = IS_PAPER
        ? pos.stopLossPx
        : await fetchActualClosePrice(coin, currentPx);
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

  // Fetch instrument info — needed for precision and max leverage
  const instr = await fetchInstrumentInfo(coin);
  if (!instr) {
    console.log(
      `  ${coin}: not listed on Bybit or instrument info unavailable — skipping`,
    );
    return;
  }

  const leverage = Math.min(RISK.maxLeverage, instr.maxLev);
  const riskUsdt = equity * RISK.riskPerTrade;
  const notional = riskUsdt / RISK.stopLossPct; // e.g. $200 / 0.12 = $1,667
  const stopPx = entry * (1 + RISK.stopLossPct);

  // Set leverage before entry
  const levOk = await setLeverage(coin, leverage, instr.maxLev);
  if (!levOk) {
    console.log(`  ${coin}: setLeverage failed — skipping`);
    return;
  }

  const orderId = await openShort(
    coin,
    entry,
    notional,
    stopPx,
    leverage,
    instr,
  );
  if (!orderId) return;

  const sizeCoin = notional / entry;
  const record: PositionRecord = {
    coin,
    openedAt: Date.now(),
    entryPx: entry,
    sizeCoin,
    notionalUsdc: notional,
    stopLossPx: stopPx,
    targetPx: entry * 0.75, // 25% target (informational)
    trailingActive: false,
    signalType: signalType as PositionRecord["signalType"],
    signalConfidence: confidence as PositionRecord["signalConfidence"],
    isPaper: IS_PAPER,
    ...(orderId !== "PAPER" ? { stopOid: undefined } : {}),
  };

  store.open[coin] = record;

  const mode = IS_PAPER ? "📄 " : "";
  await sendTelegram(
    `${mode}📉 *${coin}* SHORT opened\n` +
      `Entry: $${entry.toFixed(6)} | Stop: $${stopPx.toFixed(6)}\n` +
      `Signal: ${signalType} (${confidence}) | Funding: ${fundingApr.toFixed(0)}% APR\n` +
      `Notional: $${notional.toFixed(0)} | Leverage: ${leverage}×`,
  );
  console.log(
    `  ${coin}: SHORT opened — entry $${entry.toFixed(6)} stop $${stopPx.toFixed(6)} ` +
      `notional $${notional.toFixed(0)} (${IS_PAPER ? "PAPER" : "LIVE"})`,
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
  // NOTE: clearQueue() moved to AFTER equity check — prevents signal loss on failure

  // Check position cap
  const openCount = Object.keys(store.open).length;
  if (openCount >= RISK.maxPositions) {
    const coins = queue.map((s) => s.coin).join(", ");
    const msg = `⏸ Max positions (${RISK.maxPositions}) reached — deferred: ${coins}`;
    console.log(`  ${msg}`);
    await sendTelegram(msg);
    savePositions(store);
    return;
  }

  // Get account equity — must succeed before clearing queue
  let equity = store.paperEquityUsdt;
  if (!IS_PAPER) {
    const liveEquity = await fetchAccountEquity();
    if (liveEquity === null) {
      console.log(
        "  Could not fetch account equity — signals preserved for next run",
      );
      savePositions(store);
      return; // queue intact — will retry next cron tick
    }
    equity = liveEquity;
  }

  clearQueue(); // safe to clear now — equity confirmed, execution proceeding

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
