/**
 * check_signal_pnl.ts
 * ===================
 * One-shot P&L check across a batch of BUILDING signals pulled from Telegram.
 *
 * For each signal it models the executor's actual exit logic over the 48h
 * holding window (the executor force-closes every position at RISK.timeoutH):
 *   • fetches 1h klines for the [entry, entry+48h] window
 *   • stopped  → high touched entry*1.20 within 48h            → P&L = -20%
 *   • timeout  → 48h elapsed, no stop → exit at the 48h close  → P&L from that
 *   • open     → <48h since entry, no stop yet → still live    → current px
 * It does NOT model targetPx — the executor treats the 25% target as
 * informational and never closes on it. The 'mfe' column (max favourable
 * excursion) shows how far the short got in profit, so you can see whether
 * a real take-profit would have helped.
 *
 * Signals are grouped by what the bot decided:
 *   queued      → bot auto-queued for shorting — the ONLY signals it trades
 *   not_queued  → extreme funding but OI rising — the OI gate blocked it
 *   wait        → BUILDING only, "await exhaustion" — no trade was taken
 *
 * "acct" column = impact on account equity given the bot's position sizing
 * (a trade risks RISK_PER_TRADE of equity at a STOP_PCT stop, so a 20% adverse
 * move = -2% account, a +10% move = +1% account, etc). This is the number that
 * matters for the strategy — raw price % alone ignores how positions are sized.
 *
 * Run:
 *   npx tsx check_signal_pnl.ts                  # 20% stop, 48h window
 *   npx tsx check_signal_pnl.ts --stop 20        # wider stop
 *   npx tsx check_signal_pnl.ts --stop 20 --tp 15  # stop + take-profit
 *   npx tsx check_signal_pnl.ts --timeout 72     # longer hold window
 *   npx tsx check_signal_pnl.ts --sweep          # score QUEUED at 15/20/25/30/35% stop
 *   npx tsx check_signal_pnl.ts --tpsweep --stop 20  # sweep TP at a fixed stop
 *
 * Per-trade columns: 'mfe' = max favourable excursion (best the short got),
 * 'mae' = max adverse excursion (worst it was underwater), both measured up
 * to the exit bar. --sweep / --tpsweep show whether a level is a robust
 * plateau or an overfit spike.
 *
 * NOTE: entry prices are the BUILDING-alert prices. For 'queued' signals the
 * executor's real fill may differ slightly. For 'wait' / 'not_queued' signals
 * no trade was taken — their P&L is hypothetical ("what if shorted at BUILDING").
 */

// ─── Config ───────────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.split("=")[1];
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BB = "https://api.bybit.com";
const RISK_PER_TRADE = 0.02; // 2% account risk per trade — see CLAUDE.md

// Holding window in hours. Default 48 (the bot's live RISK.timeoutH).
// Override: --timeout 72. Unlike --stop this does NOT resize positions —
// it only moves the exit window, so wins/losses keep full account impact.
const timeoutRaw = parseFloat(argValue("--timeout") ?? "48");
const TIMEOUT_H =
  Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 48;

// Short stop %. Default 20 (the bot's live value). Override: --stop 25
// NOTE: STOP_PCT also drives acctImpact(). Widening the stop shrinks the
// position (notional = risk / stop%), so a stop stays ~-2% of equity but
// every winner scales DOWN in account terms too. That tradeoff is the point —
// read the 'acct' column, not the raw price %.
const stopRaw = parseFloat(argValue("--stop") ?? "20");
const STOP_PCT = Number.isFinite(stopRaw) && stopRaw > 0 ? stopRaw : 20;

// --sweep evaluates the QUEUED set at several stop %s in one pass (klines are
// fetched once per signal, then re-scored at each level). Edit to taste.
const SWEEP_MODE = process.argv.includes("--sweep");
const SWEEP_LEVELS = [15, 20, 25, 30, 35];

// Take-profit %. Default 0 = no TP (ride to stop or timeout). Override: --tp 20
// A TP exits the short when price has fallen TP% from entry. It does NOT
// resize positions (only the stop does), so a TP exit at +TP% price is a win.
const tpRaw = parseFloat(argValue("--tp") ?? "0");
const TP_PCT = Number.isFinite(tpRaw) && tpRaw > 0 ? tpRaw : 0;

