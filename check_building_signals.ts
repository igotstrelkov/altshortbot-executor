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
  {
    coin: "WAL",
    firedAt: "2026-05-10T15:12:00Z",
    firedAtMs: new Date("2026-05-10T15:12:00Z").getTime(),
    entry: 0.0845,
    fundingApr: -741.5,
    squeeze: 20.2,
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

// ── Bybit hourly kline path (for realized stop/timeout modelling) ─────────────
interface OHLC {
  h: number;
  l: number;
  c: number;
}

async function fetchKlinePath(coin: string): Promise<Map<number, OHLC>> {
  const m = new Map<number, OHLC>();
  try {
    const res = await fetch(
      `${BB_BASE}/v5/market/kline?category=linear&symbol=${coin}USDT&interval=60&limit=1000`,
    );
    const data = (await res.json()) as { result?: { list?: string[][] } };
    for (const r of data?.result?.list ?? []) {
      // [start, open, high, low, close, volume, turnover]
      const hour = Math.floor(parseInt(r[0]) / 3_600_000) * 3_600_000;
      m.set(hour, {
        h: parseFloat(r[2]),
        l: parseFloat(r[3]),
        c: parseFloat(r[4]),
      });
    }
  } catch {
    /* empty → realized shows n/a */
  }
  return m;
}

// Fetch klines for all coins, ~10 at a time (one 1000-bar call covers ~41 days,
// enough for any signal's 24h window unless it fired >40 days ago).
async function fetchAllKlines(
  coins: string[],
): Promise<Map<string, Map<number, OHLC>>> {
  const out = new Map<string, Map<number, OHLC>>();
  const CHUNK = 10;
  for (let i = 0; i < coins.length; i += CHUNK) {
    const chunk = coins.slice(i, i + CHUNK);
    const res = await Promise.all(
      chunk.map(async (c) => [c, await fetchKlinePath(c)] as const),
    );
    for (const [c, p] of res) out.set(c, p);
  }
  return out;
}

// ── Realized outcome under the executor's rules (15% stop, 24h timeout) ───────
const STOP_PCT = 15;
const TIMEOUT_H = 24;

interface Realized {
  realizedPct: number; // P&L modelling the stop + timeout (1x, %)
  exit: "stop" | "timeout" | "open";
  maePct: number; // peak adverse (price up = bad for short) over the window
  mfePct: number; // peak favorable (price down = good) over the window
  holdH: number; // hours held to stop / timeout / now
  estFundingPct: number; // est funding drag over the hold (%, negative = paid)
  netPct: number; // realized + funding (1x, %)
}

function realizedOutcome(
  entry: number,
  firedAtMs: number,
  fundingApr: number,
  path: Map<number, OHLC>,
  nowMs: number,
): Realized | null {
  const stopPx = entry * (1 + STOP_PCT / 100);
  const ageH = (nowMs - firedAtMs) / 3_600_000;
  const endMs = Math.min(firedAtMs + TIMEOUT_H * 3_600_000, nowMs);
  let maxHigh = entry,
    minLow = entry,
    lastClose = entry,
    have = false;
  let stopMs: number | null = null;
  const start = Math.floor(firedAtMs / 3_600_000) * 3_600_000;
  for (let t = start; t <= endMs; t += 3_600_000) {
    const o = path.get(t);
    if (!o) continue;
    have = true;
    if (o.h > maxHigh) maxHigh = o.h;
    if (o.l < minLow) minLow = o.l;
    lastClose = o.c;
    if (stopMs === null && o.h >= stopPx) stopMs = t;
  }
  if (!have) return null;
  const maePct = ((maxHigh - entry) / entry) * 100;
  const mfePct = ((entry - minLow) / entry) * 100;
  let realizedPct: number, exit: Realized["exit"], holdH: number;
  if (stopMs !== null) {
    realizedPct = -STOP_PCT;
    exit = "stop";
    holdH = (stopMs - firedAtMs) / 3_600_000;
  } else if (ageH >= TIMEOUT_H) {
    realizedPct = ((entry - lastClose) / entry) * 100;
    exit = "timeout";
    holdH = TIMEOUT_H;
  } else {
    realizedPct = ((entry - lastClose) / entry) * 100;
    exit = "open";
    holdH = ageH;
  }
  // est funding: signal funding held flat over the hold (rough — funding varies
  // and is clamped; the executor's fundingPaidUsdt is the exact figure).
  const estFundingPct = fundingApr * (holdH / 8760);
  return {
    realizedPct,
    exit,
    maePct,
    mfePct,
    holdH,
    estFundingPct,
    netPct: realizedPct + estFundingPct,
  };
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
  age: string,
  entry: string,
  real: string,
  real3x: string,
  net3x: string,
  mae: string,
  mfe: string,
  exit: string,
  funding: string,
  icon: string,
): string {
  return [
    pad(coin, 9),
    pad(age, 9, true),
    pad(entry, 10, true),
    pad(real, 9, true),
    pad(real3x, 9, true),
    pad(net3x, 9, true),
    pad(mae, 7, true),
    pad(mfe, 7, true),
    pad(exit, 8, true),
    pad(funding, 9, true),
    " " + icon,
  ].join(" ");
}

const HEADER = row(
  "Coin",
  "Age",
  "Entry",
  "Realized",
  "@3x",
  "Net@3x",
  "MAE",
  "MFE",
  "Exit",
  "Funding",
  "",
);
const DIVIDER = "─".repeat(HEADER.length);

// Per-signal record after realized modelling (null klines → no data).
interface Scored {
  sig: BuildingSignal;
  r: Realized | null;
  cooldownBlocked: boolean;
}

// Flag signals the 24h re-entry cooldown would block: a same-coin STOP closed
// within reentryCooldownH before this signal fired. Chronological over ALL
// signals so cross-section history is respected.
function markCooldown(scored: Scored[]): void {
  const COOLDOWN_H = 24;
  const lastStopMs = new Map<string, number>();
  const byTime = [...scored].sort(
    (a, b) => a.sig.firedAtMs - b.sig.firedAtMs,
  );
  for (const x of byTime) {
    const last = lastStopMs.get(x.sig.coin);
    if (last != null && x.sig.firedAtMs - last < COOLDOWN_H * 3_600_000) {
      x.cooldownBlocked = true;
    }
    if (x.r?.exit === "stop") {
      lastStopMs.set(x.sig.coin, x.sig.firedAtMs + x.r.holdH * 3_600_000);
    }
  }
}

function printSection(title: string, scored: Scored[]): void {
  console.log(`\n${title} (${scored.length})`);
  console.log(HEADER);
  console.log(DIVIDER);

  let nReal = 0,
    wins = 0,
    sumReal = 0,
    sumNet = 0,
    sumMae = 0,
    sumFund = 0,
    stops = 0,
    timeouts = 0,
    open = 0,
    blocked = 0;

  for (const { sig, r, cooldownBlocked } of scored) {
    const age = fmtAge(Date.now() - sig.firedAtMs);
    if (cooldownBlocked) blocked++;
    if (!r) {
      console.log(
        row(
          sig.coin,
          age,
          fmtPrice(sig.entry),
          "n/a",
          "n/a",
          "n/a",
          "n/a",
          "n/a",
          "no-data",
          sig.fundingApr.toFixed(0) + "%",
          "—",
        ),
      );
      continue;
    }
    nReal++;
    if (r.realizedPct > 0) wins++;
    sumReal += r.realizedPct;
    sumNet += r.netPct;
    sumMae += r.maePct;
    sumFund += r.estFundingPct;
    if (r.exit === "stop") stops++;
    else if (r.exit === "timeout") timeouts++;
    else open++;

    const icon =
      (r.realizedPct > 2 ? "✅" : r.realizedPct < -3 ? "❌" : "😐") +
      (cooldownBlocked ? "🔁" : "");
    console.log(
      row(
        sig.coin,
        age,
        fmtPrice(sig.entry),
        fmtPct(r.realizedPct),
        fmtPct(r.realizedPct * 3),
        fmtPct(r.netPct * 3),
        "+" + r.maePct.toFixed(1) + "%",
        "+" + r.mfePct.toFixed(1) + "%",
        r.exit,
        sig.fundingApr.toFixed(0) + "%",
        icon,
      ),
    );
  }

  if (nReal > 0) {
    console.log(DIVIDER);
    console.log(
      `  ${wins}/${nReal} win  |  realized avg ${fmtPct(sumReal / nReal)} ` +
        `(${fmtPct((sumReal / nReal) * 3)} @3x)  |  exits: ${stops} stop / ` +
        `${timeouts} timeout / ${open} open`,
    );
    console.log(
      `  avg MAE +${(sumMae / nReal).toFixed(1)}%  |  ` +
        `est funding drag ${fmtPct(sumFund / nReal)}  |  ` +
        `net avg ${fmtPct(sumNet / nReal)} (${fmtPct((sumNet / nReal) * 3)} @3x)` +
        (blocked ? `  |  ${blocked} cooldown-blocked 🔁` : ""),
    );
  }
}

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
  const toShow = SHOW_ALL
    ? signals
    : signals.filter((s) => now - s.firedAtMs < window);

  if (!toShow.length) {
    console.log(`No ${SHOW_ALL ? "" : `active (<${LOOKAHEAD_H}h) `}signals.`);
    return;
  }

  console.log(`\nStrategy B — BUILDING Signal Monitor (REALIZED)`);
  console.log(
    `${new Date().toISOString()}  |  window: ${LOOKAHEAD_H}h  |  ` +
      `model: ${STOP_PCT}% stop, ${TIMEOUT_H}h timeout (Bybit klines)`,
  );

  // Score EVERY signal (cooldown history needs the full timeline), then display.
  const coins = Array.from(new Set(signals.map((s) => s.coin)));
  const klines = await fetchAllKlines(coins);
  const scoredAll: Scored[] = signals.map((sig) => ({
    sig,
    r: realizedOutcome(
      sig.entry,
      sig.firedAtMs,
      sig.fundingApr,
      klines.get(sig.coin) ?? new Map(),
      now,
    ),
    cooldownBlocked: false,
  }));
  markCooldown(scoredAll);

  const active = scoredAll.filter((x) => now - x.sig.firedAtMs < window);
  const expired = scoredAll.filter((x) => now - x.sig.firedAtMs >= window);

  if (active.length) printSection("Active", active);
  if (SHOW_ALL && expired.length)
    printSection(`Expired (>${LOOKAHEAD_H}h)`, expired);

  console.log(
    `\n  Realized = modelled with the executor's stop + timeout (not raw ` +
      `entry→now). MAE = peak adverse, MFE = peak favorable. 'net' = realized + ` +
      `est funding. 🔁 = the 24h re-entry cooldown would skip it.`,
  );
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
