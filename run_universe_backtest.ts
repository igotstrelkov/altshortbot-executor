/**
 * run_universe_backtest.ts
 * =========================
 * Runs backtest_signals.ts across the FULL scanner universe (every Bybit USDT
 * perp the live scanner would scan), in batches, then aggregates the QUEUED
 * win rate — the real metric for "would this strategy make money".
 *
 * The universe is defined objectively (all USDT perps ≥ $0.001, minus the
 * scanner's exclude set) — NOT hand-picked — so the result is not curve-fit.
 *
 * Usage:
 *   npx tsx run_universe_backtest.ts                 — full universe, 60d
 *   npx tsx run_universe_backtest.ts --days 90       — custom window
 *   npx tsx run_universe_backtest.ts --batch 25      — coins per backtest call
 *
 * Output: universe_result.json (merged) + printed QUEUED analysis.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";

const BB_BASE = "https://api.bybit.com";
const MIN_PRICE_USDC = 0.001;
// FIDA excluded: extreme-funding BUILDINGs are mega-squeeze traps (net loser on
// the backtest). EDEN removed 2026-06-07 — backtested as a clean earner. Must
// stay in sync with live_scanner.ts EXCLUDE_COINS.
const EXCLUDE = new Set(["BTC", "ETH", "BNB", "BTCDOM", "FIDA"]);

const argDays = process.argv[process.argv.indexOf("--days") + 1];
const DAYS = process.argv.includes("--days") ? parseInt(argDays) : 60;
const argBatch = process.argv[process.argv.indexOf("--batch") + 1];
const BATCH = process.argv.includes("--batch") ? parseInt(argBatch) : 25;

// --no-trend-filter: forwarded to backtest_signals.ts. NOTE: this disables the
// trend filter, which also abolishes the TREND_BREAK signal type (TREND_BREAK
// is defined as a squeeze fired *while trending*). Output goes to a separate
// file so a normal run is never overwritten — diff the two.
const NO_TREND = process.argv.includes("--no-trend-filter");

// --building-min-funding <N>: overrides the validated -180% BUILDING queue
// gate (Strategy B). Lowering it (e.g. to 0) pulls weaker-funding BUILDING
// signals into the queued set — an UNVALIDATED population. Routes to its own
// result file so the validated baseline is never clobbered.
const bmfIdx = process.argv.indexOf("--building-min-funding");
const BUILDING_MIN_FUNDING = bmfIdx >= 0 ? process.argv[bmfIdx + 1] : null;

// --lookahead <N>: overrides the validated 24h outcome window. Signal DETECTION
// is unchanged (lookahead only affects per-signal outcome math), so three runs
// at 24/48/72 produce identical queued signal sets with different outcomes —
// a clean comparison of "how long should we hold." Routes to its own result file.
const lookaheadIdx = process.argv.indexOf("--lookahead");
const LOOKAHEAD = lookaheadIdx >= 0 ? process.argv[lookaheadIdx + 1] : null;

const RESULT_FILE = NO_TREND
  ? "universe_result_notrend.json"
  : BUILDING_MIN_FUNDING !== null
    ? `universe_result_bmf${BUILDING_MIN_FUNDING}.json`
    : LOOKAHEAD !== null
      ? `universe_result_lookahead${LOOKAHEAD}.json`
      : "universe_result.json";

// Validated parameters — must match live_scanner.ts PARAMS exactly.
const PARAMS = [
  "--threshold",
  "10",
  "--min-positive",
  "2",
  "--min-oi",
  "2",
  "--max-price",
  "2",
  "--pump-pct",
  "19",
  "--pump-vol",
  "5",
  "--pump-rsi",
  "88",
  "--pump-funding",
  "0",
  "--squeeze-pct",
  "20",
  "--squeeze-hours",
  "10",
  "--squeeze-funding",
  "-100",
  "--squeeze-oi-drop",
  "0",
  "--exhaust-funding",
  "-20",
  "--exhaust-oi-drop",
  "3",
  // Outcome window — validated value is 24h; --lookahead overrides.
  "--lookahead",
  LOOKAHEAD ?? "24",
  // BUILDING queue gate — validated value is -180; --building-min-funding overrides.
  "--building-min-funding",
  BUILDING_MIN_FUNDING ?? "-180",
];

interface QueuedDetail {
  firedAt: string;
  type: string;
  entry: number;
  fundingApr: number;
  finalPct: number;
  maxPct: number;
  verdict: string;
  trendingAtFire?: boolean;
  oiDropPct?: number;
  hadOiData?: boolean;
}
interface CoinJSON {
  coin: string;
  queued?: {
    signals: number;
    wins: number;
    winRate: number | null;
    blockedBuilding: number;
    signals_detail: QueuedDetail[];
    blocked_detail: {
      firedAt: string;
      fundingApr: number;
      wouldHaveBeen: string;
    }[];
  };
}

// ── Fetch the scanner's universe (objective rule, not cherry-picked) ─────────
async function fetchUniverse(): Promise<string[]> {
  const [info, tickers] = (await Promise.all([
    fetch(
      `${BB_BASE}/v5/market/instruments-info?category=linear&status=Trading&limit=1000`,
    ).then((r) => r.json()),
    fetch(`${BB_BASE}/v5/market/tickers?category=linear`).then((r) => r.json()),
  ])) as [
    { result?: { list?: { symbol: string; quoteCoin: string }[] } },
    { result?: { list?: { symbol: string; lastPrice: string }[] } },
  ];
  const price = new Map<string, number>();
  for (const t of tickers?.result?.list ?? [])
    price.set(t.symbol, parseFloat(t.lastPrice));
  return (info?.result?.list ?? [])
    .filter((s) => s.quoteCoin === "USDT")
    .filter((s) => (price.get(s.symbol) ?? 0) >= MIN_PRICE_USDC)
    .map((s) => s.symbol.replace("USDT", ""))
    .filter((c) => !EXCLUDE.has(c))
    .sort();
}

function runBatch(coins: string[], idx: number): CoinJSON[] {
  const jsonFile = `/tmp/universe_batch_${idx}.json`;
  try {
    unlinkSync(jsonFile);
  } catch {}

  const res = spawnSync(
    "npx",
    [
      "tsx",
      "backtest_signals.ts",
      "--coin",
      coins.join(","),
      "--days",
      String(DAYS),
      ...PARAMS,
      ...(NO_TREND ? ["--no-trend-filter"] : []),
      "--json",
      jsonFile,
    ],
    { encoding: "utf8", timeout: 600_000, shell: true },
  );

  if (res.status !== 0 || !existsSync(jsonFile)) {
    console.error(
      `  batch ${idx} failed: ${res.stderr?.slice(0, 150) ?? "no output"}`,
    );
    return [];
  }
  const data = JSON.parse(readFileSync(jsonFile, "utf8")) as {
    coins: CoinJSON[];
  };
  return data.coins ?? [];
}

async function main() {
  console.log("Universe backtest — full scanner coin set");
  console.log("═".repeat(64));
  console.log(
    `Window: ${DAYS}d  |  batch size: ${BATCH}  |  trend filter: ${
      NO_TREND ? "OFF (--no-trend-filter — TREND_BREAK disabled)" : "ON"
    }${
      BUILDING_MIN_FUNDING !== null
        ? `  |  building-min-funding: ${BUILDING_MIN_FUNDING}% (OVERRIDE — validated is -180)`
        : ""
    }${
      LOOKAHEAD !== null
        ? `  |  lookahead: ${LOOKAHEAD}h (OVERRIDE — validated is 24)`
        : ""
    }\n`,
  );

  process.stdout.write("Fetching coin universe... ");
  const universe = await fetchUniverse();
  console.log(`${universe.length} coins`);

  const allCoins: CoinJSON[] = [];
  const nBatches = Math.ceil(universe.length / BATCH);
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const bIdx = i / BATCH + 1;
    process.stdout.write(
      `Batch ${bIdx}/${nBatches} (${batch.length} coins)... `,
    );
    const result = runBatch(batch, bIdx);
    console.log(`${result.length} processed`);
    allCoins.push(...result);
  }

  writeFileSync(
    RESULT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        days: DAYS,
        // lookaheadHours — embedded so analysis tools derive the timeout from
        // the data instead of hardcoding it. A 24h-lookahead file simulates
        // with 24h slot-holding automatically; a 72h file with 72h.
        lookaheadHours: parseInt(LOOKAHEAD ?? "48"),
        coins: allCoins,
      },
      null,
      2,
    ),
  );

  // ── Aggregate QUEUED analysis ──────────────────────────────────────────────
  let totQ = 0,
    totW = 0,
    totBlocked = 0;
  const byType: Record<string, { n: number; w: number }> = {};
  const losers: (QueuedDetail & { coin: string })[] = [];

  for (const c of allCoins) {
    if (!c.queued) continue;
    totQ += c.queued.signals;
    totW += c.queued.wins;
    totBlocked += c.queued.blockedBuilding;
    for (const s of c.queued.signals_detail) {
      byType[s.type] ??= { n: 0, w: 0 };
      byType[s.type].n++;
      if (["DROPPED", "PUMP+DUMP"].includes(s.verdict)) byType[s.type].w++;
      else losers.push({ coin: c.coin, ...s });
    }
  }

  console.log("\n" + "═".repeat(64));
  console.log("  QUEUED SIGNAL ANALYSIS — full universe");
  console.log("═".repeat(64));
  console.log(
    `  TOTAL: ${totW}/${totQ} queued signals won` +
      (totQ ? ` — ${((totW / totQ) * 100).toFixed(1)}% win rate` : "") +
      `\n  Blocked BUILDING (funding > ${BUILDING_MIN_FUNDING ?? "-180"}%): ${totBlocked}`,
  );

  console.log("\n  By signal type:");
  for (const [t, v] of Object.entries(byType)) {
    console.log(
      `    ${t.padEnd(12)} ${String(v.w).padStart(3)}/${String(v.n).padEnd(3)}` +
        `  ${((v.w / v.n) * 100).toFixed(0)}% win rate`,
    );
  }

  console.log(`\n  Queued losers (${losers.length}) — sorted by funding APR:`);
  losers.sort((a, b) => a.fundingApr - b.fundingApr);
  for (const l of losers) {
    const trendMark =
      l.type === "PUMP_TOP" && l.trendingAtFire ? "  ⚠️ PARABOLIC" : "";
    console.log(
      `    ${l.coin.padEnd(10)} ${l.type.padEnd(11)} ` +
        `entry=$${l.entry.toFixed(6)}  funding:${l.fundingApr.toFixed(0)}%  ` +
        `max:+${l.maxPct.toFixed(1)}%  final:${l.finalPct >= 0 ? "+" : ""}${l.finalPct.toFixed(1)}%  ${l.verdict}${trendMark}`,
    );
  }

  // ── Hypothesis test: are PUMP_TOP losers concentrated in parabolic trends? ──
  const pumpAll: QueuedDetail[] = [];
  for (const c of allCoins)
    for (const s of c.queued?.signals_detail ?? [])
      if (s.type === "PUMP_TOP") pumpAll.push(s);

  const pumpWin = (s: QueuedDetail) =>
    ["DROPPED", "PUMP+DUMP"].includes(s.verdict);
  const pumpLosers = pumpAll.filter((s) => !pumpWin(s));
  const pumpWinners = pumpAll.filter(pumpWin);
  const losersTrending = pumpLosers.filter((s) => s.trendingAtFire).length;
  const winnersTrending = pumpWinners.filter((s) => s.trendingAtFire).length;

  console.log("\n" + "─".repeat(64));
  console.log("  HYPOTHESIS: PUMP_TOP fails when fired in a parabolic trend");
  console.log("─".repeat(64));
  if (pumpAll.length) {
    console.log(
      `  PUMP_TOP losers:  ${pumpLosers.length}` +
        `  — ${losersTrending} (${pct(losersTrending, pumpLosers.length)}) fired in a parabolic trend`,
    );
    console.log(
      `  PUMP_TOP winners: ${pumpWinners.length}` +
        `  — ${winnersTrending} (${pct(winnersTrending, pumpWinners.length)}) fired in a parabolic trend`,
    );
    const nonTrendPump = pumpAll.filter((s) => !s.trendingAtFire);
    const nonTrendWins = nonTrendPump.filter(pumpWin).length;
    console.log(
      `\n  If PUMP_TOP were trend-filtered (not queued when parabolic):`,
    );
    console.log(
      `    PUMP_TOP win rate: ${pct(pumpWinners.length, pumpAll.length)}` +
        ` → ${pct(nonTrendWins, nonTrendPump.length)}` +
        `  (${nonTrendWins}/${nonTrendPump.length} signals)`,
    );
    const newTotW = totW - (pumpWinners.length - nonTrendWins);
    const newTotQ = totQ - (pumpAll.length - nonTrendPump.length);
    console.log(
      `    Overall queued win rate: ${pct(totW, totQ)}` +
        ` → ${pct(newTotW, newTotQ)}`,
    );
    console.log(
      `\n  Verdict: ${
        pumpLosers.length >= 5 &&
        losersTrending / Math.max(1, pumpLosers.length) >= 0.6
          ? "✅ pattern holds — trend-filtering PUMP_TOP is justified"
          : "⚠️ pattern weak or sample small — do NOT change code yet"
      }`,
    );
  } else {
    console.log("  No PUMP_TOP signals in universe.");
  }

  // ── Funding-bucket analysis: is extreme negative funding worse for BUILDING? ─
  // Tests the "more extreme = better" thesis with base rates, not a losers list.
  const buildingAll: QueuedDetail[] = [];
  for (const c of allCoins)
    for (const s of c.queued?.signals_detail ?? [])
      if (s.type === "BUILDING") buildingAll.push(s);

  if (buildingAll.length) {
    // Bands are on funding APR (all negative). Edges chosen a priori, not fitted.
    const bands: { label: string; lo: number; hi: number }[] = [
      { label: "-200 to -350", lo: -350, hi: -200 },
      { label: "-350 to -500", lo: -500, hi: -350 },
      { label: "-500 to -1000", lo: -1000, hi: -500 },
      { label: "-1000 to -2000", lo: -2000, hi: -1000 },
      { label: "-2000 and below", lo: -Infinity, hi: -2000 },
    ];
    const isWin = (s: QueuedDetail) =>
      ["DROPPED", "PUMP+DUMP"].includes(s.verdict);

    console.log("\n" + "─".repeat(64));
    console.log("  FUNDING-BAND ANALYSIS — BUILDING win rate by funding APR");
    console.log("─".repeat(64));
    console.log(
      `  ${"Band (% APR)".padEnd(18)} ${"Signals".padStart(8)} ` +
        `${"Wins".padStart(6)} ${"WinRate".padStart(8)} ${"AvgMaxAdverse".padStart(14)}`,
    );

    for (const b of bands) {
      const inBand = buildingAll.filter(
        (s) => s.fundingApr > b.lo && s.fundingApr <= b.hi,
      );
      if (!inBand.length) {
        console.log(`  ${b.label.padEnd(18)} ${"0".padStart(8)}  (no signals)`);
        continue;
      }
      const wins = inBand.filter(isWin).length;
      const avgMaxAdverse =
        inBand.reduce((sum, s) => sum + s.maxPct, 0) / inBand.length;
      console.log(
        `  ${b.label.padEnd(18)} ${String(inBand.length).padStart(8)} ` +
          `${String(wins).padStart(6)} ${pct(wins, inBand.length).padStart(8)} ` +
          `${("+" + avgMaxAdverse.toFixed(1) + "%").padStart(14)}`,
      );
    }

    // Verdict: does win rate degrade as funding gets more extreme?
    const moderate = buildingAll.filter((s) => s.fundingApr > -500);
    const extreme = buildingAll.filter((s) => s.fundingApr <= -500);
    const modWR = moderate.length
      ? (moderate.filter(isWin).length / moderate.length) * 100
      : 0;
    const extWR = extreme.length
      ? (extreme.filter(isWin).length / extreme.length) * 100
      : 0;
    console.log(
      `\n  Moderate (-200 to -500): ${pct(moderate.filter(isWin).length, moderate.length)}` +
        `  vs  Extreme (≤ -500): ${pct(extreme.filter(isWin).length, extreme.length)}`,
    );
    const gap = modWR - extWR;
    console.log(
      `  Verdict: ${
        extreme.length >= 30 && gap >= 15
          ? `✅ extreme funding is materially worse (${gap.toFixed(0)}pt gap) — ` +
            `consider tightening buildingMinFundingApr or capping the extreme band`
          : extreme.length >= 30 && gap <= -15
            ? `✅ extreme funding is materially BETTER (${(-gap).toFixed(0)}pt gap) — thesis holds`
            : `⚠️ no material difference (${gap.toFixed(0)}pt gap) — leave buildingMinFundingApr as-is`
      }`,
    );
    // AvgMaxAdverse matters for stop-loss design even if win rate is flat:
    // a high adverse excursion means winners still spike hard against you first.
    console.log(
      `  Note: AvgMaxAdverse = mean peak move against the short before reversal.\n` +
        `        High values mean a 12% stop gets clipped even on eventual winners.`,
    );
  }

  // ── OI-GATE ANALYSIS — would the scanner's OI-rising gate change BUILDING? ──
  // The OI-gate scanner blocks BUILDING when OI rose too fast:
  //   queue only if oiDropPct >= BUILDING_OI_RISING_MAX (-150).
  // Negative oiDropPct = OI rising. Fail-open: signals with no OI history
  // (hadOiData=false) pass, matching the live `oiDropPct ?? 0` default.
  const OI_GATE = -150;
  const buildingSignals: QueuedDetail[] = [];
  for (const c of allCoins)
    for (const s of c.queued?.signals_detail ?? [])
      if (s.type === "BUILDING") buildingSignals.push(s);

  if (buildingSignals.length) {
    const isWin = (s: QueuedDetail) =>
      ["DROPPED", "PUMP+DUMP"].includes(s.verdict);
    // Gate blocks a signal only when OI data exists AND OI rose past the limit.
    const blockedByGate = (s: QueuedDetail) =>
      (s.hadOiData ?? false) && (s.oiDropPct ?? 0) < OI_GATE;

    const withOi = buildingSignals.filter((s) => s.hadOiData);
    const gateOnKept = buildingSignals.filter((s) => !blockedByGate(s));
    const removed = buildingSignals.filter(blockedByGate);

    const wr = (arr: QueuedDetail[]) =>
      pct(arr.filter(isWin).length, arr.length);

    console.log("\n" + "─".repeat(64));
    console.log("  OI-GATE ANALYSIS — BUILDING win rate, gate OFF vs gate ON");
    console.log("─".repeat(64));
    console.log(
      `  OI-data coverage: ${withOi.length}/${buildingSignals.length} ` +
        `BUILDING signals had OI history (${pct(withOi.length, buildingSignals.length)}).\n` +
        `  The gate can only act on those; the rest fail-open (pass).`,
    );
    console.log(
      `\n  Gate OFF (current): ${buildingSignals.filter(isWin).length}/${buildingSignals.length} ` +
        `won — ${wr(buildingSignals)} win rate`,
    );
    console.log(
      `  Gate ON  (OI>=${OI_GATE}): ${gateOnKept.filter(isWin).length}/${gateOnKept.length} ` +
        `won — ${wr(gateOnKept)} win rate`,
    );
    console.log(
      `  Gate removes ${removed.length} BUILDING signal(s) — ` +
        `${removed.filter(isWin).length} would-be winners, ` +
        `${removed.filter((s) => !isWin(s)).length} would-be losers.`,
    );
    if (removed.length) {
      console.log(`\n  Signals the OI gate would block:`);
      removed.sort((a, b) => (a.oiDropPct ?? 0) - (b.oiDropPct ?? 0));
      for (const s of removed) {
        console.log(
          `    ${s.firedAt}  funding:${s.fundingApr.toFixed(0)}%  ` +
            `oiDrop:${(s.oiDropPct ?? 0).toFixed(0)}%  -> ${s.verdict}` +
            `${isWin(s) ? "  (winner removed)" : ""}`,
        );
      }
    }
    const offWR =
      (buildingSignals.filter(isWin).length / buildingSignals.length) * 100;
    const onWR = gateOnKept.length
      ? (gateOnKept.filter(isWin).length / gateOnKept.length) * 100
      : 0;
    console.log(
      `\n  Verdict: ${
        removed.length < 5
          ? `⚠️ gate acts on only ${removed.length} signal(s) — too few to judge ` +
            `(OI coverage limits the test). Gather more OI-covered data.`
          : onWR - offWR >= 3
            ? `✅ gate lifts BUILDING win rate ${offWR.toFixed(0)}%->${onWR.toFixed(0)}% ` +
              `on ${removed.length} signals — worth modelling in the backtest.`
            : `⚠️ gate moves win rate ${offWR.toFixed(0)}%->${onWR.toFixed(0)}% — ` +
              `not material; OI gate adds little.`
      }`,
    );
  }

  console.log(`\n  -> ${RESULT_FILE} written`);
  console.log("═".repeat(64));
}

function pct(n: number, d: number): string {
  return d ? ((100 * n) / d).toFixed(0) + "%" : "—";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
