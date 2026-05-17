/**
 * AltShortBot Live Scanner — Regression Tests
 * ============================================
 * Feeds fixture data through scanCoin() hour by hour and asserts
 * known-good signals fire with correct type, confidence, and timing.
 *
 * Uses the same fixtures/ directory as backtest_test.ts.
 * Run backtest_test.ts first to capture fixtures.
 *
 * Usage:
 *   npx tsx scanner_test.ts          ← all coins
 *   npx tsx scanner_test.ts KNC      ← single coin
 */

import { existsSync, readFileSync } from "fs";
import {
  buildMergedFundingByHour,
  defaultState,
  scanCoin,
} from "./live_scanner.ts";
import type { Alert } from "./shared_types.ts";

const FIXTURE_DIR = "fixtures";

interface ScannerTestCase {
  coin: string;
  expect: {
    minAlerts?: number;
    mustInclude?: Array<{
      type: string;
      confidence?: string;
      approxHour?: string; // firedAtStr prefix match, e.g. "2026-04-16 10"
    }>;
    stateAfter?: {
      lastBuildingMinFunding?: { lessThan: number };
    };
  };
}

// Expectations are calibrated to live-scanner output on the captured fixtures.
// Notably weaker than backtest_test.ts because:
//   1. Both live scanner and backtest now merge Bybit+Binance funding (most
//      extreme per hour). However, the EXHAUSTION trigger still rarely fires
//      because Bybit funding forward-fills between 4–8h settlements, keeping
//      fundingApr far below -20% for hours after the actual squeeze peak.
//   2. Bybit's /open-interest API caps at ~200 records (≈8 days), so for any
//      expected signal before the OI window starts (~2026-04-29 in current
//      fixtures), checkGate2 and the exhaustion OI gate cannot run.
//   3. BUILDING signals with oiDropPct < -50 are detected but flagged as
//      "OI rising" — they fire as alerts but are blocked from the executor
//      queue in live_scanner.ts main(). scanCoin() itself always fires them.
// These tests pin actual current behaviour as the regression baseline.
const TESTS: ScannerTestCase[] = [
  {
    coin: "KNC",
    expect: {
      minAlerts: 2,
      mustInclude: [
        { type: "BUILDING", approxHour: "2026-05-02" }, // confidence omitted — may be HIGH if funding ≤ -1000%
      ],
    },
  },
  {
    coin: "HIVE",
    expect: {
      mustInclude: [
        { type: "BUILDING", approxHour: "2026-05-05" }, // confidence omitted — may be HIGH if funding ≤ -1000%
      ],
    },
  },
  {
    coin: "ORDI",
    expect: {
      minAlerts: 10,
      mustInclude: [
        // confidence omitted — funding APR unknown; may be HIGH (≤-1000%) or MEDIUM
        { type: "BUILDING", approxHour: "2026-04-16" },
        { type: "FUNDING", confidence: "MEDIUM", approxHour: "2026-04-29" },
      ],
    },
  },
  {
    coin: "SPK",
    expect: {
      minAlerts: 5,
      mustInclude: [
        { type: "BUILDING", confidence: "MEDIUM", approxHour: "2026-04-20" },
      ],
      // lastBuildingMinFunding < -500 is the TREND_BREAK precondition — even
      // though TREND_BREAK doesn't fire on this fixture (no EXHAUSTION upstream),
      // assert the state machine correctly recorded the deeply negative funding.
      stateAfter: { lastBuildingMinFunding: { lessThan: -500 } },
    },
  },
  {
    coin: "ENJ",
    expect: {
      minAlerts: 10,
      mustInclude: [
        // confidence omitted — funding APR unknown; may be HIGH (≤-1000%) or MEDIUM
        { type: "BUILDING", approxHour: "2026-04-12" },
      ],
    },
  },
  {
    coin: "HYPER",
    expect: {
      minAlerts: 3,
      mustInclude: [
        { type: "FUNDING", confidence: "MEDIUM", approxHour: "2026-04-30" },
      ],
      // HYPER is in a parabolic uptrend during the fixture window — BUILDING
      // alerts are suppressed by the trend filter, but the underlying
      // lastBuildingMinFunding is still recorded internally.
      stateAfter: { lastBuildingMinFunding: { lessThan: -500 } },
    },
  },
  {
    coin: "WIF",
    expect: {
      minAlerts: 2,
      mustInclude: [
        // BUILDING at -1699% APR — extreme funding → HIGH confidence (≤ -1000% threshold)
        { type: "BUILDING", confidence: "HIGH", approxHour: "2026-05-06 08" },
      ],
      stateAfter: { lastBuildingMinFunding: { lessThan: -1000 } },
    },
  },
  {
    coin: "BSB",
    expect: {
      minAlerts: 5,
      mustInclude: [
        // BUILDING May 5 at -268% APR — precedes profitable exhaustion cluster
        { type: "BUILDING", approxHour: "2026-05-05" }, // confidence omitted — may be HIGH if funding ≤ -1000%
      ],
      stateAfter: { lastBuildingMinFunding: { lessThan: -200 } },
    },
  },
];