// --tpsweep scores the QUEUED set across TP levels at a fixed stop (--stop).
const TPSWEEP_MODE = process.argv.includes("--tpsweep");
const TP_SWEEP_LEVELS = [10, 15, 20, 25];

type Status = "queued" | "not_queued" | "wait";

interface Signal {
  coin: string;
  entry: number;
  date: string; // DD/MM/YYYY HH:MM, UTC
  status: Status;
  conf?: "HIGH" | "MEDIUM";
}

// ─── Signals ────────────────────────────────────────────────────────────────
// All times UTC. The original Telegram entries were Dublin local (UTC+1) and
// have been shifted -1h to true UTC so the kline window starts at the right
// place. The 21/05 batch (Fired/Age/Entry table) was already in UTC.
const SIGNALS: Signal[] = [
  // ── From Telegram decision lines — status is known ──
  { coin: "RAVE", entry: 0.8076, date: "09/05/2026 23:12", status: "wait" },
  { coin: "XION", entry: 0.1638, date: "10/05/2026 04:12", status: "wait" },
  { coin: "1000XEC", entry: 0.0095, date: "10/05/2026 08:11", status: "wait" },
  { coin: "SNT", entry: 0.0115, date: "10/05/2026 09:12", status: "wait" },
  { coin: "SOLAYER", entry: 0.13, date: "10/05/2026 12:12", status: "wait" },
  { coin: "WAL", entry: 0.0845, date: "10/05/2026 14:12", status: "wait" },
  { coin: "SONIC", entry: 0.0506, date: "11/05/2026 06:12", status: "wait" },
  { coin: "SAPIEN", entry: 0.1347, date: "12/05/2026 08:13", status: "wait" },
  { coin: "SOLV", entry: 0.0056, date: "12/05/2026 12:13", status: "queued" },
  {
    coin: "PEAQ",
    entry: 0.0208,
    date: "12/05/2026 16:12",
    status: "not_queued",
  },
  {
    coin: "SOLV",
    entry: 0.0056,
    date: "12/05/2026 16:12",
    status: "not_queued",
  },
  { coin: "MBOX", entry: 0.0156, date: "13/05/2026 08:12", status: "queued" },
  {
    coin: "AIGENSYN",
    entry: 0.0448,
    date: "14/05/2026 13:17",
    status: "queued",
  },
  {
    coin: "AIGENSYN",
    entry: 0.0471,
    date: "15/05/2026 08:07",
    status: "queued",
  },
  {
    coin: "IRYS",
    entry: 0.0564,
    date: "15/05/2026 16:52",
    status: "not_queued",
  },
  {
    coin: "STORJ",
    entry: 0.1367,
    date: "15/05/2026 20:07",
    status: "not_queued",
  },
  { coin: "BOBBOB", entry: 0.0064, date: "17/05/2026 00:07", status: "queued" },
  { coin: "EDEN", entry: 0.0552, date: "17/05/2026 18:07", status: "queued" },
  {
    coin: "FIDA",
    entry: 0.0192,
    date: "17/05/2026 20:07",
    status: "queued",
    conf: "HIGH",
  },

  // ── Added 21/05 from the Fired/Age/Entry table ──
  // status defaulted to "queued": the table tracks Age, which implies these
  // were queued/tracked trades (the AIGENSYN rows in that same table match
  // confirmed-queued signals above). Change any that were not_queued / wait.
  { coin: "MLN", entry: 3.376, date: "14/05/2026 12:12", status: "queued" },
  { coin: "TAC", entry: 0.0221, date: "14/05/2026 20:12", status: "queued" },
  { coin: "MLN", entry: 3.376, date: "15/05/2026 04:12", status: "queued" },
  {
    coin: "BOBBOB",
    entry: 0.008225,
    date: "17/05/2026 22:22",
    status: "queued",
  },
  { coin: "FOGO", entry: 0.0183, date: "20/05/2026 00:07", status: "queued" },
  { coin: "PROMPT", entry: 0.0478, date: "20/05/2026 00:07", status: "queued" },
  { coin: "PROMPT", entry: 0.0425, date: "20/05/2026 06:07", status: "queued" },
];

