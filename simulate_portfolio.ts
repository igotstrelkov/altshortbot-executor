/**
 * simulate_portfolio.ts
 * ======================
 * Runs the queued signals from universe_result.json through the live
 * executor's actual position-sizing, concurrency, and exit rules, producing
 * an equity curve and — the point of the whole exercise — a max-drawdown.
 *
 * analyze_stops.ts measured per-trade P&L in isolation. This adds the two
 * things that isolation misses:
 *   • CONCURRENCY — maxPositions caps how many trades run at once; signals
 *     that fire when all slots are full are SKIPPED, not taken.
 *   • COMPOUNDING / DRAWDOWN — position size scales with current equity, and
 *     correlated losing clusters show up as an equity-curve drawdown.
 *
 * Exit model — matches bybit_executor.ts exactly: a SHORT closes ONLY on
 *   • stop   — price rose to stopLossPct above entry  → P&L = -1R
 *   • timeout— timeoutH hours elapsed                            → P&L = -(finalPct/stop) R
 * There is NO take-profit and NO trailing stop in the executor, so a winning
 * short rides until it either reverses into the stop or hits the timeout.
 *
 * Sizing — verbatim from bybit_executor.ts:
 *   riskUsdt = equity * riskPerTrade
 *   notional = riskUsdt / stopLossPct
 *   → a stop-out costs exactly riskUsdt (= riskPerTrade of equity, i.e. 1R)
 *
 * Run the universe backtest first:
 *   npx tsx run_universe_backtest.ts
 * Then:
 *   npx tsx simulate_portfolio.ts
 *   npx tsx simulate_portfolio.ts --start 25000 --max-positions 10
 *
 * MODELING NOTE: when a position stops out, its slot is released at the
 * stop-fire moment (openMs + stopHitH[stop] hours) — read from per-signal
 * stopHitH data emitted by backtest_signals.ts. Timeout trades release at
 * the full timeout. Older result files without stopHitH fall back to the
 * previous "full timeout regardless" behavior, which OVER-counts skips and
 * disproportionately penalises longer timeouts. Re-run run_universe_backtest.ts
 * to regenerate result files with stopHitH for a fair comparison. Per-trade
 * P&L is exact in both cases.
 */

import { existsSync, readFileSync } from "fs";

// --file <path> overrides the input (e.g. universe_result_notrend.json
// for the trend-filter-off comparison run); defaults to universe_result.json.
const fileArgIdx = process.argv.indexOf("--file");
const RESULT_FILE =
  fileArgIdx >= 0 ? process.argv[fileArgIdx + 1] : "universe_result.json";

function argNum(flag: string, dflt: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? parseFloat(process.argv[i + 1]) : dflt;
}

// ── Config (mirrors bybit_executor.ts RISK block) ────────────────────────────
const START_EQUITY = argNum("--start", 10_000);
const STOP_PCT = argNum("--stop", 15); // RISK.stopLossPct, as percent
const MAX_POSITIONS = argNum("--max-positions", 10); // RISK.maxPositions
// TIMEOUT_H is derived from the universe JSON's `lookaheadHours` field (set
// in main()), so a file generated with `--lookahead 24` is simulated with 24h
// slot-holding, a 72h file with 72h. Falls back to 48 for legacy files.
let TIMEOUT_H = 48;
// riskPerTrade values to sweep — 3% is the live setting.
const RISK_SWEEP = [0.02, 0.03, 0.04, 0.06];
const LIVE_RISK = 0.03;

interface QueuedDetail {
  firedAt: string;
  type: string;
  entry: number;
  fundingApr: number;
  finalPct: number;
  maxPct: number;
  minPct?: number;
  // hours-from-entry when adverse first crossed each sweep stop width; null
  // if never crossed. Lets the simulator release a slot when the stop fires
  // (closeMs = openMs + stopHitH × 3600s) instead of holding it until the
  // full timeout — which over-counted skips, biasing against longer timeouts.
  // Optional for back-compat with result files generated before this field.
  stopHitH?: Record<string, number | null>;
  verdict: string;
  trendingAtFire?: boolean;
}
interface CoinJSON {
  coin: string;
  queued?: { signals_detail: QueuedDetail[] };
}
interface Signal extends QueuedDetail {
  coin: string;
  openMs: number;
  closeMs: number;
}

