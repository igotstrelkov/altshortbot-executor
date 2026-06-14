/**
 * analyze_stops.ts
 * =================
 * Reads universe_result.json and reports realized per-trade P&L for the
 * queued signals — broken down by stop width and by signal type. Win rate is
 * binary and hides magnitude; this shows what each signal actually earns once
 * the executor's stop and timeout are applied.
 *
 * simulate_portfolio.ts adds concurrency, compounding and drawdown. This tool
 * is the per-trade complement: stop-width sensitivity, per-type breakdown, and
 * the trend-filter P&L comparison — things the portfolio sim does not isolate.
 *
 * Exit model — matches bybit_executor.ts: a SHORT closes ONLY on
 *   • stop    — price rose to stopLossPct above entry
 *   • timeout — timeout window elapsed, close at the live price
 * No take-profit, no trailing stop.
 *
 * P&L is reported as an R-multiple (sizing-agnostic): 1R = riskPerTrade of
 * equity, the amount lost on a stop-out. The executor sizes every trade so a
 * stop costs exactly 1R, so:
 *   stop hit  → -1.00 R
 *   timeout   → -(finalPct / stop) R     (+finalPct = price up = loss)
 * A % column converts R to equity impact at the live riskPerTrade.
 *
 * Run the universe backtest first, then:
 *   npx tsx analyze_stops.ts
 */

import { existsSync, readFileSync } from "fs";

// --file <path> overrides the input (e.g. universe_result_notrend.json
// for the trend-filter-off comparison run); defaults to universe_result.json.
const fileArgIdx = process.argv.indexOf("--file");
const RESULT_FILE =
  fileArgIdx >= 0 ? process.argv[fileArgIdx + 1] : "universe_result.json";

// Live executor settings (bybit_executor.ts RISK block).
const LIVE_STOP = 15; // stopLossPct, percent
const LIVE_RISK = 0.03; // riskPerTrade — used to express R as % of equity
// LOOKAHEAD_H is derived from the universe JSON's `lookaheadHours` field
// (set in main()), so labels match the file's actual data window. Falls back
// to 48 for legacy files without the field.
let LOOKAHEAD_H = 48;

interface QueuedDetail {
  firedAt: string;
  type: string;
  entry: number;
  fundingApr: number;
  finalPct: number;
  maxPct: number; // peak adverse excursion — price rise above entry (bad for short)
  minPct: number; // peak favorable excursion — price low below entry (good for short)
  verdict: string;
  trendingAtFire?: boolean;
  // Hours-from-entry the price first crossed each stop width (keyed by stop %),
  // null if never crossed. Used to bound the funding hold for stopped trades.
  stopHitH?: Record<string, number | null>;
  // Funding % over the hold each stop implies (negative = short pays),
  // integrated from the actual settlement path by run_universe_backtest. Absent
  // in older result files → fall back to the constant-APR estimate.
  fundingPctByStop?: Record<string, number>;
}

const ANNUAL_HOURS = 8760;
interface CoinJSON {
  coin: string;
  queued?: { signals_detail: QueuedDetail[] };
}

// Stop widths to compare (percent price move). Exit is stop-or-timeout only.
const STOP_SWEEP = [12, 15, 20, 25, 30];

type Exit = "stop" | "timeout";

// Per-trade R-multiple for a SHORT. stop hit → -1R; else timeout.
function rMultiple(s: QueuedDetail, stop: number): { r: number; exit: Exit } {
  if (s.maxPct >= stop) return { r: -1, exit: "stop" };
  return { r: -s.finalPct / stop, exit: "timeout" };
}

// Funding-adjusted R for a SHORT — ADDITIVE to price R, never replaces it.
// Preferred: fundingPctByStop[stop], funding % integrated from the ACTUAL
// per-settlement path by run_universe_backtest (negative = short pays); in R
// that is fundingPct ÷ stop% (notional cancels). This is the accurate model —
// it neither over-states momentary funding spikes (as constant-APR did) nor
// under-states persistent ones (as a per-8h cap did).
// FALLBACK (older result files without the field): constant-APR over the hold —
// the funding APR at fire assumed to persist; OVER-states momentary spikes.
// Either way this is the Bybit/Binance most-extreme series; the exact realized
// KuCoin figure is fundingPaidUsdt (analyze_funding.ts).
function fundingR(s: QueuedDetail, stop: number, exit: Exit): number {
  const fromPath = s.fundingPctByStop?.[String(stop)];
  if (fromPath != null) return fromPath / stop; // integrated path (preferred)
  const holdH =
    exit === "stop" ? (s.stopHitH?.[String(stop)] ?? LOOKAHEAD_H) : LOOKAHEAD_H;
  const fundingFrac = (s.fundingApr / 100) * (holdH / ANNUAL_HOURS);
  return fundingFrac / (stop / 100);
}

