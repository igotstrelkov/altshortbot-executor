/**
 * long_executor.ts — Long Bot Executor
 * ======================================
 * Mirrors bybit_executor.ts but enters LONG positions.
 * Reads long_queue.json, manages long positions on Bybit demo/live.
 *
 * Key differences from bybit_executor.ts:
 *   - openLong:  side: "Buy"  (not "Sell")
 *   - Stop loss: entry × (1 - stopLossPct)  (below entry, not above)
 *   - closePosition: side: "Sell" + reduceOnly
 *   - Trailing stop: tracks highestPriceSeen (ratchets UP, not down)
 *   - trailingStopPx = highestPriceSeen × (1 - trailDistancePct/100)
 *   - Triggers when currentPx ≤ trailingStopPx
 *   - Files: long_queue.json / bybit_long_positions.json
 *
 * Run:
 *   npx tsx long_executor.ts --paper    ← paper mode (no orders)
 *   npx tsx long_executor.ts --status   ← check positions
 *   npx tsx long_executor.ts            ← LIVE/DEMO — real orders
 *
 * Environment: same as bybit_executor.ts (shared keys)
 */

import { RestClientV5 } from "bybit-api";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import type { PaperTrade, PositionRecord } from "./shared_types.ts";

// ─── Config ───────────────────────────────────────────────────────────────────
const IS_PAPER = process.argv.includes("--paper");
const IS_STATUS = process.argv.includes("--status");
const IS_TESTNET = process.env.BYBIT_TESTNET === "1";

const BYBIT_API_KEY = process.env.BYBIT_API_KEY ?? "";
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET ?? "";
const PAPER_ACCOUNT = parseFloat(process.env.BYBIT_PAPER_ACCOUNT ?? "10000");

const RISK = {
  maxLeverage: 3,
  riskPerTrade: 0.04, // 4% account risk (demo only — drop to 2% live)
  stopLossPct: 0.12, // 12% stop loss below entry (standard)
  stopLossPctWide: 0.2, // 20% stop loss for high-conviction signals (funding > wideStopThreshold)
  wideStopThreshold: 400, // APR above which to use wider stop (LAB-class volatility)
  maxPositions: 5,
  timeoutH: 72, // validated: same as short bot
  trailActivatePct: 5, // activate trailing when P&L >= 5%
  trailDistancePct: 4, // trail 4% below the highest price seen
} as const;

const LONG_QUEUE_FILE = "long_queue.json";
const POSITIONS_FILE = "bybit_long_positions.json";
const BB_BASE = "https://api.bybit.com";

