/**
 * KuCoin Executor
 * ===========================
 * Runs every 5 minutes via PM2 cron. Reads signal_queue.json, opens shorts
 * on KuCoin USDT perpetuals, manages open positions (stop loss, 24h timeout).
 *
 * Why KuCoin:
 *   Migration target after Bybit. The scanner detects squeezes on Bybit USDT
 *   perps; some of those coins are not listed on KuCoin — such signals are
 *   skipped and logged (see the tradeable-contract Set built at startup).
 *
 * KuCoin differences from the Bybit executor (all handled below):
 *   - Order `size` is an INTEGER CONTRACT COUNT, not a coin quantity. Each
 *     contract = `multiplier` coins. Sizing converts notional → contracts.
 *   - 3 credentials (key + secret + passphrase), not 2.
 *   - Leverage is passed inline on the order — there is no separate setLeverage.
 *   - Margin mode is per-symbol: the executor forces ISOLATED on each contract
 *     before entry (KuCoin rejects an order whose mode mismatches — err 330005).
 *   - Symbols are `{COIN}USDTM`, and BTC is `XBT` (so `XBTUSDTM`).
 *   - The SDK returns the full `{ code, data }` envelope — we read `.data`.
 *
 * Exit model — identical to the Bybit executor: a short closes ONLY on
 *   - stop    — price rose stopLossPct above entry, or
 *   - timeout — 24h elapsed.
 * No take-profit, no trailing stop. On exit, any untriggered stop order left
 * resting on the symbol is cancelled — critical on a timeout close, where
 * openShort's stop never fired and would otherwise survive to trigger against
 * a future position on the same coin.
 *
 * Modes:
 *   --paper    Simulate trades (no orders). Uses live KuCoin prices for P&L.
 *   --status   Print open positions and P&L, then exit.
 *
 * Environment:
 *   KUCOIN_API_KEY          API key (not needed in paper mode)
 *   KUCOIN_API_SECRET       API secret (not needed in paper mode)
 *   KUCOIN_API_PASSPHRASE   API passphrase (not needed in paper mode)
 *   KUCOIN_PAPER_ACCOUNT    Paper account size in USDT (default: 10000)
 *
 * Run:
 *   npx tsx kucoin_executor.ts --paper    ← paper mode (safe)
 *   npx tsx kucoin_executor.ts --status   ← check positions
 *   npx tsx kucoin_executor.ts            ← LIVE — real orders
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { FuturesClient } from "kucoin-api";
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

const KUCOIN_API_KEY = process.env.KUCOIN_API_KEY ?? "";
const KUCOIN_API_SECRET = process.env.KUCOIN_API_SECRET ?? "";
const KUCOIN_API_PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE ?? "";
const PAPER_ACCOUNT = parseFloat(process.env.KUCOIN_PAPER_ACCOUNT ?? "10000");

const CONVEX_INGEST_URL = process.env.CONVEX_INGEST_URL ?? "";
const CONVEX_INGEST_URL_DEV = process.env.CONVEX_INGEST_URL_DEV ?? "";
const CONVEX_INGEST_SECRET = process.env.CONVEX_INGEST_SECRET ?? "";
const CONVEX_OUTBOX_FILE = "convex_outbox.json";

// Risk block — identical values to bybit_executor.ts. See CLAUDE.md.
const RISK = {
  maxLeverage: 3,
  riskPerTrade: 0.05, // 5% account risk per trade
  stopLossPct: 0.15, // 15% stop loss
  maxPositions: 5, // max concurrent open positions
  timeoutH: 24, // close after 24h regardless (validated 2026-05-28: 24h optimal vs 48h/72h)
  // Re-entry cooldown: after a coin stops out, do not re-short it for this many
  // hours. Drawdown insurance — the universe sim halved bad-regime drawdown
  // (-49%→-23% at 24h) by breaking the serial-restack-into-a-squeeze loop. It
  // costs some return in benign regimes (out-of-sample second half), so it's a
  // deliberate risk trade, not a free edge. See HISTORY.md / sim notes.
  reentryCooldownH: 24,
} as const;

// If integer-contract rounding pushes realized risk above this multiple of
// the 3% target, the entry alert flags it (informational — the trade still
// goes through; see the round-up sizing decision).
const RISK_NOTE_MULTIPLE = 1.5;

// Coins never traded regardless of signal. H is priced ~2× apart on Bybit (the
// scanner's venue) vs KuCoin (this executor's venue) due to a token
// redenomination, so every Bybit signal mis-describes the KuCoin instrument —
// see the venue-agreement guard below. The guard would also auto-skip it, but
// an explicit exclude is a clear, immediate stop.
const EXCLUDE_COINS = new Set(["H"]);

// Venue-agreement / staleness guard: the signal's entry price comes from the
// scanner's venue (Bybit); we trade KuCoin. If the live KuCoin price diverges
// from the signal price by more than this fraction, the venues disagree (e.g. a
// redenominated token) or the price ran away since the scan — either way the
// signal does not describe what we'd trade, so the entry is skipped.
const MAX_SIGNAL_DIVERGENCE = 0.15; // 15%

const QUEUE_FILE = "signal_queue.json";
const POSITIONS_FILE = "kucoin_positions.json";

// ─── KuCoin REST client ────────────────────────────────────────────────────────
// FuturesClient with no creds still serves public endpoints (getSymbols etc).
const client = IS_PAPER
  ? new FuturesClient()
  : new FuturesClient({
      apiKey: KUCOIN_API_KEY,
      apiSecret: KUCOIN_API_SECRET,
      apiPassphrase: KUCOIN_API_PASSPHRASE,
    });

const KC_OK = "200000"; // KuCoin success code in the { code, data } envelope

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID ?? "";

async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_GROUP_ID) {
    console.log("[telegram]", msg);
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_GROUP_ID,
          text: msg,
          parse_mode: "Markdown",
        }),
      },
    );
    // A 400 (e.g. unbalanced Markdown — a lone `_` in PUMP_TOP) is a resolved
    // fetch with res.ok === false, not a throw — surface it instead of silently
    // dropping the message.
    if (!res.ok) console.error(`[telegram] ${res.status}: ${await res.text()}`);
  } catch {
    /* network error — non-fatal */
  }
}

