/**
 * test.ts — pre-deploy regression suite
 * =======================================
 * Runs all deterministic tests in order. Exits non-zero on first failure.
 *
 *   npx tsx test.ts              ← scanner + gates (fast, run before every deploy)
 *   npx tsx test.ts --all        ← + backtest_test (slow, run when changing params)
 */

import { execSync } from "child_process";

const ALL = process.argv.includes("--all");

const tests = [
  { file: "scanner_test.ts", desc: "Live scanner regression (fixtures)" },
  { file: "simulate_gates.ts", desc: "Gate threshold assertions" },
  ...(ALL
    ? [
        {
          file: "backtest_test.ts",
          desc: "Backtest signal regression (fixtures)",
        },
      ]
    : []),
];

console.log(`\nAltShortBot — pre-deploy test suite${ALL ? " (full)" : ""}`);
console.log("═".repeat(50));

const start = Date.now();
let passed = 0;

for (const t of tests) {
  process.stdout.write(`\n  ${t.desc}...\n`);
  try {
    execSync(`npx tsx ${t.file}`, { stdio: "inherit" });
    passed++;
  } catch {
    console.error(`\n❌ ${t.file} failed — aborting`);
    process.exit(1);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n${"═".repeat(50)}`);
console.log(`✅ ${passed}/${tests.length} test suites passed in ${elapsed}s`);
if (!ALL) console.log(`   (run with --all to include backtest_test.ts)`);
console.log();
