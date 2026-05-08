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

import { readFileSync, existsSync } from "fs";
import { scanCoin, defaultState, buildFundingByHour } from "./live_scanner.ts";
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
//   1. Live scanner uses Bybit-only funding (backtest merges Binance+Bybit). At
//      the EXHAUSTION trigger hour, Binance funding had often normalised but
//      Bybit hadn't, so the live scanner keeps seeing BUILDING and never crosses
//      into the -20%–+5% exhaustion band before cumulative price retraces.
//   2. Bybit's /open-interest API caps at ~200 records (≈8 days), so for any
//      expected signal before the OI window starts (~2026-04-29 in current
//      fixtures), checkGate2 and the exhaustion OI gate cannot run.
// These tests pin actual current behaviour as the regression baseline.
const TESTS: ScannerTestCase[] = [
  {
    coin: "KNC",
    expect: {
      minAlerts: 2,
      mustInclude: [
        { type: "BUILDING", confidence: "MEDIUM", approxHour: "2026-05-02" },
      ],
    },
  },
  {
    coin: "HIVE",
    expect: {
      mustInclude: [
        { type: "BUILDING", confidence: "MEDIUM", approxHour: "2026-05-05" },
      ],
    },
  },
  {
    coin: "ORDI",
    expect: {
      minAlerts: 10,
      mustInclude: [
        { type: "BUILDING", confidence: "MEDIUM", approxHour: "2026-04-16" },
        { type: "FUNDING",  confidence: "MEDIUM", approxHour: "2026-04-29" },
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
        { type: "BUILDING", confidence: "MEDIUM", approxHour: "2026-04-12" },
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
];

const MIN_WINDOW = 25; // PARAMS.squeezeHours (10) + RSI warmup (15)

async function runTest(tc: ScannerTestCase): Promise<string[]> {
  const fixturePath = `${FIXTURE_DIR}/${tc.coin}.json`;
  if (!existsSync(fixturePath)) return [`SKIP: no fixture for ${tc.coin}`];

  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    candles: any[]; fundingBybit: any[]; oi: any[];
  };

  const fundingByHour = buildFundingByHour(fx.fundingBybit);
  const failures: string[] = [];
  const allAlerts: Alert[] = [];
  let state = defaultState();

  for (let i = MIN_WINDOW; i < fx.candles.length; i++) {
    const { alerts, newState } = scanCoin(
      tc.coin, state,
      fx.candles.slice(0, i + 1),
      fundingByHour,
      fx.oi.filter((r: any) => r.timeMs <= fx.candles[i].t).slice(-10),
    );
    allAlerts.push(...alerts);
    state = newState;
  }

  if (tc.expect.minAlerts && allAlerts.length < tc.expect.minAlerts)
    failures.push(`Expected >= ${tc.expect.minAlerts} alerts, got ${allAlerts.length}`);

  for (const expected of tc.expect.mustInclude ?? []) {
    const match = allAlerts.find(a =>
      a.type === expected.type &&
      (!expected.confidence || a.confidence === expected.confidence) &&
      (!expected.approxHour  || a.firedAtStr.startsWith(expected.approxHour))
    );
    if (!match)
      failures.push(`Missing: ${expected.type} [${expected.confidence ?? "any"}] ~${expected.approxHour ?? "anytime"}`);
  }

  if (tc.expect.stateAfter?.lastBuildingMinFunding?.lessThan !== undefined) {
    const threshold = tc.expect.stateAfter.lastBuildingMinFunding.lessThan;
    if (state.lastBuildingMinFunding >= threshold)
      failures.push(`lastBuildingMinFunding ${state.lastBuildingMinFunding} should be < ${threshold}`);
  }

  return failures;
}

async function main() {
  const args   = process.argv.slice(2);
  const filter = args.find(a => !a.startsWith("--"));
  const tests  = filter ? TESTS.filter(t => t.coin === filter.toUpperCase()) : TESTS;

  console.log("\nAltShortBot Scanner Regression Tests");
  console.log("══════════════════════════════════════");
  console.log(`Running ${tests.length} test(s)...\n`);

  let passed = 0, failed = 0;
  for (const tc of tests) {
    const failures = await runTest(tc);
    if (failures[0]?.startsWith("SKIP")) {
      console.log(`  ${tc.coin.padEnd(8)} ⏭  ${failures[0]}`);
    } else if (failures.length === 0) {
      console.log(`  ${tc.coin.padEnd(8)} ✅`);
      passed++;
    } else {
      console.log(`  ${tc.coin.padEnd(8)} ❌`);
      failures.forEach(f => console.log(`             ${f}`));
      failed++;
    }
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