/**
 * Render any thrown value as a readable string. The KuCoin SDK throws plain
 * objects (its { code, msg } error body), not Error instances — `String(obj)`
 * on those yields the useless "[object Object]". This unwraps the common
 * shapes: Error.message, a KuCoin { code, msg }, a nested response body, and
 * falls back to JSON so nothing is ever stringified to "[object Object]".
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as Record<string, any>;
    // KuCoin REST error body — possibly nested under .response.data / .body.
    const body = e.response?.data ?? e.body ?? e;
    if (body && typeof body === "object" && (body.code || body.msg)) {
      return `KuCoin ${body.code ?? "?"}: ${body.msg ?? "(no message)"}`;
    }
    if (typeof e.message === "string") return e.message;
    try {
      return JSON.stringify(err);
    } catch {
      return "(unserializable error object)";
    }
  }
  return String(err);
}

async function alertError(ctx: string, err: unknown): Promise<void> {
  const msg = describeError(err);
  console.error(`[ERROR] ${ctx}: ${msg}`);
  await sendTelegram(`🚨 *altshortbot* — ${ctx}\n\`${msg}\``);
}

// ─── Convex reporting (non-fatal, one-way) ──────────────────────────────────────
// After each open and each close, POST a "this just happened" event to a Convex
// HTTP ingest endpoint. STRICTLY NON-FATAL: a network failure, bad URL, timeout,
// or non-2xx response never throws into the trading path — it is swallowed here
// and the event is appended to a local outbox for retry on the next run. The bot
// stays fully decoupled from Convex: it knows only a URL and a secret.

async function postSignalEvent(
  event: "opened" | "closed",
  signal: Record<string, unknown>,
): Promise<void> {
  if (!CONVEX_INGEST_URL || !CONVEX_INGEST_SECRET) return; // not configured → no-op
  try {
    const res = await fetch(CONVEX_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": CONVEX_INGEST_SECRET,
      },
      body: JSON.stringify({ event, signal }),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}`);
  } catch (e) {
    console.error(
      "[convex] post failed, queued for retry:",
      (e as Error).message,
    );
    appendToOutbox({ event, signal }); // never rethrow
  }

  try {
    const res_dev = await fetch(CONVEX_INGEST_URL_DEV, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": CONVEX_INGEST_SECRET,
      },
      body: JSON.stringify({ event, signal }),
    });
    if (!res_dev.ok) throw new Error(`ingest_dev ${res_dev.status}`);
  } catch (e) {
    console.error(
      "[convex_dev] post failed, queued for retry:",
      (e as Error).message,
    );
  }
}

/**
 * Append a failed event to the local outbox. Temp-file + rename keeps the write
 * atomic so a crash mid-write cannot corrupt the outbox.
 */
