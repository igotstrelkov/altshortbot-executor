/**
 * check_building_signals.ts
 * ===========================
 * Reads BUILDING alerts from building_log.jsonl and shows live P&L.
 *
 * Usage:
 *   npx tsx check_building_signals.ts              — show active (< 48h)
 *   npx tsx check_building_signals.ts --all        — include expired
 *   npx tsx check_building_signals.ts --hours 72   — custom window
 *   npx tsx check_building_signals.ts --seed       — seed today's 5 signals
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";

const BB_BASE = "https://api.bybit.com";
const LOG_FILE = "building_log.jsonl";
const LOOKAHEAD_H =
  parseInt(
    process.argv.find((_, i) => process.argv[i - 1] === "--hours") ?? "48",
  ) || 48;
const SHOW_ALL = process.argv.includes("--all");
const SEED_MODE = process.argv.includes("--seed");

interface BuildingSignal {
  coin: string;
  firedAt: string;
  firedAtMs: number;
  entry: number;
  fundingApr: number;
  squeeze: number;
}

// ── Today's 5 signals (seed data) ────────────────────────────────────────────
const SEED_SIGNALS: BuildingSignal[] = [
  {
    coin: "RAVE",
    firedAt: "2026-05-10T00:12:00Z",
    firedAtMs: new Date("2026-05-10T00:12:00Z").getTime(),
    entry: 0.8076,
    fundingApr: -239.0,
    squeeze: 20.6,
  },
  {
    coin: "XION",
    firedAt: "2026-05-10T05:12:00Z",
    firedAtMs: new Date("2026-05-10T05:12:00Z").getTime(),
    entry: 0.1638,
    fundingApr: -1446.3,
    squeeze: 33.6,
  },
  {
    coin: "1000XEC",
    firedAt: "2026-05-10T09:12:00Z",
    firedAtMs: new Date("2026-05-10T09:12:00Z").getTime(),
    entry: 0.0095,
    fundingApr: -1338.0,
    squeeze: 36.8,
  },
  {
    coin: "SNT",
    firedAt: "2026-05-10T10:12:00Z",
    firedAtMs: new Date("2026-05-10T10:12:00Z").getTime(),
    entry: 0.0115,
    fundingApr: -2444.5,
    squeeze: 20.1,
  },
  {
    coin: "SOLAYER",
    firedAt: "2026-05-10T13:12:00Z",
    firedAtMs: new Date("2026-05-10T13:12:00Z").getTime(),
    entry: 0.13,
    fundingApr: -224.2,
    squeeze: 36.7,
  },
];

// ── Persistence helpers ───────────────────────────────────────────────────────
export function logBuildingSignal(sig: BuildingSignal): void {
  appendFileSync(LOG_FILE, JSON.stringify(sig) + "\n", "utf8");
}

function loadSignals(): BuildingSignal[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BuildingSignal);
}

// ── Bybit price fetch ─────────────────────────────────────────────────────────
async function fetchMarkPrices(coins: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(`${BB_BASE}/v5/market/tickers?category=linear`);
    const data = (await res.json()) as {
      result?: { list?: { symbol: string; lastPrice: string }[] };
    };
    for (const t of data?.result?.list ?? []) {
      const coin = t.symbol.replace("USDT", "");
      if (coins.includes(coin)) map.set(coin, parseFloat(t.lastPrice));
    }
  } catch (e) {
    console.error("  Price fetch failed:", (e as Error).message);
  }
  return map;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}
function fmtAge(ms: number): string {
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}
function fmtPrice(n: number): string {
  return "$" + (n < 0.01 ? n.toFixed(6) : n < 1 ? n.toFixed(4) : n.toFixed(3));
}

// ── Table row ─────────────────────────────────────────────────────────────────
function row(
  coin: string,
  time: string,
  age: string,
  entry: string,
  now: string,
  pnl: string,
  pnl3x: string,
  funding: string,
  icon: string,
): string {
  return [
    pad(coin, 10),
    pad(time, 9, true),
    pad(age, 10, true),
    pad(entry, 10, true),
    pad(now, 10, true),
    pad(pnl, 9, true),
    pad(pnl3x, 9, true),
    pad(funding, 12, true),
    " " + icon,
  ].join(" ");
}

const HEADER = row(
  "Coin",
  "Fired",
  "Age",
  "Entry",
  "Now",
  "P&L",
  "At 3x",
  "Funding",
  "",
);
const DIVIDER = "─".repeat(HEADER.length);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Seed mode
  if (SEED_MODE) {
    if (existsSync(LOG_FILE)) {
      console.log(`${LOG_FILE} already exists. Remove it first to re-seed.`);
      return;
    }
    writeFileSync(
      LOG_FILE,
      SEED_SIGNALS.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );
    console.log(`Seeded ${SEED_SIGNALS.length} signals to ${LOG_FILE}`);
    return;
  }

  let signals = loadSignals();
  if (!signals.length) {
    console.log(`No ${LOG_FILE} found — using today's 5 seeded signals.\n`);
    signals = SEED_SIGNALS;
  }

  const now = Date.now();
  const window = LOOKAHEAD_H * 3_600_000;

  const active = signals.filter((s) => now - s.firedAtMs < window);
  const expired = signals.filter((s) => now - s.firedAtMs >= window);
  const toShow = SHOW_ALL ? signals : active;

  if (!toShow.length) {
    console.log(`No ${SHOW_ALL ? "" : `active (<${LOOKAHEAD_H}h) `}signals.`);
    return;
  }

  const coins = Array.from(new Set(toShow.map((s) => s.coin)));
  const markPrices = await fetchMarkPrices(coins);

  console.log(`\nStrategy B — BUILDING Signal Monitor`);
  console.log(
    `${new Date().toISOString()}  |  window: ${LOOKAHEAD_H}h  |  prices: Bybit`,
  );

  // Active
  if (active.length) {
    console.log(`\nActive (${active.length})`);
    console.log(HEADER);
    console.log(DIVIDER);

    let totalPnl = 0,
      wins = 0,
      confirmed = 0;

    for (const s of active) {
      const age = fmtAge(now - s.firedAtMs);
      const time = s.firedAt.slice(11, 16) + "Z";
      const current = markPrices.get(s.coin);

      if (!current) {
        console.log(
          row(
            s.coin,
            time,
            age,
            fmtPrice(s.entry),
            "n/a",
            "?",
            "?",
            s.fundingApr.toFixed(0) + "%",
            "⏳",
          ),
        );
        continue;
      }

      confirmed++;
      const pnl = ((s.entry - current) / s.entry) * 100;
      const pnl3x = pnl * 3;
      const icon = pnl > 2 ? "✅" : pnl < -3 ? "❌" : "😐";
      if (pnl > 0) wins++;
      totalPnl += pnl;

      console.log(
        row(
          s.coin,
          time,
          age,
          fmtPrice(s.entry),
          fmtPrice(current),
          fmtPct(pnl),
          fmtPct(pnl3x),
          s.fundingApr.toFixed(0) + "%",
          icon,
        ),
      );
    }

    if (confirmed > 0) {
      console.log(DIVIDER);
      const avg = totalPnl / confirmed;
      console.log(
        `  ${wins}/${confirmed} winning` +
          `  |  avg: ${fmtPct(avg)}` +
          `  |  avg at 3x: ${fmtPct(avg * 3)}`,
      );
    }
  }

  // Expired
  if (SHOW_ALL && expired.length) {
    console.log(`\nExpired (>${LOOKAHEAD_H}h) — ${expired.length}`);
    console.log(HEADER);
    console.log(DIVIDER);

    let totalPnl = 0,
      wins = 0,
      confirmed = 0;
    for (const s of expired) {
      const age = fmtAge(now - s.firedAtMs);
      const time = s.firedAt.slice(11, 16) + "Z";
      const current = markPrices.get(s.coin);
      if (!current) {
        console.log(
          row(
            s.coin,
            time,
            age,
            fmtPrice(s.entry),
            "n/a",
            "?",
            "?",
            s.fundingApr.toFixed(0) + "%",
            "—",
          ),
        );
        continue;
      }
      confirmed++;
      const pnl = ((s.entry - current) / s.entry) * 100;
      const pnl3x = pnl * 3;
      if (pnl > 0) wins++;
      totalPnl += pnl;
      console.log(
        row(
          s.coin,
          time,
          age,
          fmtPrice(s.entry),
          fmtPrice(current),
          fmtPct(pnl),
          fmtPct(pnl3x),
          s.fundingApr.toFixed(0) + "%",
          pnl > 0 ? "✅" : "❌",
        ),
      );
    }
    if (confirmed > 0) {
      console.log(DIVIDER);
      const avg = totalPnl / confirmed;
      console.log(
        `  ${wins}/${confirmed} winning  |  avg: ${fmtPct(avg)}  |  avg at 3x: ${fmtPct(avg * 3)}`,
      );
    }
  }

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