const MIN_WINDOW = 25; // PARAMS.squeezeHours (10) + RSI warmup (15)

async function runTest(tc: ScannerTestCase): Promise<string[]> {
  const fixturePath = `${FIXTURE_DIR}/${tc.coin}.json`;
  if (!existsSync(fixturePath)) return [`SKIP: no fixture for ${tc.coin}`];

  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    candles: any[];
    fundingBybit: any[];
    oi: any[];
  };

  // Use merged Bybit+Binance funding to match live scanner behaviour
  const fundingBinance = (fx as any).fundingBinance ?? [];
  const fundingByHour = buildMergedFundingByHour(
    fx.fundingBybit,
    fundingBinance,
  );
  const failures: string[] = [];
  const allAlerts: Alert[] = [];
  let state = defaultState();

  for (let i = MIN_WINDOW; i < fx.candles.length; i++) {
    const { alerts, newState } = scanCoin(
      tc.coin,
      state,
      fx.candles.slice(0, i + 1),
      fundingByHour,
      fx.oi.filter((r: any) => r.timeMs <= fx.candles[i].t).slice(-10),
    );
    allAlerts.push(...alerts);
    state = newState;
  }

  if (tc.expect.minAlerts && allAlerts.length < tc.expect.minAlerts)
    failures.push(
      `Expected >= ${tc.expect.minAlerts} alerts, got ${allAlerts.length}`,
    );

  for (const expected of tc.expect.mustInclude ?? []) {
    const match = allAlerts.find(
      (a) =>
        a.type === expected.type &&
        (!expected.confidence || a.confidence === expected.confidence) &&
        (!expected.approxHour || a.firedAtStr.startsWith(expected.approxHour)),
    );
    if (!match)
      failures.push(
        `Missing: ${expected.type} [${expected.confidence ?? "any"}] ~${expected.approxHour ?? "anytime"}`,
      );
  }

  if (tc.expect.stateAfter?.lastBuildingMinFunding?.lessThan !== undefined) {
    const threshold = tc.expect.stateAfter.lastBuildingMinFunding.lessThan;
    if (state.lastBuildingMinFunding >= threshold)
      failures.push(
        `lastBuildingMinFunding ${state.lastBuildingMinFunding} should be < ${threshold}`,
      );
  }

  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith("--"));
  const tests = filter
    ? TESTS.filter((t) => t.coin === filter.toUpperCase())
    : TESTS;

  console.log("\nAltShortBot Scanner Regression Tests");
  console.log("══════════════════════════════════════");
  console.log(`Running ${tests.length} test(s)...\n`);

  let passed = 0,
    failed = 0;
  for (const tc of tests) {
    const failures = await runTest(tc);
    if (failures[0]?.startsWith("SKIP")) {
      console.log(`  ${tc.coin.padEnd(8)} ⏭  ${failures[0]}`);
    } else if (failures.length === 0) {
      console.log(`  ${tc.coin.padEnd(8)} ✅`);
      passed++;
    } else {
      console.log(`  ${tc.coin.padEnd(8)} ❌`);
      failures.forEach((f) => console.log(`             ${f}`));
      failed++;
    }
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