// "2026-04-09 15:00" → epoch ms (treat as UTC for stable ordering).
function parseMs(s: string): number {
  return new Date(s.replace(" ", "T") + ":00Z").getTime();
}

// Per-trade P&L as a fraction of the risk unit (R-multiple), SHORT position.
// The executor has only two exits — stop or timeout, no take-profit:
//   stop hit (maxPct >= stop)  → -1R
//   timeout                    → -(finalPct / stop) R   (+finalPct = loss)
// Deterministic — no take-profit means no ordering ambiguity to resolve.
function rMultiple(s: QueuedDetail, stop: number): number {
  const adverse = s.maxPct; // peak price rise above entry (bad for a short)
  if (adverse >= stop) return -1; // stop hit
  return -s.finalPct / stop; // timeout — close at whatever price is live
}

interface SimResult {
  finalEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  skipped: number;
  wins: number;
  stops: number;
  peakConcurrent: number;
  worstTradePct: number; // worst single-trade hit to equity, %
}

function simulate(
  signals: Signal[],
  riskPerTrade: number,
  maxPositions: number = MAX_POSITIONS,
  stop: number = STOP_PCT,
): SimResult {
  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDD = 0;
  let trades = 0,
    skipped = 0,
    wins = 0,
    stops = 0,
    peakConcurrent = 0;
  let worstTradePct = 0;

  // Open positions: each resolves at closeMs with a known R-multiple.
  const open: { closeMs: number; r: number }[] = [];
  // riskUsdt is fixed at OPEN time (sized off equity then) — stored per position.
  const closedRisk = new Map<{ closeMs: number; r: number }, number>();

  const closeDue = (upTo: number) => {
    // Resolve every position whose timeout window has elapsed, in time order.
    open.sort((a, b) => a.closeMs - b.closeMs);
    while (open.length && open[0].closeMs <= upTo) {
      const pos = open.shift()!;
      const riskUsdt = closedRisk.get(pos)!;
      const pnl = pos.r * riskUsdt;
      const equityBefore = equity;
      equity += pnl;
      const tradePct = (pnl / equityBefore) * 100;
      if (tradePct < worstTradePct) worstTradePct = tradePct;
      if (pos.r > 0) wins++;
      if (pos.r <= -1) stops++;
      peakEquity = Math.max(peakEquity, equity);
      const dd = ((peakEquity - equity) / peakEquity) * 100;
      if (dd > maxDD) maxDD = dd;
    }
  };

  for (const sig of signals) {
    closeDue(sig.openMs); // free slots / realise P&L up to this signal's time
    if (open.length >= maxPositions) {
      skipped++;
      continue;
    }
    const riskUsdt = equity * riskPerTrade; // sized off equity at open
    const r = rMultiple(sig, stop);
    // Slot release time:
    //   stop hit  → openMs + stopHitH[stop] hours (slot freed when stop fired)
    //   timeout   → sig.closeMs (the precomputed openMs + TIMEOUT_H)
    // Legacy result files without stopHitH fall back to sig.closeMs in both
    // cases — preserving the old "slot held until full timeout" model.
    let actualCloseMs = sig.closeMs;
    if (r === -1) {
      const stopHrs = sig.stopHitH?.[String(stop)] ?? null;
      if (stopHrs !== null) actualCloseMs = sig.openMs + stopHrs * 3_600_000;
    }
    const pos = { closeMs: actualCloseMs, r };
    closedRisk.set(pos, riskUsdt);
    open.push(pos);
    trades++;
    peakConcurrent = Math.max(peakConcurrent, open.length);
  }
  closeDue(Infinity); // resolve anything still open

  return {
    finalEquity: equity,
    returnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDD,
    trades,
    skipped,
    wins,
    stops,
    peakConcurrent,
    worstTradePct,
  };
}

