/**
 * simulate_gates.ts
 * =================
 * Runs the backtest for a set of known signals and checks whether
 * each one would be queued or blocked by the current set of gates:
 *
 *   Gate 1: fundingApr <= -200%
 *   Gate 2: oiDropPct  >= -50%    (OI not rising strongly)
 *   Gate 3: no PUMP_TOP in prior 12h  (squeeze not still accelerating)
 *
 * Usage:
 *   npx tsx simulate_gates.ts
 *   npx tsx simulate_gates.ts --days 30   ← wider window if signals are older
 */

import { spawnSync } from "child_process";
import {
  FUNDING_THRESHOLD,
  BUILDING_OI_RISING_MAX as OI_RISING_MAX,
  BUILDING_OI_RISING_MAX_REFIRE as OI_RISING_MAX_REFIRE,
  PUMP_TOP_COOLDOWN_H,
} from "./live_scanner.ts";

// ── Signals to test ───────────────────────────────────────────────────────────
// Add any signal here to test it against all current gates.
// expectBlocked: true  → simulation fails if this signal is NOT blocked (known-bad case)
// expectBlocked: false → simulation fails if this signal IS blocked (known-good case, default)
const SIGNALS: Array<{
  coin: string;
  firedAt: string;
  entry: number;
  fundingApr: number;
  result: string;
  expectBlocked?: boolean;
  isRefire?: boolean;
}> = [
  {
    coin: "RAVE",
    firedAt: "2026-05-10 00:12",
    entry: 0.8076,
    fundingApr: -239.0,
    result: "+15.07%",
  },
  {
    coin: "XION",
    firedAt: "2026-05-10 05:12",
    entry: 0.1638,
    fundingApr: -1446.3,
    result: "+9.30%",
  },
  {
    coin: "1000XEC",
    firedAt: "2026-05-10 09:12",
    entry: 0.0095,
    fundingApr: -1338.0,
    result: "+13.79%",
  },
  {
    coin: "SNT",
    firedAt: "2026-05-10 10:12",
    entry: 0.0115,
    fundingApr: -2444.5,
    result: "+10.09%",
  },
  {
    coin: "SOLAYER",
    firedAt: "2026-05-10 13:12",
    entry: 0.13,
    fundingApr: -224.2,
    result: "+16.86%",
  },
  {
    coin: "WAL",
    firedAt: "2026-05-10 15:12",
    entry: 0.0845,
    fundingApr: -741.5,
    result: "+1.36%",
  },
  // Known-bad: SOLV May 12 12:00 — first fire, OI rising -182.9% → blocked
  {
    coin: "SOLV",
    firedAt: "2026-05-12 12:00",
    entry: 0.005578,
    fundingApr: -447.1,
    result: "PUMP+DUMP (OI gate)",
    expectBlocked: true,
  },
  // Known-good: SOLV May 12 16:00 — re-fire at -997% APR (2× of -447%), OI -172.5%
  //   → max +0.27%, final -6.25% DROPPED — immediate clean reversal
  //   → permissive -200% OI threshold for re-fires should QUEUE this
  {
    coin: "SOLV",
    firedAt: "2026-05-12 16:00",
    entry: 0.005578,
    fundingApr: -996.8,
    result: "DROPPED -6.25%",
    expectBlocked: false,
    isRefire: true,
  },
];

const DAYS =
  parseInt(
    process.argv.find((_, i) => process.argv[i - 1] === "--days") ?? "10",
  ) || 10;

const BACKTEST_ARGS = [
  "--days",
  String(DAYS),
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
  "--lookahead",
  "48",
];

// ── Backtest runner ───────────────────────────────────────────────────────────
function runBacktest(coin: string): string {
  const result = spawnSync(
    "npx",
    ["tsx", "backtest_signals.ts", "--coin", coin, ...BACKTEST_ARGS],
    { encoding: "utf8", timeout: 120_000, shell: true },
  );
  return result.stdout ?? "";
}

