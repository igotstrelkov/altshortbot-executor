/**
 * simulate_gates.ts
 * =================
 * Verifies BUILDING queue gates correctly queue/block known signals.
 * No API calls, runs <1s, fully deterministic.
 *
 * Run before every deploy:  npx tsx simulate_gates.ts
 *
 * OI gate history:
 *   BUILDING_OI_RISING_MAX was REMOVED 2026-05-16 after backtest showed
 *   all 4 OI-gate-blocked signals were profitable:
 *     SOLV  May-12 (-182.9% OI, -447% APR)  → -14.53% PUMP+DUMP ✅
 *     SOLV  May-12 (-172.5% OI, -997% APR)  → -12.91% DROPPED   ✅
 *     IRYS  May-15 (-280%   OI, -1632% APR) → -13.01% PUMP+DUMP ✅
 *     STORJ May-16 (-433%   OI, -1596% APR) → -13.57% DROPPED   ✅
 *   The anchor signal ("SOLV blocked correctly") was in fact profitable.
 *   Only two gates remain: funding threshold + pump-top cooldown.
 */

import { FUNDING_THRESHOLD, PUMP_TOP_COOLDOWN_H } from "./live_scanner.ts";

const SIGNALS: Array<{
  coin: string;
  firedAt: string;
  fundingApr: number;
  oiDropPct: number; // kept for documentation — no longer gates
  pumpTopHoursAgo: number | null;
  isRefire?: boolean;
  result: string;
  expectBlocked?: boolean;
}> = [
  // May 10 batch — all queued, all profitable
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

  // SOLV May 12 — previously blocked by OI gate; backtest confirmed both profitable
  {
    coin: "SOLV",
    firedAt: "2026-05-12 12:00",
    fundingApr: -447.1,
    oiDropPct: -182.9,
    pumpTopHoursAgo: null,
    result: "PUMP+DUMP -14.53% (max +5.23% adverse — within 12% stop)",
  },
  {
    coin: "SOLV",
    firedAt: "2026-05-12 16:00",
    fundingApr: -996.8,
    oiDropPct: -172.5,
    pumpTopHoursAgo: null,
    isRefire: true,
    result: "DROPPED -12.91% (max +0.27% adverse — immediate reversal)",
  },

  // MBOX May 13
  {
    coin: "MBOX",
    firedAt: "2026-05-13 12:00",
    fundingApr: -1354.5,
    oiDropPct: -133.0,
    pumpTopHoursAgo: null,
    result: "DROPPED -19.23%",
  },

  // IRYS May 15 — previously blocked by OI gate (OI -280%)
  {
    coin: "IRYS",
    firedAt: "2026-05-15 16:00",
    fundingApr: -1631.6,
    oiDropPct: -280.0,
    pumpTopHoursAgo: null,
    result: "PUMP+DUMP -13.01% (max +8.45% adverse — within 12% stop)",
  },

  // STORJ May 16 — previously blocked by OI gate (OI -433%)
  {
    coin: "STORJ",
    firedAt: "2026-05-16 00:00",
    fundingApr: -1596.3,
    oiDropPct: -433.1,
    pumpTopHoursAgo: null,
    result: "DROPPED -13.57% (max 0% adverse — straight down)",
  },

  // Pump-top cooldown — PUMP_TOP_COOLDOWN_H is currently 0 (disabled),
  // so pump tops never block. Test confirms queued regardless of pump recency.
  {
    coin: "TEST_PUMP_RECENT",
    firedAt: "2026-05-01 12:00",
    fundingApr: -500.0,
    oiDropPct: 0.0,
    pumpTopHoursAgo: 1.0,
    result: "queued — pump-top cooldown is disabled (PUMP_TOP_COOLDOWN_H=0)",
  },
];

function applyGates(sig: (typeof SIGNALS)[0]): {
  g1: boolean;
  g2: boolean;
  wouldQueue: boolean;
} {
  const g1 = sig.fundingApr <= FUNDING_THRESHOLD;
  const g2 =
    sig.pumpTopHoursAgo === null || sig.pumpTopHoursAgo >= PUMP_TOP_COOLDOWN_H;
  return { g1, g2, wouldQueue: g1 && g2 };
}

function main() {
  console.log("\nGate Simulation — would these signals be queued?");
  console.log(
    `Thresholds: funding ≤ ${FUNDING_THRESHOLD}%  |  pump-top cooldown: ${PUMP_TOP_COOLDOWN_H}h`,
  );
  console.log(
    "OI gate: REMOVED — all historically-blocked signals were profitable",
  );
  console.log("═".repeat(78));

  let failures = 0;
  for (const sig of SIGNALS) {
    const { g1, g2, wouldQueue } = applyGates(sig);
    const expectBlocked = sig.expectBlocked === true;
    const passed = expectBlocked ? !wouldQueue : wouldQueue;
    if (!passed) failures++;

    const status = wouldQueue ? "✅ QUEUED " : "🚫 BLOCKED";
    const assertion = passed
      ? expectBlocked
        ? "✅ correctly blocked"
        : "✅ correctly queued"
      : expectBlocked
        ? "❌ SHOULD BE BLOCKED"
        : "❌ SHOULD BE QUEUED";
    const oiNote =
      sig.oiDropPct < -100
        ? ` [OI ${sig.oiDropPct.toFixed(1)}% — old gate would block]`
        : "";
    const refireTag = sig.isRefire ? " [re-fire]" : "";

    console.log(`\n${sig.coin.padEnd(16)} ${sig.firedAt}${refireTag}`);
    console.log(`  ${status}  ${assertion}`);
    console.log(
      `  Funding:  ${sig.fundingApr.toFixed(0)}% APR  → Gate 1: ${g1 ? "✅" : "❌ above threshold"}`,
    );
    console.log(
      `  Pump top: ${(sig.pumpTopHoursAgo !== null ? `${sig.pumpTopHoursAgo}h ago` : "none").padEnd(10)}  → Gate 2: ${g2 ? "✅" : `❌ within ${PUMP_TOP_COOLDOWN_H}h cooldown`}${oiNote}`,
    );
    console.log(`  Result:   ${sig.result}`);
  }

  console.log(`\n${"═".repeat(78)}`);
  if (failures > 0) {
    console.log(
      `\n❌ ${failures} assertion(s) failed — gate thresholds need review`,
    );
    process.exit(1);
  } else {
    console.log(`\n✅ All ${SIGNALS.length} assertions passed\n`);
  }
}

main();