interface Result extends Signal {
  price?: number; // current market price
  /** stopped | tp = take-profit hit | timeout = closed at window end | open = still live */
  outcome?: "stopped" | "tp" | "timeout" | "open";
  exitPrice?: number; // stop level, TP level, timeout close, or current price
  realizedPnl?: number; // % — final for stopped/tp/timeout, unrealised for open
  mfePct?: number; // max favourable excursion, measured up to the exit bar
  maePct?: number; // max adverse excursion, measured up to the exit bar
  stopPctUsed?: number; // stop level this result was scored at
  tpPctUsed?: number; // TP level scored at (0 = none)
  noKlineData?: boolean; // klines unavailable — fell back to current price
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseDateMs(s: string): number {
  const [d, t] = s.split(" ");
  const [dd, mm, yyyy] = d.split("/").map(Number);
  const [hh, min] = t.split(":").map(Number);
  return Date.UTC(yyyy, mm - 1, dd, hh, min);
}

function shortDate(s: string): string {
  const [date, time] = s.split(" ");
  const [dd, mm] = date.split("/");
  return `${dd}/${mm} ${time}`;
}

async function fetchJSON(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ─── Fetch + evaluate ──────────────────────────────────────────────────────
interface SignalData {
  price: number;
  inWindow: string[][]; // 1h klines within [entry, entry + TIMEOUT_H]
  windowComplete: boolean;
}

type Fetched = { sig: Signal; data: SignalData | { error: string } };

/** Fetches market data for one signal. Stop-level-independent — call once. */
async function fetchSignalData(
  sig: Signal,
): Promise<SignalData | { error: string }> {
  const symbol = `${sig.coin}USDT`;
  try {
    const tk = await fetchJSON(
      `${BB}/v5/market/tickers?category=linear&symbol=${symbol}`,
    );
    const ticker = tk?.result?.list?.[0];
    if (!ticker?.lastPrice) {
      return { error: "no ticker — delisted or symbol mismatch?" };
    }
    const price = parseFloat(ticker.lastPrice);

    const entryMs = parseDateMs(sig.date);
    const windowEndMs = entryMs + TIMEOUT_H * 3_600_000;
    const windowComplete = windowEndMs <= Date.now();

    let inWindow: string[][] = [];
    try {
      const kl = await fetchJSON(
        `${BB}/v5/market/kline?category=linear&symbol=${symbol}` +
          `&interval=60&start=${entryMs}&limit=1000`,
      );
      const list: string[][] = kl?.result?.list ?? [];
      inWindow = list.filter((c) => {
        const t = parseInt(c[0], 10);
        return t >= entryMs && t <= windowEndMs;
      });
    } catch {
      inWindow = [];
    }

    return { price, inWindow, windowComplete };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Scores a signal at a given stop level and optional take-profit. Pure.
 * Walks candles oldest->newest so stop/TP ordering is honoured: whichever
 * level is touched first in time decides the exit. When a single 1h candle
 * touches BOTH (low <= TP and high >= stop), intra-bar order is unknown, so
 * the stop is assumed to fill — never assume the favourable fill.
 * MFE/MAE are accumulated only up to the exit bar (what the position saw).
 */
function evaluate(
  sig: Signal,
  data: SignalData,
  stopPct: number,
  tpPct = 0,
): Result {
  const { price, inWindow, windowComplete } = data;
  const noKlineData = inWindow.length === 0;

  const stopLevel = sig.entry * (1 + stopPct / 100);
  const tpLevel = tpPct > 0 ? sig.entry * (1 - tpPct / 100) : 0;

  // Bybit returns klines newest-first — sort ascending to walk chronologically.
  const bars = [...inWindow].sort(
    (a, b) => parseInt(a[0], 10) - parseInt(b[0], 10),
  );

  let maxHigh = -Infinity;
  let minLow = Infinity;
  let outcome: Result["outcome"] | null = null;
  let exitPrice = price;

  for (const c of bars) {
    const high = parseFloat(c[2]);
    const low = parseFloat(c[3]);
    maxHigh = Math.max(maxHigh, high);
    minLow = Math.min(minLow, low);

    const stopTouched = high >= stopLevel;
    const tpTouched = tpPct > 0 && low <= tpLevel;

    if (stopTouched) {
      // stop takes priority — also covers the both-touched ambiguous bar
      outcome = "stopped";
      exitPrice = stopLevel;
      break;
    }
    if (tpTouched) {
      outcome = "tp";
      exitPrice = tpLevel;
      break;
    }
  }

  // No stop/TP within the window
  if (!outcome) {
    if (windowComplete) {
      outcome = "timeout";
      exitPrice = bars.length ? parseFloat(bars[bars.length - 1][4]) : price;
    } else {
      outcome = "open";
      exitPrice = price;
    }
  }

  const mfePct =
    minLow < Infinity
      ? Math.max(0, ((sig.entry - minLow) / sig.entry) * 100)
      : 0;
  const maePct =
    maxHigh > -Infinity
      ? Math.max(0, ((maxHigh - sig.entry) / sig.entry) * 100)
      : 0;
  const realizedPnl = ((sig.entry - exitPrice) / sig.entry) * 100;

  return {
    ...sig,
    price,
    outcome,
    exitPrice,
    realizedPnl,
    mfePct,
    maePct,
    stopPctUsed: stopPct,
    tpPctUsed: tpPct,
    noKlineData,
  };
}

/** Account-equity impact of a trade given the bot's risk-based sizing */
function acctImpact(pricePnlPct: number, stopPct: number): number {
  return (pricePnlPct / stopPct) * (RISK_PER_TRADE * 100);
}

function fmtRow(r: Result): string {
  const coin = r.coin.padEnd(9);
  if (r.error) return `  ${coin} ⚠️  ${r.error}`;
  const pnl = r.realizedPnl!;
  const sp = r.stopPctUsed ?? STOP_PCT;
  const verdict =
    r.outcome === "stopped"
      ? "❌ STOPPED"
      : r.outcome === "tp"
        ? "🎯 TP hit"
        : r.outcome === "open"
          ? pnl >= 0
            ? "⏳ OPEN (winning)"
            : "⏳ OPEN (losing)"
          : pnl > 0
            ? "✅ timeout win"
            : "😐 timeout loss";
  const conf = r.conf === "HIGH" ? "🟢" : "  ";
  const note = r.noKlineData ? "  (no klines — current px)" : "";
  return (
    `  ${coin}${conf} ${shortDate(r.date).padEnd(12)} ` +
    `$${r.entry} → $${r.exitPrice!.toFixed(6).padStart(10)}  ` +
    `${pnl.toFixed(1).padStart(7)}%  ` +
    `acct ${acctImpact(pnl, sp).toFixed(2).padStart(6)}%  ` +
    `mae ${r.maePct!.toFixed(0).padStart(3)}%  ` +
    `mfe ${r.mfePct!.toFixed(0).padStart(3)}%  ` +
    `${verdict}${note}`
  );
}

// ─── Summary ────────────────────────────────────────────────────────────────
interface QueuedStats {
  closedN: number;
  openN: number;
  stopped: number;
  toWin: number;
  toLoss: number;
  wins: number;
  realisedAcct: number;
  openAcct: number;
}

function summariseQueued(queued: Result[], stopPct: number): QueuedStats {
  const q = queued.filter((r) => !r.error);
  const closed = q.filter((r) => r.outcome !== "open");
  const open = q.filter((r) => r.outcome === "open");
  return {
    closedN: closed.length,
    openN: open.length,
    stopped: closed.filter((r) => r.outcome === "stopped").length,
    toWin: closed.filter((r) => r.outcome === "timeout" && r.realizedPnl! > 0)
      .length,
    toLoss: closed.filter((r) => r.outcome === "timeout" && r.realizedPnl! <= 0)
      .length,
    wins: closed.filter((r) => r.realizedPnl! > 0).length,
    realisedAcct: closed.reduce(
      (a, r) => a + acctImpact(r.realizedPnl!, stopPct),
      0,
    ),
    openAcct: open.reduce((a, r) => a + acctImpact(r.realizedPnl!, stopPct), 0),
  };
}

// ─── Single-run mode ────────────────────────────────────────────────────────
function runSingle(fetched: Fetched[]): void {
  console.log(
    `Checking ${SIGNALS.length} signals — ` +
      `stop ${STOP_PCT}%, ${TP_PCT > 0 ? `TP ${TP_PCT}%` : "no TP"}, ` +
      `timeout ${TIMEOUT_H}h\n`,
  );

  const results: Result[] = fetched.map(({ sig, data }) =>
    "error" in data
      ? { ...sig, error: data.error }
      : evaluate(sig, data, STOP_PCT, TP_PCT),
  );

  const groups: Record<Status, Result[]> = {
    queued: [],
    not_queued: [],
    wait: [],
  };
  for (const r of results) groups[r.status].push(r);

  const labels: Record<Status, string> = {
    queued: "📐 QUEUED — bot auto-shorted these (the trades that count)",
    not_queued:
      "⚠️  NOT QUEUED — OI-rising gate blocked the trade (hypothetical)",
    wait: "⏳ WAIT — BUILDING only, no trade taken (hypothetical from BUILDING px)",
  };

  for (const status of ["queued", "not_queued", "wait"] as Status[]) {
    console.log(`\n${labels[status]}`);
    if (!groups[status].length) {
      console.log("  (none)");
      continue;
    }
    for (const r of groups[status]) console.log(fmtRow(r));
  }

  const s = summariseQueued(groups.queued, STOP_PCT);
  console.log(`\n${"─".repeat(64)}`);
  if (s.closedN || s.openN) {
    console.log(`QUEUED summary — ${s.closedN + s.openN} signals`);
    console.log(
      `  Closed: ${s.closedN}  (${s.stopped} stopped · ` +
        `${s.toWin} timeout win · ${s.toLoss} timeout loss)`,
    );
    console.log(`  Still open: ${s.openN}`);
    if (s.closedN) {
      console.log(
        `  Win rate (closed):   ${((s.wins / s.closedN) * 100).toFixed(0)}%`,
      );
      console.log(
        `  REALISED acct P&L:   ${s.realisedAcct >= 0 ? "+" : ""}` +
          `${s.realisedAcct.toFixed(2)}% of equity over ${s.closedN} closed trades`,
      );
      console.log(
        `  Avg per closed:      ${s.realisedAcct >= 0 ? "+" : ""}` +
          `${(s.realisedAcct / s.closedN).toFixed(2)}% equity`,
      );
    }
    if (s.openN) {
      console.log(
        `  Unrealised (open):   ${s.openAcct >= 0 ? "+" : ""}` +
          `${s.openAcct.toFixed(2)}% of equity — not final, will move`,
      );
    }
  } else {
    console.log("QUEUED summary — no valid trades to summarise");
  }

  const errs = results.filter((r) => r.error);
  if (errs.length) {
    console.log(
      `\n${errs.length} symbol(s) could not be checked: ` +
        errs.map((r) => r.coin).join(", "),
    );
  }
}

// ─── Sweep mode ─────────────────────────────────────────────────────────────
function runSweep(fetched: Fetched[]): void {
  console.log(
    `Stop sweep — levels [${SWEEP_LEVELS.join(", ")}]%, ` +
      `timeout ${TIMEOUT_H}h, ${SIGNALS.length} signals\n`,
  );
  console.log("  QUEUED closed trades, re-scored at each stop level:\n");
  console.log("   stop   closed  stopped   win%    realised   avg/trade");
  console.log(`  ${"─".repeat(53)}`);

  const queuedFetched = fetched.filter(({ sig }) => sig.status === "queued");

  for (const lvl of SWEEP_LEVELS) {
    const queued: Result[] = queuedFetched.map(({ sig, data }) =>
      "error" in data
        ? { ...sig, error: data.error }
        : evaluate(sig, data, lvl, TP_PCT),
    );
    const s = summariseQueued(queued, lvl);
    const winPct = s.closedN ? (s.wins / s.closedN) * 100 : 0;
    const avg = s.closedN ? s.realisedAcct / s.closedN : 0;
    const real = `${s.realisedAcct >= 0 ? "+" : ""}${s.realisedAcct.toFixed(2)}%`;
    const avgS = `${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`;
    console.log(
      `  ${(lvl + "%").padStart(5)}   ` +
        `${String(s.closedN).padStart(5)}   ` +
        `${String(s.stopped).padStart(6)}   ` +
        `${(winPct.toFixed(0) + "%").padStart(5)}   ` +
        `${real.padStart(8)}   ` +
        `${avgS.padStart(8)}`,
    );
  }

  console.log(
    `\n  Realised = QUEUED closed trades only (open trades excluded).`,
  );
  console.log(
    `  Read the shape: a broad plateau across levels = a robust effect;`,
  );
  console.log(
    `  a lone spike at one level = overfit to this sample. n is small either way.`,
  );

  const errs = fetched.filter(({ data }) => "error" in data);
  if (errs.length) {
    console.log(
      `\n  ${errs.length} symbol(s) skipped: ` +
        errs.map(({ sig }) => sig.coin).join(", "),
    );
  }
}

// ─── TP sweep mode ──────────────────────────────────────────────────────────
function runTpSweep(fetched: Fetched[]): void {
  // Lock the trade set: only QUEUED signals whose 48h window is COMPLETE.
  // A TP is an intra-window exit, so it can close a still-open trade — that
  // would change the trade count per row and make realised totals
  // non-comparable. Scoring one fixed set at every TP keeps it a clean A/B.
  const queued = fetched.filter(({ sig }) => sig.status === "queued");
  const resolvable: { sig: Signal; data: SignalData }[] = [];
  let openCount = 0;
  let errCount = 0;
  for (const f of queued) {
    if ("error" in f.data) errCount++;
    else if (f.data.windowComplete)
      resolvable.push({ sig: f.sig, data: f.data });
    else openCount++;
  }

  console.log(
    `Take-profit sweep — TP levels [none, ${TP_SWEEP_LEVELS.join(", ")}]%, ` +
      `fixed stop ${STOP_PCT}%, timeout ${TIMEOUT_H}h`,
  );
  console.log(
    `  Locked to ${resolvable.length} QUEUED signals with a complete window` +
      `${openCount ? ` (${openCount} still-open excluded)` : ""}.\n`,
  );
  console.log("    tp   trades   tp✓  stop✗  t/out   win%   realised  payoff");
  console.log(`  ${"─".repeat(58)}`);

  for (const tp of [0, ...TP_SWEEP_LEVELS]) {
    const scored = resolvable.map(({ sig, data }) =>
      evaluate(sig, data, STOP_PCT, tp),
    );
    const tpHit = scored.filter((r) => r.outcome === "tp").length;
    const stopped = scored.filter((r) => r.outcome === "stopped").length;
    const tout = scored.filter((r) => r.outcome === "timeout").length;
    const wins = scored.filter((r) => r.realizedPnl! > 0);
    const losses = scored.filter((r) => r.realizedPnl! <= 0);
    const winPct = scored.length ? (wins.length / scored.length) * 100 : 0;
    const realised = scored.reduce(
      (a, r) => a + acctImpact(r.realizedPnl!, STOP_PCT),
      0,
    );
    const avgWin = wins.length
      ? wins.reduce((a, r) => a + acctImpact(r.realizedPnl!, STOP_PCT), 0) /
        wins.length
      : 0;
    const avgLoss = losses.length
      ? losses.reduce((a, r) => a + acctImpact(r.realizedPnl!, STOP_PCT), 0) /
        losses.length
      : 0;
    const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
    const real = `${realised >= 0 ? "+" : ""}${realised.toFixed(2)}%`;

    console.log(
      `  ${(tp === 0 ? "none" : `${tp}%`).padStart(5)}  ` +
        `${String(scored.length).padStart(6)}  ` +
        `${String(tpHit).padStart(4)}  ` +
        `${String(stopped).padStart(5)}  ` +
        `${String(tout).padStart(5)}   ` +
        `${(winPct.toFixed(0) + "%").padStart(5)}   ` +
        `${real.padStart(8)}   ` +
        `${payoff ? payoff.toFixed(2) : "—"}`,
    );
  }

  console.log(
    `\n  All rows score the SAME ${resolvable.length} trades — ` +
      `realised totals are directly comparable.`,
  );
  console.log(
    `  payoff = avg win / avg loss (account terms). A TP caps winners, so it`,
  );
  console.log(
    `  usually LOWERS payoff; it only helps overall if it rescues more stops`,
  );
  console.log(
    `  than it caps winners. Watch realised, not win%: a high win% with flat`,
  );
  console.log(`  or falling realised means the TP is cutting winners short.`);

  if (errCount) {
    console.log(`\n  ${errCount} QUEUED symbol(s) skipped (fetch error).`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Fetch each signal's market data exactly once, then score.
  const fetched: Fetched[] = [];
  for (const s of SIGNALS) {
    fetched.push({ sig: s, data: await fetchSignalData(s) });
  }
  if (TPSWEEP_MODE) runTpSweep(fetched);
  else if (SWEEP_MODE) runSweep(fetched);
  else runSingle(fetched);
}

main().catch((e) => {
  console.error("check_signal_pnl crashed:", e);
  process.exit(1);
});
