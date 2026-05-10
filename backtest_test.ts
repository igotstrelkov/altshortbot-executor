/**
 * AltShortBot Backtest Regression Tests
 * ========================================
 * Runs the backtest for each validated coin and asserts known-good outcomes.
 *
 * Usage:
 *   npx tsx backtest_test.ts           — run all tests
 *   npx tsx backtest_test.ts ORDI      — run one coin
 *   npx tsx backtest_test.ts --update  — re-generate expected fixtures from live data
 *
 * Parameter notes:
 *   --exhaust-oi-drop is omitted — Bybit OI covers only 200h (~8 days);
 *     test signals span 30 days so older signals have no OI data and would all fail.
 *     Validated separately: NOT coin backtest shows OI filter blocks flat-OI signals.
 *   --pump-squeeze-funding is omitted — diagnostic only, not traded in live scanner.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";

const FIXTURE_DIR = "fixtures";
const UPDATE_FIXTURES = process.argv.includes("--update-fixtures");

// ─── Types ────────────────────────────────────────────────────────────────────
interface SignalDetail {
  firedAt: string;
  phase?: string;
  entry: number;
  finalPct: number;
  maxPct: number;
  verdict: string;
}

interface CoinJSON {
  coin: string;
  funding: {
    signals: number;
    wins: number;
    winRate: number | null;
    signals_detail: SignalDetail[];
  };
  pump: {
    signals: number;
    wins: number;
    winRate: number | null;
    signals_detail: SignalDetail[];
  };
  squeeze: {
    building: number;
    exhaustion: number;
    trendBreak: number;
    wins: number;
    winRate: number | null;
    signals_detail: SignalDetail[];
  };
}

interface ResultJSON {
  coins: CoinJSON[];
}

// ─── Test cases ───────────────────────────────────────────────────────────────
interface TestCase {
  coin: string;
  days: number;
  args: string[];
  expect: {
    funding?: { minSignals?: number; minWins?: number; minWinRate?: number };
    pump?: { minSignals?: number; minWins?: number };
    squeeze?: {
      minBuilding?: number;
      minExhaustion?: number;
      minWins?: number;
      minWinRate?: number;
      // specific signals that must be present
      mustInclude?: Array<{ firedAt: string; verdict: string; phase?: string }>;
      // signals that must NOT be present (false positives we fixed)
      mustExclude?: Array<{ firedAt: string }>;
    };
  };
}

const TESTS: TestCase[] = [
  {
    coin: "HYPER",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      funding: { minSignals: 1, minWins: 1, minWinRate: 100 },
      pump: { minSignals: 1, minWins: 1 },
      squeeze: {
        minTrendBreak: 2,
        minWins: 2,
        mustInclude: [
          {
            firedAt: "2026-04-25 18:00",
            verdict: "PUMP+DUMP",
            phase: "TREND_BREAK",
          },
          {
            firedAt: "2026-04-25 21:00",
            verdict: "DROPPED",
            phase: "TREND_BREAK",
          },
        ],
      } as any,
    },
  },
  {
    coin: "HIVE",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      pump: { minSignals: 1, minWins: 1 },
      squeeze: {
        minBuilding: 1,
        minExhaustion: 1,
        minWins: 1,
        mustInclude: [
          {
            firedAt: "2026-05-05 09:00",
            verdict: "PUMP+DUMP",
            phase: "EXHAUSTION",
          },
        ],
      },
    },
  },
  {
    coin: "KNC",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      squeeze: {
        minBuilding: 1,
        minExhaustion: 3,
        minWins: 3,
        minWinRate: 100,
        mustInclude: [
          {
            firedAt: "2026-05-02 09:00",
            verdict: "PUMP+DUMP",
            phase: "EXHAUSTION",
          },
          {
            firedAt: "2026-05-02 19:00",
            verdict: "PUMP+DUMP",
            phase: "EXHAUSTION",
          },
          {
            firedAt: "2026-05-02 22:00",
            verdict: "PUMP+DUMP",
            phase: "EXHAUSTION",
          },
        ],
      },
    },
  },
  {
    coin: "WIF",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      squeeze: {
        minBuilding: 1,
        minExhaustion: 1,
        minWins: 1,
      },
    },
  },
  {
    coin: "SPK",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      squeeze: {
        minBuilding: 1,
        minTrendBreak: 2,
        minWins: 2,
        mustInclude: [
          {
            firedAt: "2026-04-23 14:00",
            verdict: "DROPPED",
            phase: "TREND_BREAK",
          },
          {
            firedAt: "2026-04-23 18:00",
            verdict: "PUMP+DUMP",
            phase: "TREND_BREAK",
          },
        ],
      } as any,
    },
  },
  {
    coin: "ENJ",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      squeeze: {
        minBuilding: 10,
        minExhaustion: 1, // conservative — some signals may be blocked by --exhaust-oi-drop 3
        minWins: 1,
      },
    },
  },
  {
    coin: "ORDI",
    days: 30,
    args: [
      "--threshold",
      "10",
      "--min-positive",
      "2",
      "--min-oi",
      "2",
      "--max-price",
      "2",
      "--pump-pct",
      "25",
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
      // NOTE: --exhaust-oi-drop intentionally omitted.
      // Bybit OI endpoint returns max 200h (~8 days) but test signals span 30 days.
      // Signals older than 8 days have oiStart=0 → oiDropPct=0 → all exhaustion blocked.
      // The OI filter is validated separately via NOT coin backtest analysis.
      // The live scanner always fetches recent OI so the filter works correctly in production.
      "--lookahead",
      "48",
    ],
    expect: {
      squeeze: {
        minBuilding: 1,
        minExhaustion: 2, // Apr signals may be blocked by --exhaust-oi-drop 3
        minWins: 2,
        mustInclude: [
          // May 2 signals confirmed passing OI-drop >= 3% (OI-61.8%, OI-27.3%)
          {
            firedAt: "2026-05-02 18:00",
            verdict: "DROPPED",
            phase: "EXHAUSTION",
          },
          {
            firedAt: "2026-05-02 23:00",
            verdict: "DROPPED",
            phase: "EXHAUSTION",
          },
        ],
      },
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────
function runBacktest(
  coin: string,
  days: number,
  args: string[],
): CoinJSON | null | "SKIPPED" {
  const jsonFile = `/tmp/bt_test_${coin}.json`;
  // Remove stale file from previous run
  try {
    require("fs").unlinkSync(jsonFile);
  } catch {
    /* fine if it doesn't exist */
  }
  const fixtureFile = `${FIXTURE_DIR}/${coin}.json`;
  const fixtureArg = UPDATE_FIXTURES
    ? ["--save-fixtures", FIXTURE_DIR] // explicit refresh: overwrite
    : existsSync(fixtureFile)
      ? ["--use-fixtures", FIXTURE_DIR] // fixture exists: use it
      : ["--save-fixtures", FIXTURE_DIR]; // no fixture yet: fetch + save automatically

  const cmdArgs = [
    "backtest_signals.ts",
    "--coin",
    coin,
    "--days",
    String(days),
    "--json",
    jsonFile,
    ...fixtureArg,
    ...args,
  ];

  // Resolve the working directory relative to this test file
  const cwd = process.cwd();

  const result = spawnSync("npx", ["tsx", ...cmdArgs], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    shell: true, // use shell so npx is found via PATH on any machine
  });

  if (result.error) {
    console.error(`  ❌ Spawn error for ${coin}: ${result.error.message}`);
    return null;
  }

  // Check if the coin is delisted (403) or has no data — mark as SKIP
  const stdout = result.stdout || "";
  if (
    stdout.includes("HTTP 403") ||
    stdout.includes("No price data returned")
  ) {
    console.log(`  ⏭  ${coin} — SKIPPED (coin delisted or data unavailable)`);
    return "SKIPPED";
  }

  if (result.status !== 0) {
    console.error(`  ❌ Backtest failed for ${coin} (exit ${result.status}):`);
    const errOut = (result.stderr || result.stdout || "").slice(0, 800);
    console.error(errOut || "(no output)");
    return null;
  }

  if (!existsSync(jsonFile)) {
    console.error(`  ❌ JSON output not created for ${coin}`);
    console.error(result.stdout?.slice(0, 400));
    return null;
  }

  const data: ResultJSON = JSON.parse(readFileSync(jsonFile, "utf8"));
  return data.coins.find((c) => c.coin === coin) ?? null;
}