function appendToOutbox(entry: {
  event: string;
  signal: Record<string, unknown>;
}): void {
  let queue: any[] = [];
  try {
    if (existsSync(CONVEX_OUTBOX_FILE))
      queue = JSON.parse(readFileSync(CONVEX_OUTBOX_FILE, "utf8"));
  } catch {
    queue = [];
  }
  queue.push({ ...entry, ts: Date.now() });
  const tmp = `${CONVEX_OUTBOX_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(queue), "utf8");
  renameSync(tmp, CONVEX_OUTBOX_FILE);
}

/**
 * Replay pending events oldest-first so an "opened" always precedes its
 * "closed". Stop on the first failure and keep the remainder for the next run.
 */
async function flushOutbox(): Promise<void> {
  if (
    !CONVEX_INGEST_URL ||
    !CONVEX_INGEST_SECRET ||
    !existsSync(CONVEX_OUTBOX_FILE)
  )
    return;
  let queue: any[] = [];
  try {
    queue = JSON.parse(readFileSync(CONVEX_OUTBOX_FILE, "utf8"));
  } catch {
    return;
  }
  const remaining = [...queue];
  for (const item of queue) {
    try {
      const res = await fetch(CONVEX_INGEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ingest-secret": CONVEX_INGEST_SECRET,
        },
        body: JSON.stringify({ event: item.event, signal: item.signal }),
      });
      if (!res.ok) break; // stop; preserve order for next run
      remaining.shift();
    } catch {
      break;
    }
  }
  const tmp = `${CONVEX_OUTBOX_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(remaining), "utf8");
  renameSync(tmp, CONVEX_OUTBOX_FILE);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Symbol mapping. The scanner emits Bybit-style coin tickers (e.g. "BTC",
 * "SOL"). KuCoin futures symbols are `{COIN}USDTM`, and KuCoin uses "XBT"
 * for Bitcoin. So BTC → XBTUSDTM, SOL → SOLUSDTM.
 */
function toKucoinSymbol(coin: string): string {
  const base = coin.toUpperCase() === "BTC" ? "XBT" : coin.toUpperCase();
  return `${base}USDTM`;
}

/** Reverse of toKucoinSymbol: XBTUSDTM → BTC, SOLUSDTM → SOL. "" if not a USDT perp. */
function fromKucoinSymbol(symbol: string): string {
  const base = symbol.replace(/USDTM$/, "");
  if (!base || base === symbol) return ""; // not a {COIN}USDTM symbol
  return base === "XBT" ? "BTC" : base;
}

/** Number of decimal places implied by a tick size (handles "1e-7" form). */
function tickDecimals(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 0;
  const s = tick.toString();
  const exp = s.match(/e-(\d+)/i);
  if (exp) return parseInt(exp[1], 10);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Round a price to the instrument's tick grid and render it cleanly.
 * `(Math.round(px/tick)*tick).toString()` reintroduces float error — e.g.
 * 0.105938 on a 0.0001 tick becomes "0.10590000000000001", which KuCoin
 * rejects for exceeding tick precision. Formatting to the tick's decimal
 * count produces a value the exchange accepts.
 */
function formatToTick(px: number, tickSize: number): string {
  if (!(tickSize > 0)) return px.toString();
  const rounded = Math.round(px / tickSize) * tickSize;
  return rounded.toFixed(tickDecimals(tickSize));
}

// ─── Verified KuCoin response accessors ────────────────────────────────────────
// Field names below are confirmed against live API responses (probe script):
//   getSymbol().data   → multiplier, lotSize, maxLeverage, tickSize,
//                        quoteCurrency, status, lastTradePrice, markPrice
//   getBalance().data  → accountEquity
//   getPosition().data → currentQty (signed contracts), isOpen, avgEntryPrice
// The SDK returns the full { code, data } envelope; we unwrap .data here.

interface KucoinEnvelope<T> {
  code?: string;
  msg?: string; // KuCoin error message on a non-200000 response
  data?: T;
}

function unwrap<T>(res: unknown, ctx: string): T | null {
  const env = res as KucoinEnvelope<T>;
  if (!env || env.code !== KC_OK || env.data == null) {
    console.error(`  ${ctx}: unexpected response code=${env?.code}`);
    return null;
  }
  return env.data;
}

// ─── Contract spec cache ───────────────────────────────────────────────────────
// One getSymbols() call at startup populates this. It serves two purposes:
//   (1) sizing — multiplier / lotSize / maxLeverage / tickSize per contract;
//   (2) the "listed on KuCoin" filter — a coin absent from this map, or whose
//       contract is not an Open USDT perpetual, is skipped.
interface ContractSpec {
  symbol: string; // e.g. XBTUSDTM
  multiplier: number; // coins per 1 contract
  lotSize: number; // min contract increment
  maxLeverage: number;
  tickSize: number;
}

const contractCache = new Map<string, ContractSpec>(); // keyed by KuCoin symbol

async function loadContracts(): Promise<boolean> {
  try {
    const data = unwrap<any[]>(await client.getSymbols(), "getSymbols");
    if (!data) return false;
    for (const c of data) {
      // Tradeable filter: USDT-margined AND currently Open. A contract can be
      // "listed" but Paused / BeingSettled — those must not be traded.
      if (c.quoteCurrency !== "USDT") continue;
      if (c.status !== "Open") continue;
      contractCache.set(c.symbol, {
        symbol: c.symbol,
        multiplier: Number(c.multiplier),
        lotSize: Number(c.lotSize) || 1,
        maxLeverage: Number(c.maxLeverage) || RISK.maxLeverage,
        tickSize: Number(c.tickSize) || 0,
      });
    }
    console.log(
      `  Loaded ${contractCache.size} tradeable USDT perpetual contract(s).`,
    );
    return contractCache.size > 0;
  } catch (e) {
    await alertError("loadContracts", e);
    return false;
  }
}

// ─── Market data ───────────────────────────────────────────────────────────────
/** Live mark/last price for a KuCoin symbol (null on failure). */
async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const data = unwrap<any>(
      await client.getSymbol({ symbol }),
      `getSymbol(${symbol})`,
    );
    if (!data) return null;
    const px = Number(data.lastTradePrice ?? data.markPrice);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

// ─── Position state ────────────────────────────────────────────────────────────
interface KucoinPositionStore {
  open: PositionStore;
  closed: PaperTrade[];
  paperEquityUsdt: number;
}

function loadPositions(): KucoinPositionStore {
  if (!existsSync(POSITIONS_FILE)) {
    return { open: {}, closed: [], paperEquityUsdt: PAPER_ACCOUNT };
  }
  try {
    return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
  } catch {
    return { open: {}, closed: [], paperEquityUsdt: PAPER_ACCOUNT };
  }
}

function savePositions(store: KucoinPositionStore): void {
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
    const data = unwrap<any>(
      await client.getBalance({ currency: "USDT" }),
      "getBalance",
    );
    if (!data) return null;
    const equity = Number(data.accountEquity);
    return Number.isFinite(equity) ? equity : null;
  } catch (e) {
    await alertError("fetchAccountEquity", e);
    return null;
  }
}

// ─── Sizing ────────────────────────────────────────────────────────────────────
interface SizeResult {
  contracts: number; // integer order size
  notionalUsdt: number; // actual notional after rounding
  actualRiskFrac: number; // actual risk as a fraction of equity
}

/**
 * Convert risk-based notional into an integer KuCoin contract count.
 *   notional      = equity × riskPerTrade / stopLossPct   (1R stop-out = 3%)
 *   rawContracts  = notional / (entryPrice × multiplier)
 *   contracts     = round to a lotSize multiple, floored at 1 lot
 * Round-UP policy: a positive fraction below 1 lot becomes 1 lot, so a trade
 * always places (never skipped for size). Realized risk can therefore exceed
 * the 3% target on small trades — the caller logs the actual figure.
 */
function calcSize(
  equity: number,
  entryPrice: number,
  spec: ContractSpec,
): SizeResult {
  const riskUsdt = equity * RISK.riskPerTrade;
  const targetNotional = riskUsdt / RISK.stopLossPct;
  const rawContracts = targetNotional / (entryPrice * spec.multiplier);

  // Round to a lotSize multiple, with a floor of one lot (round-up policy).
  const lot = spec.lotSize > 0 ? spec.lotSize : 1;
  let contracts = Math.round(rawContracts / lot) * lot;
  if (contracts < lot) contracts = lot;

  const notionalUsdt = contracts * spec.multiplier * entryPrice;
  // Actual risk = what a stop-out (stopLossPct adverse move) costs / equity.
  const actualRiskFrac = (notionalUsdt * RISK.stopLossPct) / equity;
  return { contracts, notionalUsdt, actualRiskFrac };
}

// ─── Trading functions ─────────────────────────────────────────────────────────
/**
 * Open a short, then attach a stop-market close order anchored to the ACTUAL
 * fill price (`stop:'up'` triggers when price rises into the stop — correct for
 * a short). If the fill price can't be read or the stop is rejected, the entry
 * is immediately closed rather than left running unprotected. Returns the
 * OpenResult on success, null on failure (including the close-on-unprotected
 * path).
 */
interface OpenResult {
  orderId: string;
  fillPx: number; // actual average fill price (signal px in paper / on fallback)
  stopPx: number; // stop actually placed, derived from fillPx
}

async function openShort(
  symbol: string,
  contracts: number,
  signalEntryPx: number,
  leverage: number,
  tickSize: number,
): Promise<OpenResult | null> {
  if (IS_PAPER) {
    return {
      orderId: "PAPER",
      fillPx: signalEntryPx,
      stopPx: signalEntryPx * (1 + RISK.stopLossPct),
    };
  }

  try {
    // 0) Ensure the contract is in ISOLATED margin mode before ordering.
    //    KuCoin sets margin mode per-symbol; an order whose implied mode does
    //    not match the contract's current mode is rejected (error 330005).
    //    ISOLATED is required: it caps each position's loss to its own margin,
    //    matching the strategy's independent-position risk model. updateMarginMode
    //    is idempotent — setting ISOLATED when already ISOLATED is harmless.
    try {
      const mmRes = (await client.updateMarginMode({
        symbol,
        marginMode: "ISOLATED",
      })) as KucoinEnvelope<any>;
      if (mmRes?.code !== KC_OK) {
        await alertError(
          `openShort(${symbol}) — could not set ISOLATED margin mode`,
          `KuCoin ${mmRes?.code ?? "?"}: ${mmRes?.msg ?? "(no message)"}`,
        );
        return null; // do not order into an unknown margin mode
      }
    } catch (e) {
      await alertError(`openShort(${symbol}) — setMarginMode`, e);
      return null;
    }

    // 1) Market short entry.
    const entryRes = (await client.submitOrder({
      clientOid: client.generateNewOrderID(),
      symbol,
      side: "sell",
      type: "market",
      size: contracts,
      leverage,
      timeInForce: "GTC",
    })) as KucoinEnvelope<any>;

    if (entryRes?.code !== KC_OK) {
      await alertError(
        `openShort(${symbol}) entry rejected`,
        `KuCoin ${entryRes?.code ?? "?"}: ${entryRes?.msg ?? "(no message)"}`,
      );
      return null;
    }
    const orderId: string | null = entryRes.data?.orderId ?? null;

    // 1b) Resolve the ACTUAL average fill price. A market order can fill far
    //     from the scanner's signal price when the market moved between scan
    //     and execution; anchoring the stop to the stale signal price can place
    //     it beyond the liquidation point so the stop never fires (the failure
    //     mode that liquidated the first live trades). Fall back to the signal
    //     price only if the fill cannot be read, and alert when that happens.
    const avgPx = await fetchAvgEntryPrice(symbol);
    if (avgPx === null) {
      // Without the real fill we cannot place a correct stop. Rather than run a
      // leveraged short on a stale-price (or no) stop, close the entry now.
      await alertError(
        `openShort(${symbol}) — could not read fill price; closing the entry ` +
          `to avoid an unprotected position, verify flat on kucoin.com`,
        "getPosition returned no avgEntryPrice",
      );
      await closePosition(symbol, "unprotected — fill price unreadable");
      return null;
    }
    const fillPx = avgPx;
    const stopPxNum = fillPx * (1 + RISK.stopLossPct);

    // 2) Stop-loss: stop-market close order. stop:'up' fires when price rises
    //    to stopPrice. closeOrder:true closes the position regardless of size.
    const stopPrice = formatToTick(stopPxNum, tickSize);
    const stopRes = (await client.submitOrder({
      clientOid: client.generateNewOrderID(),
      symbol,
      side: "buy",
      type: "market",
      closeOrder: true,
      stop: "up",
      stopPrice,
      stopPriceType: "MP", // mark price
      timeInForce: "GTC",
    })) as KucoinEnvelope<any>;

    if (stopRes?.code !== KC_OK) {
      // Entry succeeded but the stop did not — do NOT run unprotected. Close it.
      await alertError(
        `openShort(${symbol}) STOP REJECTED — closing the entry to avoid an ` +
          `unprotected position, verify flat on kucoin.com`,
        `KuCoin ${stopRes?.code ?? "?"}: ${stopRes?.msg ?? "(no message)"}`,
      );
      await closePosition(symbol, "unprotected — stop rejected");
      return null;
    }
    return { orderId: orderId ?? "", fillPx, stopPx: stopPxNum };
  } catch (e) {
    await alertError(`openShort(${symbol})`, e);
    return null;
  }
}

/**
 * Cancel any untriggered stop orders left resting on a symbol. Called after a
 * position is closed so a stale stop-loss (placed by openShort) cannot survive
 * to trigger against a *future* position on the same coin. Best-effort — a
 * failure is logged but never blocks the close.
 */
async function cancelStopOrders(symbol: string): Promise<void> {
  if (IS_PAPER) return;
  try {
    const res = (await client.cancelAllStopOrders({
      symbol,
    })) as KucoinEnvelope<{ cancelledOrderIds?: string[] }>;
    if (res?.code !== KC_OK) {
      await alertError(
        `cancelStopOrders(${symbol}) — stale stop may remain, check kucoin.com`,
        `KuCoin ${res?.code ?? "?"}: ${res?.msg ?? "(no message)"}`,
      );
      return;
    }
    const n = res.data?.cancelledOrderIds?.length ?? 0;
    if (n > 0) console.log(`  ${symbol}: cancelled ${n} resting stop order(s)`);
  } catch (e) {
    await alertError(`cancelStopOrders(${symbol})`, e);
  }
}

/**
 * Close an open position at market (closeOrder closes the full size), then
 * cancel any stop order still resting on the symbol. The cancel matters most
 * on a TIMEOUT close: openShort placed a resting stop that never fired, and
 * if left on the book it could trigger against the next position on this coin.
 * (On a stop-triggered close the stop order is already consumed, but cancelling
 * is idempotent and harmless.)
 */
async function closePosition(symbol: string, reason: string): Promise<boolean> {
  if (IS_PAPER) return true;
  try {
    const res = (await client.submitOrder({
      clientOid: client.generateNewOrderID(),
      symbol,
      side: "buy",
      type: "market",
      closeOrder: true,
      timeInForce: "GTC",
    })) as KucoinEnvelope<any>;

    if (res?.code !== KC_OK) {
      await alertError(
        `closePosition(${symbol}) — ${reason} — verify on kucoin.com`,
        `KuCoin ${res?.code ?? "?"}: ${res?.msg ?? "(no message)"}`,
      );
      return false;
    }
    // Close succeeded — clear any stop order left resting on this symbol.
    await cancelStopOrders(symbol);
    return true;
  } catch (e) {
    await alertError(
      `closePosition(${symbol}) — ${reason} — verify on kucoin.com`,
      e,
    );
    return false;
  }
}

/**
 * Live position contract count for a symbol.
 *   > 0 / < 0  → open (sign = side)
 *   0          → flat (closed, or never opened)
 *   -1 sentinel → unknown (request failed) — caller must NOT treat as closed.
 */
async function fetchLivePositionQty(symbol: string): Promise<number> {
  if (IS_PAPER) return -1;
  try {
    const data = unwrap<any>(
      await client.getPosition({ symbol }),
      `getPosition(${symbol})`,
    );
    if (!data) return -1;
    if (data.isOpen === false) return 0;
    return Number(data.currentQty ?? 0);
  } catch {
    return -1;
  }
}

/**
 * Average entry price of the freshly-opened position, read from KuCoin.
 * A market order can fill far from the scanner's signal price when the market
 * moved between scan and execution — the stop and all P&L must anchor to THIS,
 * not the signal price. Polls getPosition a few times because the position can
 * take a moment to reflect after the entry fills. Returns null if it cannot be
 * determined (caller falls back to the signal price and alerts).
 */
async function fetchAvgEntryPrice(symbol: string): Promise<number | null> {
  if (IS_PAPER) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = unwrap<any>(
        await client.getPosition({ symbol }),
        `getPosition(${symbol})`,
      );
      if (data && data.isOpen !== false) {
        const px = Number(data.avgEntryPrice);
        if (Number.isFinite(px) && px > 0) return px;
      }
    } catch {
      /* transient — retry */
    }
    await sleep(300);
  }
  return null;
}