interface Stats {
  trades: number;
  wins: number; // price-only wins (priceR > 0)
  avgR: number; // price-only
  totalR: number; // price-only
  stopped: number;
  timeout: number;
  // Funding-adjusted (additive) — price-only fields above are untouched.
  avgFundR: number; // mean funding R per trade (≤0 for negative-funding shorts)
  avgAllInR: number; // mean (price + funding) R per trade
  totalAllInR: number;
  winsAllIn: number; // trades still positive after funding
}

function runScenario(signals: QueuedDetail[], stop: number): Stats {
  let wins = 0,
    stopped = 0,
    timeout = 0,
    sumR = 0,
    sumFundR = 0,
    sumAllIn = 0,
    winsAllIn = 0;
  for (const s of signals) {
    const { r, exit } = rMultiple(s, stop);
    const fR = fundingR(s, stop, exit);
    const allIn = r + fR;
    sumR += r;
    sumFundR += fR;
    sumAllIn += allIn;
    if (r > 0) wins++;
    if (allIn > 0) winsAllIn++;
    if (exit === "stop") stopped++;
    else timeout++;
  }
  const n = signals.length;
  return {
    trades: n,
    wins,
    avgR: n ? sumR / n : 0,
    totalR: sumR,
    stopped,
    timeout,
    avgFundR: n ? sumFundR / n : 0,
    avgAllInR: n ? sumAllIn / n : 0,
    totalAllInR: sumAllIn,
    winsAllIn,
  };
}