// ─── Assertions ───────────────────────────────────────────────────────────────
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function runTest(tc: TestCase): {
  passed: boolean;
  failures: string[];
  skipped?: boolean;
} {
  const failures: string[] = [];

  console.log(`\n  Running ${tc.coin} (${tc.days}d)...`);
  const coin = runBacktest(tc.coin, tc.days, tc.args);

  if (coin === "SKIPPED") {
    return { passed: true, failures: [], skipped: true };
  }

  if (!coin) {
    return { passed: false, failures: ["Backtest failed to produce output"] };
  }

  // Funding assertions
  if (tc.expect.funding) {
    const f = tc.expect.funding;
    if (f.minSignals !== undefined && coin.funding.signals < f.minSignals)
      failures.push(
        `Funding: expected >=${f.minSignals} signals, got ${coin.funding.signals}`,
      );
    if (f.minWins !== undefined && coin.funding.wins < f.minWins)
      failures.push(
        `Funding: expected >=${f.minWins} wins, got ${coin.funding.wins}`,
      );
    if (
      f.minWinRate !== undefined &&
      (coin.funding.winRate ?? 0) < f.minWinRate
    )
      failures.push(
        `Funding: win rate ${coin.funding.winRate}% < expected ${f.minWinRate}%`,
      );
  }

  // Pump assertions
  if (tc.expect.pump) {
    const p = tc.expect.pump;
    if (p.minSignals !== undefined && coin.pump.signals < p.minSignals)
      failures.push(
        `Pump: expected >=${p.minSignals} signals, got ${coin.pump.signals}`,
      );
    if (p.minWins !== undefined && coin.pump.wins < p.minWins)
      failures.push(
        `Pump: expected >=${p.minWins} wins, got ${coin.pump.wins}`,
      );
  }

  // Squeeze assertions
  if (tc.expect.squeeze) {
    const s = tc.expect.squeeze as any;
    const sq = coin.squeeze;

    if (s.minBuilding !== undefined && sq.building < s.minBuilding)
      failures.push(
        `Squeeze: expected >=${s.minBuilding} building alerts, got ${sq.building}`,
      );
    if (s.minExhaustion !== undefined && sq.exhaustion < s.minExhaustion)
      failures.push(
        `Squeeze: expected >=${s.minExhaustion} exhaustion signals, got ${sq.exhaustion}`,
      );
    if (s.minTrendBreak !== undefined && sq.trendBreak < s.minTrendBreak)
      failures.push(
        `Squeeze: expected >=${s.minTrendBreak} trend-break signals, got ${sq.trendBreak}`,
      );
    if (s.minWins !== undefined && sq.wins < s.minWins)
      failures.push(`Squeeze: expected >=${s.minWins} wins, got ${sq.wins}`);
    if (s.minWinRate !== undefined && (sq.winRate ?? 0) < s.minWinRate)
      failures.push(
        `Squeeze: win rate ${sq.winRate}% < expected ${s.minWinRate}%`,
      );

    if (s.mustInclude) {
      for (const expected of s.mustInclude) {
        const found = sq.signals_detail.find(
          (d: SignalDetail) =>
            d.firedAt === expected.firedAt &&
            d.verdict === expected.verdict &&
            (!expected.phase || d.phase === expected.phase),
        );
        if (!found)
          failures.push(
            `Squeeze: missing expected signal at ${expected.firedAt} → ${expected.verdict}${expected.phase ? ` [${expected.phase}]` : ""}`,
          );
      }
    }

    if (s.mustExclude) {
      for (const excluded of s.mustExclude) {
        const found = sq.signals_detail.find(
          (d: SignalDetail) => d.firedAt === excluded.firedAt,
        );
        if (found)
          failures.push(
            `Squeeze: false-positive signal should not exist at ${excluded.firedAt}`,
          );
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function captureFixtures(coins: string[]) {
  console.log(
    `\n⚠️  --update-fixtures will overwrite saved API data in ${FIXTURE_DIR}/.`,
  );
  console.log(
    `    Tests may fail if market conditions have changed since last capture.`,
  );
  console.log(
    `    Review signal counts and update test expectations before committing.\n`,
  );
  console.log(
    `Capturing fixtures for ${coins.length} coin(s) → ${FIXTURE_DIR}/`,
  );
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const tc of TESTS.filter((t) => coins.includes(t.coin))) {
    console.log(`  ${tc.coin}...`);
    const result = spawnSync(
      "npx",
      [
        "tsx",
        "backtest_signals.ts",
        "--coin",
        tc.coin,
        "--days",
        String(tc.days),
        "--save-fixtures",
        FIXTURE_DIR,
        ...tc.args,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 180_000, shell: true },
    );
    const saved = existsSync(`${FIXTURE_DIR}/${tc.coin}.json`);
    console.log(saved ? `  ✅ ${tc.coin} saved` : `  ❌ ${tc.coin} failed`);
  }
  console.log("\nDone. Next steps:");
  console.log("  1. Run tests to verify:  npx tsx backtest_test.ts");
  console.log(
    "  2. Update expectations if counts changed (check signal timestamps)",
  );
  console.log(
    "  3. Commit fixtures to lock them: git add fixtures/ && git commit -m 'chore: refresh backtest fixtures'",
  );
  console.log(
    "\n  ⚠️  Do NOT run --update-fixtures again unless deliberately re-validating.",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith("--"));
  const toRun = filter
    ? TESTS.filter((t) => t.coin === filter.toUpperCase())
    : TESTS;

  if (toRun.length === 0) {
    console.error(`No test found for coin: ${filter}`);
    process.exit(1);
  }

  const fixturedCoins = toRun.filter((t) =>
    existsSync(`${FIXTURE_DIR}/${t.coin}.json`),
  ).length;
  const liveCoins = toRun.length - fixturedCoins;

  console.log(`\nAltShortBot Backtest Regression Tests`);
  console.log(`══════════════════════════════════════`);
  if (fixturedCoins > 0)
    console.log(
      `Fixtures: ${fixturedCoins}/${toRun.length} coins using saved data (deterministic) — commit fixtures/ to git to lock permanently`,
    );
  if (liveCoins > 0)
    console.log(
      `Live API: ${liveCoins} coin(s) have no fixture — will fetch and save automatically`,
    );
  console.log(`Running ${toRun.length} test(s)...\n`);

  let passed = 0,
    failed = 0;
  const startMs = Date.now();

  for (const tc of toRun) {
    const { passed: ok, failures, skipped } = runTest(tc);
    if (ok && skipped) {
      console.log(`  ⏭  ${tc.coin} — skipped (delisted/no data)`);
    } else if (ok) {
      console.log(`  ✅ ${tc.coin} — all assertions passed`);
      passed++;
    } else {
      console.log(`  ❌ ${tc.coin} — ${failures.length} failure(s):`);
      failures.forEach((f) => console.log(`       • ${f}`));
      failed++;
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n══════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed  (${elapsed}s)`);
  if (failed > 0) process.exit(1);
}

if (UPDATE_FIXTURES) {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith("--"));
  const coins = filter ? [filter.toUpperCase()] : TESTS.map((t) => t.coin);
  captureFixtures(coins).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
