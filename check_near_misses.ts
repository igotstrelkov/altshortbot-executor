/**
 * check_near_misses.ts
 * ====================
 * Shows coins that approached the squeeze threshold (≥15% cumulative)
 * but didn't quite trigger (< 20%). These are potential signals that
 * 15-minute candles might catch earlier.
 *
 * Usage:
 *   npx tsx check_near_misses.ts           ← last 24h
 *   npx tsx check_near_misses.ts --days 7  ← last 7 days
 *   npx tsx check_near_misses.ts --all     ← all time
 */

import { existsSync, readFileSync } from "fs";

const NEAR_MISS_FILE = "near_miss.jsonl";
const SQUEEZE_TRIGGER = 20; // PARAMS.squeezeMinPct
const HOUR = 3_600_000;

interface NearMiss {
  coin: string;
  ts: string;
  cumulativePct: number;
  fundingApr: number;
  price: number;
}

// ── Args ─────────────────────────────────────────────────────────────────────
const SHOW_ALL = process.argv.includes("--all");
const daysArg = process.argv.find((_, i) => process.argv[i - 1] === "--days");
const DAYS = daysArg ? parseInt(daysArg) : 1;
const windowMs = SHOW_ALL ? Infinity : DAYS * 24 * HOUR;

// ── Load ──────────────────────────────────────────────────────────────────────
if (!existsSync(NEAR_MISS_FILE)) {
  console.log(`\nNo ${NEAR_MISS_FILE} found — scanner hasn't run yet.\n`);
  process.exit(0);
}

const raw: NearMiss[] = readFileSync(NEAR_MISS_FILE, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const cutoff = Date.now() - windowMs;
const entries = raw.filter((e) => new Date(e.ts).getTime() >= cutoff);

// ── Group by coin — keep highest cumulativePct seen ─────────────────────────
const byCoind = new Map<
  string,
  { max: number; count: number; last: NearMiss }
>();
for (const e of entries) {
  const existing = byCoind.get(e.coin);
  if (!existing || e.cumulativePct > existing.max) {
    byCoind.set(e.coin, {
      max: existing ? Math.max(existing.max, e.cumulativePct) : e.cumulativePct,
      count: (existing?.count ?? 0) + 1,
      last: e,
    });
  } else {
    existing.count++;
  }
}

// ── Sort by peak cumulative % desc ───────────────────────────────────────────
const sorted = [...byCoind.entries()].sort((a, b) => b[1].max - a[1].max);

console.log(`\nNear-Miss Report — ${SHOW_ALL ? "all time" : `last ${DAYS}d`}`);
console.log(
  `Squeeze threshold: ${SQUEEZE_TRIGGER}%  |  Near-miss range: 15–${SQUEEZE_TRIGGER - 1}%`,
);
console.log(`${entries.length} events across ${sorted.length} coins\n`);

if (sorted.length === 0) {
  console.log("  No near-misses in this window.\n");
  process.exit(0);
}

const hdr = `${"Coin".padEnd(12)} ${"Peak".padStart(7)} ${"Gap to trigger".padStart(15)} ${"Scans".padStart(6)}  Last seen`;
console.log(hdr);
console.log("─".repeat(hdr.length));

for (const [coin, data] of sorted) {
  const gapToTrigger = Math.max(0, SQUEEZE_TRIGGER - data.max); // clamp: peak may exceed threshold
  const bar =
    "█".repeat(Math.round(data.max / 2)) +
    "░".repeat(Math.round(gapToTrigger / 2));
  const lastSeen = data.last.ts.slice(0, 16).replace("T", " ");
  console.log(
    `${coin.padEnd(12)} ${(data.max.toFixed(1) + "%").padStart(7)} ` +
      `${("+" + gapToTrigger.toFixed(1) + "% needed").padStart(15)} ` +
      `${String(data.count).padStart(6)}  ${lastSeen} UTC`,
  );
}

console.log(
  `\nThese coins almost triggered but didn't reach ${SQUEEZE_TRIGGER}%.`,
);
console.log(
  `If you see the same coins repeatedly, 15m candles may catch them earlier.\n`,
);
