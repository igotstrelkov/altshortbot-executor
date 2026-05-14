/**
 * simulate_gates.ts
 * =================
 * Verifies that the BUILDING queue gates correctly queue/block known signals.
 * Uses hardcoded signal data (OI, pump tops) from prior backtest analysis —
 * no API calls, runs in <1s, fully deterministic.
 *
 * Run before every deploy:
 *   npx tsx simulate_gates.ts
 *
 * To add a new signal:
 *   1. Run the backtest for the coin and note the oiDropPct from the signal line
 *   2. Check if a PUMP_TOP fired within PUMP_TOP_COOLDOWN_H hours before
 *   3. Add an entry below with expectBlocked set correctly
 *
 * Constants are imported from live_scanner.ts — no manual sync needed.
 */

import {
  FUNDING_THRESHOLD,
  BUILDING_OI_RISING_MAX as OI_RISING_MAX,
  BUILDING_OI_RISING_MAX_REFIRE as OI_RISING_MAX_REFIRE,
  PUMP_TOP_COOLDOWN_H,
} from "./live_scanner.ts";

// ── Signal data ───────────────────────────────────────────────────────────────
// oiDropPct:        from backtest output (e.g. "OI--182.9%" → -182.9)
// pumpTopHoursAgo:  hours between preceding PUMP_TOP and this signal (null = none)
// isRefire:         true if funding 2× more extreme than prior BUILDING in same wave
// expectBlocked:    true = gate should block; false = gate should queue (default)
const SIGNALS: Array<{
  coin: string;
  firedAt: string;
  fundingApr: number;
  oiDropPct: number;
  pumpTopHoursAgo: number | null;
  isRefire?: boolean;
  result: string;
  expectBlocked?: boolean;
}> = [
  // ── May 10 batch — all 6 queued, all profitable ───────────────────────────
  {
    coin: "RAVE",
    firedAt: "2026-05-10 00:12",
    fundingApr: -239.0,
    oiDropPct: 0.0,
    pumpTopHoursAgo: null,
    result: "+15.07%",
  },
  {
    coin: "XION",
    firedAt: "2026-05-10 05:12",
    fundingApr: -1446.3,
    oiDropPct: 0.0,
    pumpTopHoursAgo: 2.2,
    result: "+9.30%",
  },
  {
    coin: "1000XEC",
    firedAt: "2026-05-10 09:12",
    fundingApr: -1338.0,
    oiDropPct: 0.0,
    pumpTopHoursAgo: 5.2,
    result: "+13.79%",
  },
  {
    coin: "SNT",
    firedAt: "2026-05-10 10:12",
    fundingApr: -2444.5,
    oiDropPct: 0.0,
    pumpTopHoursAgo: null,
    result: "+10.09%",
  },
  {
    coin: "SOLAYER",
    firedAt: "2026-05-10 13:12",
    fundingApr: -224.2,
    oiDropPct: -103.7,
    pumpTopHoursAgo: null,
    result: "+16.86%",
  },
  {
    coin: "WAL",
    firedAt: "2026-05-10 15:12",
    fundingApr: -741.5,
    oiDropPct: 0.0,
    pumpTopHoursAgo: null,
    result: "+1.36%",
  },

  // ── SOLV May 12 — OI gate in action ──────────────────────────────────────
  // First fire: OI rising strongly (-182.9%) → blocked (price had 5%+ excursion before reversing)
  {
    coin: "SOLV",
    firedAt: "2026-05-12 12:00",
    fundingApr: -447.1,
    oiDropPct: -182.9,
    pumpTopHoursAgo: null,
    result:
      "PUMP+DUMP (price peaked +5% before reversing — stop would have hit intraday)",
    expectBlocked: true,
  },

  // Re-fire: funding 2× more extreme (-997% vs -447%), OI slightly less extreme (-172.5%)
  // → permissive -200% threshold for re-fires → queued, immediate DROPPED -6.25%
  {
    coin: "SOLV",
    firedAt: "2026-05-12 16:00",
    fundingApr: -996.8,
    oiDropPct: -172.5,
    pumpTopHoursAgo: null,
    isRefire: true,
    result: "DROPPED -6.25% (max +0.27% adverse — immediate reversal)",
  },
  {
    coin: "MBOX",
    firedAt: "2026-05-13 12:00",
    fundingApr: -1354.5,
    oiDropPct: -133.0,
    pumpTopHoursAgo: null,
    isRefire: false,
    result: "+30%",
  },
];