// ─── Bybit client ─────────────────────────────────────────────────────────────
const client = new RestClientV5({
  key: BYBIT_API_KEY,
  secret: BYBIT_API_SECRET,
  testnet: false,
  demoTrading: true, // ← set false to go live
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
  await sendTelegram(`🚨 *altshortbot-long* — ${ctx}\n\`${msg}\``);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJSON(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function formatQty(qty: number, qtyStep: string): string {
  const step = parseFloat(qtyStep);
  const decimals = (qtyStep.split(".")[1] ?? "").length;
  return (Math.floor(qty / step) * step).toFixed(decimals);
}

function formatPrice(price: number, tickSize: string): string {
  const step = parseFloat(tickSize);
  const decimals = (tickSize.split(".")[1] ?? "").length;
  return (Math.round(price / step) * step).toFixed(decimals);
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
  } catch {
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
interface LongPositionStore {
  open: Record<string, PositionRecord>;
  closed: PaperTrade[];
  paperEquityUsdt: number;
}

function loadPositions(): LongPositionStore {
  if (!existsSync(POSITIONS_FILE))
    return { open: {}, closed: [], paperEquityUsdt: PAPER_ACCOUNT };
  try {
    return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
  } catch {
    return { open: {}, closed: [], paperEquityUsdt: PAPER_ACCOUNT };
  }
}

function savePositions(store: LongPositionStore): void {
  writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2), "utf8");
}

// ─── Queue ─────────────────────────────────────────────────────────────────────
interface QueuedLongSignal {
  coin: string;
  type: string;
  firedAt: number;
  firedAtStr: string;
  entry: number;
  fundingApr: number;
  oiChange4h: number;
  confidence: string;
  queuedAt: number;
}

function loadQueue(): QueuedLongSignal[] {
  if (!existsSync(LONG_QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(LONG_QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function clearQueue(): void {
  writeFileSync(LONG_QUEUE_FILE, "[]", "utf8");
}

// ─── Account ───────────────────────────────────────────────────────────────────
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
    if ((e as Error).message?.includes("leverage not modified")) return true;
    await alertError(`setLeverage(${coin})`, e);
    return false;
  }
}

/** Open a long position with stop loss below entry */
async function openLong(
  coin: string,
  price: number,
  notional: number,
  stopPx: number,
  instr: InstrumentInfo,
): Promise<string | null> {
  if (IS_PAPER) return "PAPER";

  const qty = notional / price;
  const qtyStr = formatQty(qty, instr.qtyStep);
  const stopStr = formatPrice(stopPx, instr.tickSize);

  if (parseFloat(qtyStr) < parseFloat(instr.minQty)) {
    console.log(
      `  ${coin}: qty ${qtyStr} below minQty ${instr.minQty} — skipping`,
    );
    return null;
  }

  try {
    const res = await client.submitOrder({
      category: "linear",
      symbol: `${coin}USDT`,
      side: "Buy", // ← LONG (not Sell)
      orderType: "Market",
      qty: qtyStr,
      stopLoss: stopStr, // stop is BELOW entry for longs
      slTriggerBy: "MarkPrice",
      tpslMode: "Full",
      positionIdx: 0,
    });
    if (res.retCode !== 0) {
      await alertError(
        `openLong(${coin})`,
        `retCode ${res.retCode}: ${res.retMsg}`,
      );
      return null;
    }
    return res.result?.orderId ?? null;
  } catch (e) {
    await alertError(`openLong(${coin})`, e);
    return null;
  }
}

/** Close a long position at market */
async function closePosition(coin: string, reason: string): Promise<boolean> {
  if (IS_PAPER) return true;
  try {
    const res = await client.submitOrder({
      category: "linear",
      symbol: `${coin}USDT`,
      side: "Sell", // ← SELL to close long (not Buy)
      orderType: "Market",
      qty: "0",
      reduceOnly: true,
      closeOnTrigger: true,
      positionIdx: 0,
    });
    if (res.retCode !== 0) {
      await alertError(
        `closePosition(${coin}) — ${reason}`,
        `retCode ${res.retCode}: ${res.retMsg}`,
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

async function fetchLivePositionSize(coin: string): Promise<number> {
  if (IS_PAPER) return -1;
  try {
    const res = await client.getPositionInfo({
      category: "linear",
      symbol: `${coin}USDT`,
    });
    const pos = res.result?.list?.[0];
    return pos ? parseFloat(pos.size ?? "0") : 0;
  } catch {
    return -1;
  }
}

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
async function managePositions(store: LongPositionStore): Promise<void> {
  const nowMs = Date.now();

  for (const [coin, pos] of Object.entries(store.open)) {
    const ageH = (nowMs - pos.openedAt) / 3_600_000;
    const currentPx = await fetchCurrentPrice(coin);
    if (!currentPx) {
      console.log(`  ${coin}: price unavailable`);
      continue;
    }

    // P&L for long: positive when price rises above entry
    const pnlPct = ((currentPx - pos.entryPx) / pos.entryPx) * 100;

    // ── Trailing stop (LONG version — tracks HIGHEST price seen) ─────────────
    // Activates when profit reaches trailActivatePct.
    // Trails trailDistancePct BELOW the highest price seen.
    const highest = pos.highestPriceSeen as number | undefined;

    if (!pos.trailingActive && pnlPct >= RISK.trailActivatePct) {
      pos.trailingActive = true;
      pos.highestPriceSeen = currentPx;
      pos.trailingStopPx = currentPx * (1 - RISK.trailDistancePct / 100);
      const tsStr = pos.trailingStopPx!.toFixed(6);
      console.log(`  ${coin}: trailing stop ACTIVATED — stop $${tsStr}`);
      await sendTelegram(
        `📐 *${coin}* long trailing stop activated\n` +
          `P&L: +${pnlPct.toFixed(2)}% | Trail stop: $${tsStr}`,
      );
    }

    if (pos.trailingActive) {
      // Update highest price and trailing stop as position moves in our favour (UP)
      if (currentPx > (pos.highestPriceSeen ?? 0)) {
        pos.highestPriceSeen = currentPx;
        pos.trailingStopPx = currentPx * (1 - RISK.trailDistancePct / 100);
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
    let trailingHit = false;
    let stopHit = false;

    // Trailing stop: price dropped below trail (for longs, trail is BELOW current)
    if (pos.trailingActive && currentPx <= (pos.trailingStopPx ?? 0)) {
      trailingHit = true;
    } else if (!IS_PAPER) {
      const liveSize = await fetchLivePositionSize(coin);
      if (liveSize === 0) stopHit = true;
    } else {
      stopHit = currentPx <= pos.stopLossPx; // ← LONGS: stop triggers when price falls to stopPx
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
      // P&L for long: positive if close > entry
      const finalPnlPct = ((closePx - pos.entryPx) / pos.entryPx) * 100;
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
        `${mode}${icon} *${coin}* long closed (${closeReason})\n` +
          `Entry: $${pos.entryPx.toFixed(6)} → Exit: $${closePx.toFixed(6)}\n` +
          `P&L: ${finalPnlPct.toFixed(2)}% | USDT: ${finalPnlUsdt.toFixed(2)}`,
      );
      console.log(
        `  ${coin}: closed (${closeReason}) ${finalPnlPct.toFixed(2)}% — $${finalPnlUsdt.toFixed(2)}`,
      );
    }
  }
}

// ─── Signal execution ──────────────────────────────────────────────────────────
async function executeSignal(
  sig: QueuedLongSignal,
  store: LongPositionStore,
  equity: number,
): Promise<void> {
  const { coin, entry, fundingApr } = sig;
  if (store.open[coin]) {
    console.log(`  ${coin}: already open — skipping`);
    return;
  }

  const instr = await fetchInstrumentInfo(coin);
  if (!instr) {
    console.log(`  ${coin}: not listed or info unavailable`);
    return;
  }

  const leverage = Math.min(RISK.maxLeverage, instr.maxLev);
  const riskUsdt = equity * RISK.riskPerTrade;
  // Tiered stop: high-conviction signals (funding > wideStopThreshold) use wider stop
  // to avoid being shaken out on volatile high-beta coins like LAB
  const isHighConv = fundingApr >= RISK.wideStopThreshold;
  const stopPct = isHighConv ? RISK.stopLossPctWide : RISK.stopLossPct;
  const notional = riskUsdt / stopPct;
  const stopPx = entry * (1 - stopPct); // ← BELOW entry for longs

  const levOk = await setLeverage(coin, leverage, instr.maxLev);
  if (!levOk) {
    console.log(`  ${coin}: setLeverage failed — skipping`);
    return;
  }

  const orderId = await openLong(coin, entry, notional, stopPx, instr);
  if (!orderId) return;

  const sizeCoin = notional / entry;
  store.open[coin] = {
    coin,
    openedAt: Date.now(),
    entryPx: entry,
    sizeCoin,
    notionalUsdc: notional,
    stopLossPx: stopPx,
    targetPx: entry * 1.25, // 25% target (informational)
    trailingActive: false,
    signalType: "BUILDING" as const,
    signalConfidence: (sig.confidence === "HIGH" ? "HIGH" : "MEDIUM") as
      | "HIGH"
      | "MEDIUM",
    isPaper: IS_PAPER,
  };

  const mode = IS_PAPER ? "📄 " : "";
  const stopLabel = isHighConv
    ? `${(stopPct * 100).toFixed(0)}% WIDE (funding > ${RISK.wideStopThreshold}%)`
    : `${(stopPct * 100).toFixed(0)}% standard`;
  await sendTelegram(
    `${mode}📈 *${coin}* LONG opened\n` +
      `Entry: $${entry.toFixed(6)} | Stop: $${stopPx.toFixed(6)} (${stopLabel})\n` +
      `Funding: +${fundingApr.toFixed(0)}% APR | Leverage: ${leverage}×\n` +
      `Notional: $${notional.toFixed(0)}`,
  );
  console.log(
    `  ${coin}: LONG opened — entry $${entry.toFixed(6)} stop $${stopPx.toFixed(6)}` +
      ` (${stopLabel}) notional $${notional.toFixed(0)} (${IS_PAPER ? "PAPER" : "LIVE"})`,
  );
}

// ─── Status ────────────────────────────────────────────────────────────────────
async function printStatus(store: LongPositionStore): Promise<void> {
  const nowMs = Date.now();
  console.log(`\nAltShortBot Long — Position Monitor`);
  console.log(
    `${new Date().toISOString()}  |  paper equity: $${store.paperEquityUsdt.toFixed(2)}\n`,
  );

  if (!Object.keys(store.open).length) {
    console.log("No open long positions.\n");
  } else {
    console.log(
      `${"Coin".padEnd(10)} ${"Entry".padStart(12)} ${"Now".padStart(12)} ${"P&L".padStart(8)} ${"Age".padStart(8)}`,
    );
    console.log("─".repeat(54));
    for (const [coin, pos] of Object.entries(store.open)) {
      const px = await fetchCurrentPrice(coin);
      const pnl = px
        ? (((px - pos.entryPx) / pos.entryPx) * 100).toFixed(2) + "%"
        : "?";
      const age = ((nowMs - pos.openedAt) / 3_600_000).toFixed(1) + "h";
      console.log(
        `${coin.padEnd(10)} ${("$" + pos.entryPx.toFixed(6)).padStart(12)}` +
          ` ${px ? "$" + px.toFixed(6) : "?".padStart(12)} ${pnl.padStart(8)} ${age.padStart(8)}`,
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
  console.log(`\nAltShortBot Long Executor — ${new Date().toISOString()}`);
  console.log(`Mode: ${IS_PAPER ? "PAPER" : IS_TESTNET ? "TESTNET" : "LIVE"}`);

  const store = loadPositions();
  if (IS_STATUS) {
    await printStatus(store);
    return;
  }

  // Manage existing long positions
  if (Object.keys(store.open).length > 0) {
    console.log(
      `\nManaging ${Object.keys(store.open).length} open long position(s)...`,
    );
    try {
      await managePositions(store);
    } catch (e) {
      await alertError("managePositions", e);
    }
    savePositions(store);
  }

  // Execute queued signals
  const queue = loadQueue();
  if (!queue.length) {
    console.log("Long queue empty — nothing to execute.\n");
    savePositions(store);
    return;
  }

  console.log(`\n${queue.length} long signal(s) in queue...`);

  // Check position cap
  if (Object.keys(store.open).length >= RISK.maxPositions) {
    const coins = queue.map((s) => s.coin).join(", ");
    const msg = `⏸ Long: max positions (${RISK.maxPositions}) reached — deferred: ${coins}`;
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
      console.log("  Could not fetch equity — signals preserved for next run");
      savePositions(store);
      return;
    }
    equity = liveEquity;
  }

  clearQueue();

  let executed = 0;
  for (const sig of queue) {
    if (Object.keys(store.open).length >= RISK.maxPositions) break;
    console.log(
      `  Processing ${sig.coin} (LONG +${sig.fundingApr.toFixed(0)}% APR)...`,
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
  console.log(`\nDone. ${executed} new long position(s) opened.\n`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(async (e) => {
    await alertError("long executor crashed", e);
    process.exit(1);
  });
}