function pct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function main() {
  if (!existsSync(RESULT_FILE)) {
    console.error(
      `${RESULT_FILE} not found — run: npx tsx run_universe_backtest.ts`,
    );
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(RESULT_FILE, "utf8")) as {
    coins: CoinJSON[];
    lookaheadHours?: number;
  };
  // Derive timeout from the data file. Older JSONs without the field fall back
  // to 48h, the validated default — preserving back-compat.
  TIMEOUT_H = data.lookaheadHours ?? 48;

  const signals: Signal[] = [];
  for (const c of data.coins)
    for (const s of c.queued?.signals_detail ?? []) {
      const openMs = parseMs(s.firedAt);
      if (Number.isNaN(openMs)) continue;
      signals.push({
        ...s,
        coin: c.coin,
        openMs,
        closeMs: openMs + TIMEOUT_H * 3_600_000,
      });
    }
  signals.sort((a, b) => a.openMs - b.openMs);

  if (!signals.length) {
    console.error(
      `${RESULT_FILE} has no queued signals — re-run run_universe_backtest.ts.`,
    );
    process.exit(1);
  }

  // Detect whether the file carries stopHitH — if so, the fairer
  // "release slot when stop fires" model is used; otherwise the legacy
  // "hold slot until full timeout" model is used.
  const hasStopHitH = signals.some((s) => s.stopHitH != null);

  console.log("Portfolio simulation — queued signals through executor sizing");
  console.log("═".repeat(72));
  console.log(
    `Start $${START_EQUITY.toLocaleString()}  |  maxPositions ${MAX_POSITIONS}  |  ` +
      `stop ${STOP_PCT}%  |  ${TIMEOUT_H}h timeout  |  exits: stop or timeout (no TP)`,
  );
  console.log(
    `Signals: ${signals.length} queued, chronological  |  ` +
      `sizing: notional = (equity × riskPerTrade) / ${STOP_PCT}%`,
  );
  console.log(
    `Slot model: ${
      hasStopHitH
        ? "FAIR — slots released when stop fires (stopHitH present)"
        : "LEGACY — slots held until full timeout (no stopHitH in file; re-run run_universe_backtest.ts to get the fair model)"
    }`,
  );

  // ── riskPerTrade sweep — the return-vs-drawdown tradeoff ────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("  RISK-PER-TRADE SWEEP");
  console.log("─".repeat(72));
  console.log(
    `  ${"risk/trade".padEnd(12)} ${"FinalEquity".padStart(13)} ` +
      `${"Return".padStart(10)} ${"MaxDD".padStart(8)} ` +
      `${"Trades".padStart(8)} ${"Skip".padStart(6)} ${"WinRate".padStart(8)}`,
  );
  for (const rpt of RISK_SWEEP) {
    const r = simulate(signals, rpt);
    const tag = rpt === LIVE_RISK ? " ←LIVE" : "";
    console.log(
      `  ${((rpt * 100).toFixed(0) + "%").padEnd(12)} ` +
        `${("$" + Math.round(r.finalEquity).toLocaleString()).padStart(13)} ` +
        `${pct(r.returnPct).padStart(10)} ` +
        `${("-" + r.maxDrawdownPct.toFixed(1) + "%").padStart(8)} ` +
        `${String(r.trades).padStart(8)} ${String(r.skipped).padStart(6)} ` +
        `${((100 * r.wins) / Math.max(1, r.trades)).toFixed(0).padStart(7)}%${tag}`,
    );
  }

  // ── maxPositions sweep — what is the concurrency cap costing? ───────────────
  // riskPerTrade held at the live setting; only the concurrency cap varies.
  console.log("\n" + "─".repeat(72));
  console.log(
    `  MAX-POSITIONS SWEEP  (riskPerTrade ${(LIVE_RISK * 100).toFixed(0)}%)`,
  );
  console.log("─".repeat(72));
  console.log(
    `  ${"maxPos".padEnd(9)} ${"FinalEquity".padStart(13)} ` +
      `${"Return".padStart(10)} ${"MaxDD".padStart(8)} ` +
      `${"Trades".padStart(8)} ${"Skip".padStart(6)} ${"PeakConc".padStart(9)}`,
  );
  for (const mp of [5, 8, 10, 15, 20]) {
    const r = simulate(signals, LIVE_RISK, mp);
    const tag = mp === MAX_POSITIONS ? " ←LIVE" : "";
    console.log(
      `  ${String(mp).padEnd(9)} ` +
        `${("$" + Math.round(r.finalEquity).toLocaleString()).padStart(13)} ` +
        `${pct(r.returnPct).padStart(10)} ` +
        `${("-" + r.maxDrawdownPct.toFixed(1) + "%").padStart(8)} ` +
        `${String(r.trades).padStart(8)} ${String(r.skipped).padStart(6)} ` +
        `${(r.peakConcurrent + "/" + mp).padStart(9)}${tag}`,
    );
  }
  console.log(
    `\n  Read: as maxPositions rises, 'Skip' falls and more signal flow gets\n` +
      `  traded. Watch MaxDD — if it climbs roughly in step with return, the\n` +
      `  extra slots add uncorrelated trades (good). If MaxDD outpaces return,\n` +
      `  the new positions are piling into correlated risk.`,
  );

  // ── stop-width sweep — does a tighter stop help the equity curve? ──────────
  // riskPerTrade and maxPositions held live; only the stop width varies.
  // With no take-profit, a wider stop captures no extra upside — it only lets
  // losers run further before cutting. This shows the portfolio-level effect
  // (drawdown + compounded return), not just per-trade average.
  console.log("\n" + "─".repeat(72));
  console.log(
    `  STOP-WIDTH SWEEP  (riskPerTrade ${(LIVE_RISK * 100).toFixed(0)}%, maxPositions ${MAX_POSITIONS})`,
  );
  console.log("─".repeat(72));
  console.log(
    `  ${"stop".padEnd(9)} ${"FinalEquity".padStart(13)} ` +
      `${"Return".padStart(10)} ${"MaxDD".padStart(8)} ` +
      `${"Trades".padStart(8)} ${"Skip".padStart(6)} ${"WinRate".padStart(8)}`,
  );
  for (const sp of [12, 15, 20, 25, 30]) {
    const r = simulate(signals, LIVE_RISK, MAX_POSITIONS, sp);
    const tag = sp === STOP_PCT ? " ←LIVE" : "";
    console.log(
      `  ${(sp + "%").padEnd(9)} ` +
        `${("$" + Math.round(r.finalEquity).toLocaleString()).padStart(13)} ` +
        `${pct(r.returnPct).padStart(10)} ` +
        `${("-" + r.maxDrawdownPct.toFixed(1) + "%").padStart(8)} ` +
        `${String(r.trades).padStart(8)} ${String(r.skipped).padStart(6)} ` +
        `${((100 * r.wins) / Math.max(1, r.trades)).toFixed(0).padStart(7)}%${tag}`,
    );
  }
  console.log(
    `\n  Read: a tighter stop usually lifts return here (no take-profit means a\n` +
      `  wide stop only absorbs more loss, captures no extra gain). But check\n` +
      `  MaxDD and WinRate too — a tighter stop stops out more trades, so the\n` +
      `  equity curve can get choppier even when the total is higher.`,
  );

  // ── Detail at the live setting ─────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log(
    `  DETAIL — live setting (riskPerTrade ${(LIVE_RISK * 100).toFixed(0)}%, maxPositions ${MAX_POSITIONS})`,
  );
  console.log("─".repeat(72));
  const live = simulate(signals, LIVE_RISK);
  console.log(
    `  Final equity:    $${Math.round(live.finalEquity).toLocaleString()}  (${pct(live.returnPct)})`,
  );
  console.log(`  Max drawdown:    -${live.maxDrawdownPct.toFixed(1)}%`);
  console.log(
    `  Trades taken:    ${live.trades} / ${signals.length}   ` +
      `(${live.skipped} skipped — all ${MAX_POSITIONS} slots full)`,
  );
  console.log(
    `  Win rate:        ${((100 * live.wins) / Math.max(1, live.trades)).toFixed(0)}%   ` +
      `(${live.stops} stopped out, ${live.trades - live.stops} ran to timeout)`,
  );
  console.log(
    `  Peak concurrent: ${live.peakConcurrent}/${MAX_POSITIONS}   ` +
      `worst single trade: ${live.worstTradePct.toFixed(1)}% of equity`,
  );

  console.log("\n" + "═".repeat(72));
  console.log(
    "  MaxDD is the worst peak-to-trough equity decline — the real risk\n" +
      "  number. It is from ONE 60-day window; a worse correlated cluster in\n" +
      "  another period could go deeper. Treat it as a floor on bad, not a\n" +
      "  worst case. 'Skip' is an upper bound (see header note).",
  );
}

main();
