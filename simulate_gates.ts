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
    result: "+29.23% (210h)",
  },
  {
    coin: "XION",
    firedAt: "2026-05-10 05:12",
    fundingApr: -1446.3,
    oiDropPct: 0.0,
    pumpTopHoursAgo: 2.2,
    result: "+4.43% (205h) — pump top 2.2h before; cooldown disabled so queued",
  },
  {
    coin: "1000XEC",
    firedAt: "2026-05-10 09:12",
    fundingApr: -1338.0,
    oiDropPct: 0.0,
    pumpTopHoursAgo: 5.2,
    result: "+23.80% (201h)",
  },
  {
    coin: "SNT",
    firedAt: "2026-05-10 10:12",
    fundingApr: -2444.5,
    oiDropPct: 0.0,
    pumpTopHoursAgo: null,
    result: "+14.12% (200h)",
  },
  {
    coin: "SOLAYER",
    firedAt: "2026-05-10 13:12",
    fundingApr: -224.2,
    oiDropPct: -103.7,
    pumpTopHoursAgo: null,
    result: "+31.98% (197h)",
  },
  {
    coin: "WAL",
    firedAt: "2026-05-10 15:12",
    fundingApr: -741.5,
    oiDropPct: 0.0,
    pumpTopHoursAgo: null,
    result: "+21.15% (195h)",
  },

  // ── SOLV May 12 — OI gate previously blocked first fire, now both queue ───
  {
    coin: "SOLV",
    firedAt: "2026-05-12 12:00",
    fundingApr: -447.1,
    oiDropPct: -182.9,
    pumpTopHoursAgo: null,
    result:
      "stop-out — price pumped +5% before reversing (adverse excursion exceeded 12% stop)",
    expectBlocked: true,
  },
  {
    coin: "SOLV",
    firedAt: "2026-05-12 16:00",
    fundingApr: -996.8,
    oiDropPct: -172.5,
    pumpTopHoursAgo: null,
    isRefire: true,
    result: "DROPPED -6.25% (immediate reversal)",
  },
  {
    coin: "MBOX",
    firedAt: "2026-05-13 12:00",
    fundingApr: -1354.5,
    oiDropPct: -133.0,
    pumpTopHoursAgo: null,
    result: "+30%",
  },

  // ── May 14-15 live signals — all queued and profitable ────────────────────
  {
    coin: "MLN",
    firedAt: "2026-05-14 12:12",
    fundingApr: -764.0,
    oiDropPct: -34.4,
    pumpTopHoursAgo: null,
    result: "+26.04% (101h)",
  },
  {
    coin: "TAC",
    firedAt: "2026-05-14 20:12",
    fundingApr: -699.0,
    oiDropPct: -29.5,
    pumpTopHoursAgo: null,
    result: "+12.31% (93h)",
  },
  {
    coin: "AIGENSYN",
    firedAt: "2026-05-14 13:17",
    fundingApr: -465.0,
    oiDropPct: -138.0,
    pumpTopHoursAgo: null,
    result: "+14.38% (100h)",
  },
  {
    coin: "MLN",
    firedAt: "2026-05-15 04:12",
    fundingApr: -1209.0,
    oiDropPct: -34.4,
    pumpTopHoursAgo: null,
    result: "+26.04% (85h)",
  },
  {
    coin: "AIGENSYN",
    firedAt: "2026-05-15 08:07",
    fundingApr: -406.0,
    oiDropPct: -34.5,
    pumpTopHoursAgo: null,
    result: "+19.27% (81h)",
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