function pct(n: number, d: number): string {
  return d ? ((100 * n) / d).toFixed(0) + "%" : "—";
}
function sgnR(r: number): string {
  return (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
}
// R expressed as % of equity at the live riskPerTrade.
function rAsPct(r: number): string {
  const p = r * LIVE_RISK * 100;
  return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
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
  LOOKAHEAD_H = data.lookaheadHours ?? 48;
  const all: QueuedDetail[] = [];
  for (const c of data.coins)
    for (const s of c.queued?.signals_detail ?? []) all.push(s);

  if (!all.length) {
    console.error(
      `${RESULT_FILE} has no queued signals — re-run run_universe_backtest.ts.`,
    );
    process.exit(1);
  }

  console.log("Stop sensitivity — realized per-trade P&L on queued signals");
  console.log("═".repeat(72));
  console.log(
    `Signals: ${all.length}  |  exits: stop or ${LOOKAHEAD_H}h timeout (no take-profit)  |  ` +
      `1R = riskPerTrade (${(LIVE_RISK * 100).toFixed(0)}%) of equity`,
  );

  // ── Stop-width sweep — all queued signals ──────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("  STOP-WIDTH SWEEP — all queued signals");
  console.log("─".repeat(72));
  console.log(
    `  ${"Stop".padEnd(10)} ${"AvgP&L/trade".padStart(16)} ` +
      `${"WinRate".padStart(8)} ${"Stopped".padStart(9)} ${"Timeout".padStart(9)} ` +
      `${"AllIn±fund".padStart(11)}`,
  );
  for (const stop of STOP_SWEEP) {
    const s = runScenario(all, stop);
    const tag = stop === LIVE_STOP ? " ←LIVE" : "";
    console.log(
      `  ${(stop + "%").padEnd(10)} ` +
        `${(sgnR(s.avgR) + " / " + rAsPct(s.avgR)).padStart(16)} ` +
        `${pct(s.wins, s.trades).padStart(8)} ` +
        `${pct(s.stopped, s.trades).padStart(9)} ` +
        `${pct(s.timeout, s.trades).padStart(9)} ` +
        `${sgnR(s.avgAllInR).padStart(11)}${tag}`,
    );
  }

  // ── Per-signal-type breakdown at the live stop ─────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log(`  BY SIGNAL TYPE — at live stop (${LIVE_STOP}%)`);
  console.log("─".repeat(72));
  console.log(
    `  (price = price-only R; fund = modeled funding R; all-in = price+fund; ` +
      `win = price→all-in)`,
  );
  for (const t of ["BUILDING", "PUMP_TOP", "EXHAUSTION", "TREND_BREAK"]) {
    const sub = all.filter((s) => s.type === t);
    if (!sub.length) continue;
    const s = runScenario(sub, LIVE_STOP);
    console.log(
      `  ${t.padEnd(12)} ${String(sub.length).padStart(4)}  ` +
        `price ${sgnR(s.avgR)}  ` +
        `fund ${sgnR(s.avgFundR)}  ` +
        `all-in ${sgnR(s.avgAllInR)} (${rAsPct(s.avgAllInR)})  ` +
        `win ${pct(s.wins, s.trades)}→${pct(s.winsAllIn, s.trades)}`,
    );
  }

  // ── BUILDING by funding band — does the edge SURVIVE funding at the extremes? ─
  // run_universe_backtest's funding-band table is win-rate only; extreme funding
  // wins MORE often but pays MORE carry. This is the definitive test of the
  // -180% floor: if all-in R stays positive (or rises) as funding gets more
  // extreme, the floor is vindicated on realized P&L; if it degrades, revisit.
  // Bands mirror run_universe_backtest (APR is negative; lower = more extreme).
  console.log("\n" + "─".repeat(72));
  console.log(`  BUILDING BY FUNDING BAND — all-in R (stop ${LIVE_STOP}%)`);
  console.log("─".repeat(72));
  const BANDS: { lo: number; hi: number; label: string }[] = [
    { lo: -350, hi: -180, label: "-180 to -350" },
    { lo: -500, hi: -350, label: "-350 to -500" },
    { lo: -1000, hi: -500, label: "-500 to -1000" },
    { lo: -2000, hi: -1000, label: "-1000 to -2000" },
    { lo: -Infinity, hi: -2000, label: "-2000 & below" },
  ];
  const building = all.filter((s) => s.type === "BUILDING");
  for (const b of BANDS) {
    const sub = building.filter(
      (s) => s.fundingApr > b.lo && s.fundingApr <= b.hi,
    );
    if (!sub.length) {
      console.log(`  ${b.label.padEnd(16)}    (no signals)`);
      continue;
    }
    const s = runScenario(sub, LIVE_STOP);
    console.log(
      `  ${b.label.padEnd(16)} ${String(sub.length).padStart(4)}  ` +
        `price ${sgnR(s.avgR)}  ` +
        `fund ${sgnR(s.avgFundR)}  ` +
        `all-in ${sgnR(s.avgAllInR)}  ` +
        `win ${pct(s.wins, s.trades)}→${pct(s.winsAllIn, s.trades)}`,
    );
  }
  // Verdict: the -180% floor is vindicated only if NO band turns net-negative
  // after funding. A coarse moderate-vs-extreme average can hide a single losing
  // band, so check each band's all-in R and report the worst one.
  const bandStats = BANDS.map((b) => {
    const sub = building.filter(
      (s) => s.fundingApr > b.lo && s.fundingApr <= b.hi,
    );
    return { b, n: sub.length, allIn: runScenario(sub, LIVE_STOP).avgAllInR };
  }).filter((x) => x.n > 0);
  const losers = bandStats.filter((x) => x.allIn <= 0);
  const deepestLoses = losers.some((x) => x.b.lo === -Infinity);
  console.log("");
  if (!losers.length) {
    console.log(
      `  Verdict: ✅ every funding band is net-positive all-in — -180% floor ` +
        `vindicated on realized P&L (not just win rate).`,
    );
  } else {
    const worst = losers.reduce((a, b) => (b.allIn < a.allIn ? b : a));
    console.log(
      `  Verdict: ${deepestLoses ? "🚨" : "⚠️"} ${losers.length} band(s) net-NEGATIVE ` +
        `after carry — worst: ${worst.b.label} ${sgnR(worst.allIn)} all-in ` +
        `(wins most on price, funding overwhelms it).`,
    );
    console.log(
      `  ${
        deepestLoses
          ? "The DEEPEST-funding band is the loser → a funding CEILING (cap how " +
            "extreme to trade) may beat the floor-only rule."
          : "A mid band is the loser → likely noise; watch, do not act."
      }`,
    );
    console.log(
      LOOKAHEAD_H > 24
        ? `  ⚠️ CONFIRM at lookahead 24 first — this file is ${LOOKAHEAD_H}h, so carry is ` +
            `~${(LOOKAHEAD_H / 24).toFixed(0)}× the live 24h hold and over-states the drag.`
        : `  This IS the live ${LOOKAHEAD_H}h horizon — the drag is not over-stated; treat the finding as real (mind n).`,
    );
  }

  // ── Trend-filter question, in realized P&L ─────────────────────────────────
  // Does dropping parabolic PUMP_TOPs help or hurt total realized R?
  console.log("\n" + "─".repeat(72));
  console.log(
    `  TREND FILTER ON PUMP_TOP — realized-P&L impact (stop ${LIVE_STOP}%)`,
  );
  console.log("─".repeat(72));
  const keepAll = all;
  const dropParabolic = all.filter(
    (s) => !(s.type === "PUMP_TOP" && s.trendingAtFire),
  );
  const removed = keepAll.length - dropParabolic.length;
  const a = runScenario(keepAll, LIVE_STOP);
  const b = runScenario(dropParabolic, LIVE_STOP);
  console.log(
    `  keep all (${a.trades}):        total ${sgnR(a.totalR)}   avg ${sgnR(a.avgR)}/trade`,
  );
  console.log(
    `  drop ${removed} parabolic (${b.trades}):  total ${sgnR(b.totalR)}   avg ${sgnR(b.avgR)}/trade`,
  );
  console.log(
    `\n  Read: if total R RISES when parabolic pump-tops are dropped, the\n` +
      `  filter earns money; if it FALLS, the filter discards net-positive\n` +
      `  trades. (avg/trade can move the opposite way — removing below-average\n` +
      `  winners lifts the average while lowering the total.)`,
  );

  // ── WINNER GIVE-BACK — how much of the peak favorable move is kept? ─────────
  // For each WINNER that ran to the timeout (not stopped), compare the peak
  // favorable excursion (-minPct, the best the short ever looked) to the final
  // final close (-finalPct). "Captured" = final / peak. This is the real test of
  // whether a trailing stop could help: if winners close NEAR their peak
  // (captured high), a trailing stop would only cap upside and cost money. If
  // winners spike then round-trip (captured low), profit is being given back.
  const winners = all.filter((s) => s.maxPct < LIVE_STOP && s.finalPct < 0); // timeout trades that closed favorable (a short profits when price falls)

  if (winners.length) {
    // peak favorable and final favorable, as positive % (short gains on a fall)
    const rows = winners.map((s) => {
      const peakFav = -s.minPct; // > 0
      const finalFav = -s.finalPct; // > 0
      const captured = peakFav > 0 ? finalFav / peakFav : 1;
      return { peakFav, finalFav, captured };
    });
    const med = (xs: number[]) => {
      const a = [...xs].sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

    const capt = rows.map((r) => r.captured);
    const medCapt = med(capt);
    const meanCapt = mean(capt);
    // How many winners gave back more than half / three-quarters of their peak.
    const gaveHalf = rows.filter((r) => r.captured < 0.5).length;
    const gave75 = rows.filter((r) => r.captured < 0.25).length;
    const heldNearPeak = rows.filter((r) => r.captured >= 0.8).length;

    console.log("\n" + "─".repeat(72));
    console.log(
      `  WINNER GIVE-BACK — peak favorable vs ${LOOKAHEAD_H}h close (stop ${LIVE_STOP}%)`,
    );
    console.log("─".repeat(72));
    console.log(
      `  Winners analysed: ${winners.length} (timeout trades that closed in profit)`,
    );
    console.log(
      `  Avg peak favorable excursion: ${mean(rows.map((r) => r.peakFav)).toFixed(1)}%  ` +
        `→ avg final: ${mean(rows.map((r) => r.finalFav)).toFixed(1)}%`,
    );
    console.log(
      `  Captured fraction (final / peak):  median ${(medCapt * 100).toFixed(0)}%  ` +
        `mean ${(meanCapt * 100).toFixed(0)}%`,
    );
    console.log(
      `  Held near peak (kept ≥80%): ${heldNearPeak}/${winners.length}` +
        `   |  gave back >half: ${gaveHalf}   gave back >75%: ${gave75}`,
    );
    console.log(
      `\n  Read: high captured % = winners close near their best, so a trailing\n` +
        `  stop would mostly cap upside and LOSE money. Low captured % = winners\n` +
        `  spike then round-trip — profit is being given back, and a shorter\n` +
        `  timeout (not necessarily a trailing stop) may be worth testing.\n` +
        `  ${
          medCapt >= 0.7
            ? `Verdict: median ${(medCapt * 100).toFixed(0)}% — winners hold near peak. ` +
              `A trailing stop would very likely REDUCE total P&L.`
            : medCapt >= 0.5
              ? `Verdict: median ${(medCapt * 100).toFixed(0)}% — moderate give-back. ` +
                `Inconclusive; the fat-tail winners still argue against capping upside.`
              : `Verdict: median ${(medCapt * 100).toFixed(0)}% — winners give back a lot. ` +
                `Worth testing a SHORTER TIMEOUT before considering a trailing stop.`
        }`,
    );
  }

  console.log("\n" + "═".repeat(72));
  console.log(
    `  Note: timeout P&L uses the ${LOOKAHEAD_H}h price (finalPct) — the executor has\n` +
      "  no take-profit, so a winning short rides until it reverses into the\n" +
      `  stop or the ${LOOKAHEAD_H}h timeout closes it. R-multiples are sizing-agnostic;\n` +
      "  the % figures assume the live riskPerTrade.",
  );
  console.log(
    `\n  Funding columns model a SHORT paying the signal-time funding APR over the\n` +
      `  hold (constant-APR approximation). The APR is the Bybit/Binance most-extreme\n` +
      `  series, so funding R is a CONSERVATIVE (over-stated) bound, not ground truth —\n` +
      `  use analyze_funding.ts on kucoin_positions.json for realized KuCoin funding.\n` +
      `  Price-only R (the validated metric) is unchanged; all-in is shown alongside.`,
  );
}

main();