/**
 * Realised funding paid/earned over a position's life (USDT; negative = paid).
 * Sums the per-event `funding` amounts from getFundingHistory in [fromMs, toMs].
 * Shorts on negative funding PAY funding, so this is usually negative for this
 * strategy — a cost the backtest does not model. Best-effort: null on failure
 * (diagnostic only, never blocks a close).
 */
async function fetchFundingPaid(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<number | null> {
  if (IS_PAPER) return null;
  try {
    const res = (await client.getFundingHistory({
      symbol,
      from: fromMs,
      to: toMs,
    })) as KucoinEnvelope<{ dataList?: { funding?: number }[] }>;
    if (res?.code !== KC_OK || !res.data?.dataList) return null;
    return res.data.dataList.reduce(
      (sum, r) => sum + (Number(r.funding) || 0),
      0,
    );
  } catch {
    return null;
  }
}

// ─── Reconciliation ──────────────────────────────────────────────────────────
/**
 * Reconcile the local store against actual KuCoin positions. managePositions
 * already handles the "exchange closed my tracked position" direction (qty → 0).
 * The gap is the REVERSE — a position OPEN on KuCoin that the store does not
 * track (an orphan from a crash mid-open or a failed close). The bot would
 * never manage it (no stop watch, no timeout), so alert loudly. We do NOT
 * auto-close: an untracked position might be intentional, and a wrong close is
 * worse than a loud alert.
 */
async function reconcilePositions(store: KucoinPositionStore): Promise<void> {
  if (IS_PAPER) return;
  try {
    const data = unwrap<any[]>(await client.getPositions(), "getPositions");
    if (!data) return;
    const tracked = new Set(Object.keys(store.open).map(toKucoinSymbol));
    for (const p of data) {
      if (p.isOpen === false) continue;
      const qty = Number(p.currentQty ?? 0);
      if (qty === 0) continue;
      const sym = String(p.symbol ?? "");
      if (tracked.has(sym)) continue;
      const coin = fromKucoinSymbol(sym) || sym;
      const avg = Number(p.avgEntryPrice);
      const entryStr = Number.isFinite(avg) ? `, entry ~$${avg}` : "";
      const msg =
        `🚨 *altshortbot* — UNTRACKED *${coin}* position on KuCoin ` +
        `(qty ${qty}${entryStr}). The bot is NOT managing it — set a stop or ` +
        `close it manually on kucoin.com.`;
      console.error(`[RECONCILE] ${coin}: untracked position qty ${qty}`);
      await sendTelegram(msg);
    }
  } catch (e) {
    await alertError("reconcilePositions", e);
  }
}

// ─── Position management ───────────────────────────────────────────────────────
async function managePositions(store: KucoinPositionStore): Promise<void> {
  const nowMs = Date.now();

  for (const [coin, pos] of Object.entries(store.open)) {
    const symbol = toKucoinSymbol(coin);
    const ageH = (nowMs - pos.openedAt) / 3_600_000;
    const currentPx = await fetchCurrentPrice(symbol);

    if (currentPx === null) {
      console.log(`  ${coin}: could not fetch price — skipping`);
      continue;
    }

    const pnlPct = ((pos.entryPx - currentPx) / pos.entryPx) * 100;

    // Track excursion extremes for post-trade diagnostics: maxAdversePx = highest
    // price seen (worst for a short → MAE), maxFavorablePx = lowest (best → MFE).
    pos.maxAdversePx = Math.max(pos.maxAdversePx ?? pos.entryPx, currentPx);
    pos.maxFavorablePx = Math.min(pos.maxFavorablePx ?? pos.entryPx, currentPx);

    // Stop detection. Live: the exchange's stop order closed the position, so
    // currentQty becomes 0. Paper: compare price to the stored stop.
    let stopHit = false;
    if (!IS_PAPER) {
      const liveQty = await fetchLivePositionQty(symbol);
      if (liveQty === 0) stopHit = true;
      // liveQty === -1 → request failed; do NOT assume closed.
    } else {
      stopHit = currentPx >= pos.stopLossPx;
    }

    let closeReason: PaperTrade["closeReason"] | null = null;
    let closePx = currentPx;

    if (stopHit) {
      closeReason = "stop";
      closePx = IS_PAPER ? pos.stopLossPx : currentPx;
      // The stop order that fired is already consumed, but cancel defensively
      // in case of a partial fill or any other order resting on the symbol.
      if (!IS_PAPER) await cancelStopOrders(symbol);
    } else if (ageH >= RISK.timeoutH) {
      // closePosition market-closes AND cancels the never-fired resting stop.
      // Only finalize the close (record + delete) if it actually succeeded —
      // otherwise the position is STILL OPEN on the exchange and must be kept
      // for retry next run, not forgotten (a forgotten position is unmanaged
      // and a later signal on the same coin would stack a second position).
      if (!IS_PAPER) {
        const closed = await closePosition(symbol, "timeout");
        if (!closed) {
          console.log(
            `  ${coin}: timeout close FAILED — keeping position for next-run retry`,
          );
          continue; // do not record/delete; managePositions retries next run
        }
      }
      closeReason = "timeout";
    }

    if (closeReason) {
      const finalPnlPct = ((pos.entryPx - closePx) / pos.entryPx) * 100;
      const finalPnlUsdt = (finalPnlPct / 100) * pos.notionalUsdc;

      // ── Post-trade diagnostics ────────────────────────────────────────────
      const maxAdv = Math.max(pos.maxAdversePx ?? pos.entryPx, closePx);
      const maxFav = Math.min(pos.maxFavorablePx ?? pos.entryPx, closePx);
      const maePct = ((maxAdv - pos.entryPx) / pos.entryPx) * 100; // ≥0 worst against
      const mfePct = ((pos.entryPx - maxFav) / pos.entryPx) * 100; // ≥0 best in favor
      const holdH = (nowMs - pos.openedAt) / 3_600_000;
      const rMultiple = finalPnlPct / (RISK.stopLossPct * 100); // stop = -1R
      // Exit slippage (stops only): how far past the intended stop it actually
      // filled — positive = filled worse (higher) than the stop trigger.
      const exitSlipPct =
        closeReason === "stop"
          ? ((closePx - pos.stopLossPx) / pos.stopLossPx) * 100
          : 0;
      // Realised funding over the hold (USDT; negative = paid). Shorts on
      // negative funding pay — a cost the backtest does not model.
      const fundingPaid = await fetchFundingPaid(symbol, pos.openedAt, nowMs);

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
        fundingPaidUsdt: fundingPaid,
      };
      store.closed.push(trade);

      if (IS_PAPER) store.paperEquityUsdt += finalPnlUsdt;
      delete store.open[coin];

      await postSignalEvent("closed", {
        coin,
        openedAt: pos.openedAt,
        closedAt: nowMs,
        exitPx: closePx,
        pnlUsdc: finalPnlUsdt,
        pnlPct: finalPnlPct,
        closeReason,
        // diagnostics
        maePct,
        mfePct,
        holdH,
        rMultiple,
        exitSlipPct,
        fundingPaidUsdt: fundingPaid,
        entryPx: pos.entryPx,
        stopLossPx: pos.stopLossPx,
      });

      // All-in result: price P&L is what `pnlUsdc`/`rMultiple` measure, but a
      // short on negative funding also pays carry. Fold funding into R for the
      // headline so a flat-price timeout that bled funding does not read as a
      // harmless scratch. priceR (rMultiple) is preserved untouched above.
      const riskUsdt = RISK.stopLossPct * pos.notionalUsdc; // 1R, in USDT
      const fundingR =
        fundingPaid !== null && riskUsdt > 0 ? fundingPaid / riskUsdt : null;
      const allInR = fundingR !== null ? rMultiple + fundingR : null;

      const icon = finalPnlPct > 0 ? "✅" : "❌";
      const mode = IS_PAPER ? "📄 " : "";
      const fundingNote =
        fundingPaid !== null
          ? ` | funding $${fundingPaid.toFixed(2)} (${fundingR!.toFixed(2)}R → all-in ${allInR!.toFixed(2)}R)`
          : "";
      await sendTelegram(
        `${mode}${icon} *${coin}* closed (${closeReason})\n` +
          `Entry: $${pos.entryPx.toFixed(6)} → Exit: $${closePx.toFixed(6)}\n` +
          `P&L: ${finalPnlPct.toFixed(2)}% (${rMultiple.toFixed(2)}R) | USDT: ${finalPnlUsdt.toFixed(2)}\n` +
          `MAE ${maePct.toFixed(1)}% | MFE ${mfePct.toFixed(1)}% | ${holdH.toFixed(1)}h${fundingNote}`,
      );
      console.log(
        `  ${coin}: closed (${closeReason}) ${finalPnlPct.toFixed(2)}% (${rMultiple.toFixed(2)}R) ` +
          `MAE ${maePct.toFixed(1)}% MFE ${mfePct.toFixed(1)}% — $${finalPnlUsdt.toFixed(2)}`,
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
  store: KucoinPositionStore,
  equity: number,
): Promise<void> {
  const { coin, type: signalType, confidence, entry, fundingApr } = sig;

  // Skip if already holding this coin.
  if (store.open[coin]) {
    console.log(`  ${coin}: already open — skipping`);
    return;
  }

  // Hard exclude (e.g. H — Bybit/KuCoin price split). Never trade these.
  if (EXCLUDE_COINS.has(coin)) {
    console.log(`  ${coin}: on executor exclude list — skipping`);
    return;
  }

  // Re-entry cooldown: do not re-short a coin that stopped out within the last
  // reentryCooldownH. Re-stacking into a coin that just stopped you (still
  // squeezing) is a net loser; blocking it is drawdown insurance.
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

  // "Listed on KuCoin" check — the contract must be in the startup cache
  // (USDT-margined, status Open). Coins NOT on KuCoin are traded MANUALLY on
  // Bybit, so instead of silently skipping, surface an actionable ticket. The
  // signal's `entry` IS the Bybit price (the scanner runs on Bybit), so the
  // entry + 15% stop are accurate for a manual Bybit order.
  const symbol = toKucoinSymbol(coin);
  const spec = contractCache.get(symbol);
  if (!spec) {
    const manualStop = entry * (1 + RISK.stopLossPct);
    console.log(`  ${coin}: not on KuCoin — manual Bybit alert sent`);
    await sendTelegram(
      `🟡 *${coin}:* not on KuCoin, *place manually on Bybit*\n` +
        `Entry: $${entry.toFixed(6)} | Stop: $${manualStop.toFixed(6)} ` +
        `(+${(RISK.stopLossPct * 100).toFixed(0)}%)\n` +
        `Funding: ${fundingApr.toFixed(0)}% APR | ${confidence}`,
    );
    return;
  }

  // Venue-agreement / staleness guard. The signal's `entry` is the scanner's
  // Bybit price; confirm the live KuCoin price agrees before trading. A large
  // divergence means a cross-venue mismatch (redenomination) or a runaway move
  // since the scan — the signal no longer describes what we'd trade.
  const livePx = await fetchCurrentPrice(symbol);
  if (livePx === null) {
    console.log(`  ${coin}: could not fetch live KuCoin price — skipping`);
    return;
  }
  const divergence = Math.abs(livePx - entry) / entry;
  if (divergence > MAX_SIGNAL_DIVERGENCE) {
    const pctStr = (divergence * 100).toFixed(0);
    console.log(
      `  ${coin}: signal $${entry.toFixed(6)} vs live KuCoin $${livePx.toFixed(6)} ` +
        `diverge ${pctStr}% (> ${(MAX_SIGNAL_DIVERGENCE * 100).toFixed(0)}%) — skipping`,
    );
    await sendTelegram(
      `⚠️ *${coin}* skipped — signal $${entry.toFixed(6)} vs live $${livePx.toFixed(6)} ` +
        `diverge ${pctStr}% (venue mismatch / stale signal)`,
    );
    return;
  }

  const leverage = Math.min(RISK.maxLeverage, spec.maxLeverage);

  // Risk-based sizing → integer contracts (round-up policy). Sizing uses the
  // signal price to pick a contract count; once the order fills, bookkeeping is
  // re-anchored to the actual fill price returned by openShort.
  const size = calcSize(equity, entry, spec);

  const opened = await openShort(
    symbol,
    size.contracts,
    entry,
    leverage,
    spec.tickSize,
  );
  if (!opened) return;
  const { fillPx, stopPx } = opened;

  // Anchor ALL bookkeeping to the actual fill price, not the signal price —
  // entryPx, stop, notional and risk are meaningless if the fill diverged.
  const sizeCoin = size.contracts * spec.multiplier; // contracts × coins/contract
  const notionalUsdt = sizeCoin * fillPx;
  const actualRiskFrac = (notionalUsdt * RISK.stopLossPct) / equity;
  const riskPctStr = (actualRiskFrac * 100).toFixed(1);

  const record: PositionRecord = {
    coin,
    openedAt: Date.now(),
    entryPx: fillPx,
    sizeCoin,
    notionalUsdc: notionalUsdt,
    stopLossPx: stopPx,
    targetPx: fillPx * (1 - RISK.stopLossPct), // informational only
    trailingActive: false,
    signalType: signalType as PositionRecord["signalType"],
    signalConfidence: confidence as PositionRecord["signalConfidence"],
    isPaper: IS_PAPER,
    maxAdversePx: fillPx, // seed excursion tracking at the entry price
    maxFavorablePx: fillPx,
  };
  store.open[coin] = record;

  // Open-time diagnostics for performance debugging.
  const signalAgeSec = (record.openedAt - sig.firedAt) / 1000;
  const venueDivergencePct = ((livePx - entry) / entry) * 100; // KuCoin vs signal
  const fillGapPct = ((fillPx - entry) / entry) * 100; // fill vs signal
  const estLiqDistPct = 100 / leverage; // ~liq distance for an isolated short

  await postSignalEvent("opened", {
    coin,
    signalType,
    confidence,
    firedAt: sig.firedAt,
    openedAt: record.openedAt,
    entryPx: fillPx,
    signalPx: entry,
    stopLossPx: stopPx,
    fundingApr: sig.fundingApr,
    notionalUsdc: notionalUsdt,
    leverage,
    isPaper: IS_PAPER,
    // diagnostics
    signalAgeSec,
    venueDivergencePct,
    fillGapPct,
    estLiqDistPct,
  });

  // Round-up can push realized risk above target — flag it (informational).
  const riskNote =
    actualRiskFrac > RISK.riskPerTrade * RISK_NOTE_MULTIPLE
      ? `\n⚠️ size rounded up — actual risk ${riskPctStr}% ` +
        `(target ${(RISK.riskPerTrade * 100).toFixed(0)}%)`
      : "";

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
      `Size: ${size.contracts} contract(s) | Notional: $${notionalUsdt.toFixed(0)} | ${leverage}×` +
      riskNote +
      slipNote,
  );
  console.log(
    `  ${coin}: SHORT opened — ${size.contracts} contract(s) entry $${fillPx.toFixed(6)} ` +
      `stop $${stopPx.toFixed(6)} notional $${notionalUsdt.toFixed(0)} ` +
      `risk ${riskPctStr}% (${IS_PAPER ? "PAPER" : "LIVE"})`,
  );
}

// ─── Status display ────────────────────────────────────────────────────────────
async function printStatus(store: KucoinPositionStore): Promise<void> {
  const nowMs = Date.now();
  console.log(`\nKuCoin — ${new Date().toISOString()}`);
  console.log(`Mode: ${IS_PAPER ? "PAPER" : "LIVE"}`);
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
      const px = await fetchCurrentPrice(toKucoinSymbol(coin));
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
  console.log(`\nKuCoin Executor — ${new Date().toISOString()}`);
  console.log(`Mode: ${IS_PAPER ? "PAPER" : "LIVE"}`);

  const store = loadPositions();

  if (IS_STATUS) {
    await printStatus(store);
    return;
  }

  // Retry any Convex events that failed on a previous run (non-fatal, FIFO).
  await flushOutbox();

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

  // ── Reconcile against the exchange — catch untracked (orphan) positions ──────
  // Runs every cycle (not just when the store has positions): the whole point is
  // to find positions the store does NOT know about.
  await reconcilePositions(store);

  // ── Execute queued signals ──────────────────────────────────────────────────
  const queue = loadQueue();
  if (!queue.length) {
    console.log("Queue empty — nothing to execute.\n");
    savePositions(store);
    return;
  }

  console.log(`\n${queue.length} signal(s) in queue...`);

  // Position cap — check before clearing the queue.
  if (Object.keys(store.open).length >= RISK.maxPositions) {
    console.log(
      `  At max positions (${RISK.maxPositions}) — signals deferred to next run`,
    );
    savePositions(store);
    return;
  }

  // Load the tradeable-contract universe before clearing the queue — if this
  // fails, signals are preserved for the next run.
  if (!(await loadContracts())) {
    console.log("  Could not load KuCoin contracts — signals preserved");
    savePositions(store);
    return;
  }

  // Account equity — also before clearing the queue.
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

  // Safe to clear — contracts + equity confirmed, execution proceeding.
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
  console.log(`\nDone. ${executed} new position(s) processed.\n`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(async (e) => {
    await alertError("executor crashed", e);
    process.exit(1);
  });
}