// ── Gate logic ────────────────────────────────────────────────────────────────
function applyGates(sig: (typeof SIGNALS)[0]): {
  g1: boolean;
  g2: boolean;
  g3: boolean;
  wouldQueue: boolean;
  oiThreshold: number;
} {
  const oiThreshold = sig.isRefire ? OI_RISING_MAX_REFIRE : OI_RISING_MAX;
  const g1 = sig.fundingApr <= FUNDING_THRESHOLD;
  const g2 = sig.oiDropPct >= oiThreshold;
  const g3 =
    sig.pumpTopHoursAgo === null || sig.pumpTopHoursAgo >= PUMP_TOP_COOLDOWN_H;
  return { g1, g2, g3, wouldQueue: g1 && g2 && g3, oiThreshold };
}

// ── Runner ────────────────────────────────────────────────────────────────────
function main() {
  console.log("\nGate Simulation — would these signals be queued?");
  console.log(
    `Thresholds: funding ≤ ${FUNDING_THRESHOLD}%  |  OI ≥ ${OI_RISING_MAX}% (first) / ${OI_RISING_MAX_REFIRE}% (re-fire)  |  pump top cooldown: ${PUMP_TOP_COOLDOWN_H}h`,
  );
  console.log("═".repeat(80));

  let queued = 0,
    failures = 0;
  const expectedQueued = SIGNALS.filter((s) => !s.expectBlocked).length;
  const expectedBlocked = SIGNALS.filter((s) => s.expectBlocked).length;
  let actualBlocked = 0;

  for (const sig of SIGNALS) {
    const { g1, g2, g3, wouldQueue, oiThreshold } = applyGates(sig);
    const expectBlocked = sig.expectBlocked === true;
    const passed = expectBlocked ? !wouldQueue : wouldQueue;

    if (wouldQueue) queued++;
    if (!wouldQueue) actualBlocked++;
    if (!passed) failures++;

    const status = wouldQueue ? "✅ QUEUED " : "🚫 BLOCKED";
    const assertion = passed
      ? expectBlocked
        ? "✅ correctly blocked"
        : "✅ correctly queued"
      : expectBlocked
        ? "❌ SHOULD BE BLOCKED"
        : "❌ SHOULD BE QUEUED";

    const refireTag = sig.isRefire ? " [re-fire]" : "";
    console.log(`\n${sig.coin.padEnd(8)} ${sig.firedAt}${refireTag}`);
    console.log(`  ${status}  ${assertion}`);
    console.log(
      `  Funding:  ${sig.fundingApr.toFixed(0)}% APR        → Gate 1: ${g1 ? "✅" : "❌ fail (above threshold)"}`,
    );
    console.log(
      `  OI drop:  ${sig.oiDropPct.toFixed(1)}%  (≥ ${oiThreshold}%)  → Gate 2: ${g2 ? "✅" : `❌ blocked (OI rose ${Math.abs(sig.oiDropPct).toFixed(1)}%)`}`,
    );
    const pumpStr =
      sig.pumpTopHoursAgo !== null ? `${sig.pumpTopHoursAgo}h before` : "none";
    console.log(
      `  Pump top: ${pumpStr.padEnd(12)}           → Gate 3: ${g3 ? "✅" : `❌ within ${PUMP_TOP_COOLDOWN_H}h cooldown`}`,
    );
    console.log(`  Result:   ${sig.result}`);
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(
    `Queued:  ${queued}/${expectedQueued} expected-queued signals passed`,
  );
  console.log(
    `Blocked: ${actualBlocked}/${expectedBlocked} expected-blocked signals confirmed`,
  );

  if (failures > 0) {
    console.log(
      `\n❌ ${failures} assertion(s) failed — gate thresholds need review`,
    );
    process.exit(1);
  } else {
    console.log(`\n✅ All ${SIGNALS.length} assertions passed`);
  }
  console.log();
}

main();