// ── Parsers ───────────────────────────────────────────────────────────────────
function parseOiDropPct(output: string, signalDate: string): number {
  // Match: "2026-05-10 00:12  BUILDING — +20.6%(10h)  OI--182.9%  funding:-239.0%APR"
  const datePrefix = signalDate.slice(0, 13); // "2026-05-10 00"
  for (const line of output.split("\n")) {
    if (line.includes("BUILDING") && line.includes(datePrefix)) {
      const m = line.match(/OI-(-?[\d.]+)%/);
      if (m) return parseFloat(m[1]);
    }
  }
  return 0; // no OI data = flat = passes gate
}

function parsePumpTopsBefore(output: string, signalDate: string): string[] {
  // Returns pump top timestamps fired before signalDate within PUMP_TOP_COOLDOWN_H
  const signalMs = new Date(signalDate.replace(" ", "T") + ":00Z").getTime();
  const pumps: string[] = [];
  for (const line of output.split("\n")) {
    // Match pump top lines: "  ✅ 2026-04-08 15:00  entry=... pump+XX%"
    const m = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+entry=.*pump\+/);
    if (m) {
      const pumpMs = new Date(m[1].replace(" ", "T") + ":00Z").getTime();
      const diffH = (signalMs - pumpMs) / 3_600_000;
      if (diffH > 0 && diffH < PUMP_TOP_COOLDOWN_H) {
        pumps.push(`${m[1]} (${diffH.toFixed(1)}h before)`);
      }
    }
  }
  return pumps;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\nGate Simulation — would these signals be queued today?");
  console.log(
    `Gates: funding ≤ ${FUNDING_THRESHOLD}%  |  OI ≥ ${OI_RISING_MAX}%  |  no pump top in prior ${PUMP_TOP_COOLDOWN_H}h`,
  );
  console.log("═".repeat(80));

  let queued = 0,
    failures = 0;

  for (const sig of SIGNALS) {
    process.stdout.write(`\n${sig.coin.padEnd(8)} (${sig.firedAt})... `);
    const output = runBacktest(sig.coin);
    console.log("done");

    const oiDropPct = parseOiDropPct(output, sig.firedAt);
    const recentPumpTops = parsePumpTopsBefore(output, sig.firedAt);

    // Apply gates
    const g1_funding = sig.fundingApr <= FUNDING_THRESHOLD;
    const oiThreshold = sig.isRefire ? OI_RISING_MAX_REFIRE : OI_RISING_MAX;
    const g2_oi = oiDropPct >= oiThreshold;
    const g3_noPump = recentPumpTops.length === 0;
    const wouldQueue = g1_funding && g2_oi && g3_noPump;

    if (wouldQueue) queued++;

    const expectBlocked = sig.expectBlocked === true;
    const passed = expectBlocked ? !wouldQueue : wouldQueue;
    const status = wouldQueue ? "✅ QUEUED" : "🚫 BLOCKED";
    const assertion = passed
      ? expectBlocked
        ? "✅ correctly blocked"
        : "✅ correctly queued"
      : expectBlocked
        ? "❌ SHOULD BE BLOCKED — gate not firing!"
        : "❌ SHOULD BE QUEUED — gate too aggressive!";
    if (!passed) failures++;

    console.log(`  ${status}  ${assertion}`);
    console.log(
      `  expected: ${expectBlocked ? "BLOCKED" : "QUEUED"}  |  actual result: ${sig.result}`,
    );
    console.log(
      `  Funding: ${sig.fundingApr.toFixed(0)}% APR  → Gate 1: ${g1_funding ? "✅ pass" : "❌ fail"}`,
    );
    console.log(
      `  OI drop: ${oiDropPct.toFixed(1)}%  (threshold: ${oiThreshold}%)  → Gate 2: ${g2_oi ? "✅ pass" : `❌ blocked (OI rose ${Math.abs(oiDropPct).toFixed(1)}%)`}`,
    );
    console.log(
      `  Pump tops in prior 12h: ${recentPumpTops.length === 0 ? "none" : recentPumpTops.join(", ")}  → Gate 3: ${g3_noPump ? "✅ pass" : "❌ blocked"}`,
    );
  }

  console.log(`\n${"═".repeat(80)}`);
  const expectedQueued = SIGNALS.filter((s) => !s.expectBlocked).length;
  const expectedBlocked = SIGNALS.filter((s) => s.expectBlocked).length;
  const actualBlocked = SIGNALS.length - queued;
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
    console.log(`\n✅ All assertions passed`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
