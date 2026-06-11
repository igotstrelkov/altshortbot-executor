/**
 * test_hold_to_profit.ts
 * ======================
 * Tests "hold until profitable (or stopped), no 24h timeout" against the live
 * 24h-timeout policy, on the queued BUILDING signals in universe_result.json.
 *
 * For each signal it fetches the forward hourly price path from Bybit and models
 * both policies with the executor's real rules (15% stop = -1R, capped funding
 * cost) plus 5-slot concurrency — so the slot-clogging / throughput effect of
 * holding longer is captured, not just per-trade P&L.
 *
 *   Policy A (live):  exit at the 15% stop OR at 24h, whichever first.
 *   Policy B (hold):  exit at the 15% stop anytime; else keep a winner at 24h;
 *                     else (underwater at 24h) HOLD until price returns to
 *                     break-even (~0R) or the stop (-1R); else still open at the
 *                     window end (slot locked the whole time).
 *
 * Coverage: limited to signals whose forward window fits in ~41 days of hourly
 * klines (1000-bar Bybit limit). Reports the covered sample size.
 *
 *   npx tsx test_hold_to_profit.ts
 */

import { existsSync, readFileSync } from "fs";

const BB_BASE = "https://api.bybit.com";
const RESULT_FILE = "universe_result.json";
const STOP_PCT = 15; // 1R adverse move
const RISK = 0.05; // riskPerTrade (KuCoin live)
const MAX_POS = 5; // KuCoin maxPositions
const START = 10_000;
const HOLD_CAP_H = 30 * 24; // model "indefinite" as up to 30 days
const TIMEOUT_H = 24;
const FUNDING_CAP_8H = 0.02; // realistic settlement clamp
const SETTLE_YR = 365 * 3;

interface QD {
  firedAt: string;
  type: string;
  entry: number;
  fundingApr: number;
}
interface Sig {
  coin: string;
  firedAtMs: number;
  entry: number;
  fundingApr: number;
}
interface OHLC {
  h: number;
  l: number;
  c: number;
}

function parseMs(s: string): number {
  return new Date(s.replace(" ", "T") + ":00Z").getTime();
}

function loadSignals(): Sig[] {
  const data = JSON.parse(readFileSync(RESULT_FILE, "utf8")) as {
    coins: { coin: string; queued?: { signals_detail: QD[] } }[];
  };
  const out: Sig[] = [];
  for (const c of data.coins)
    for (const d of c.queued?.signals_detail ?? [])
      if (d.type === "BUILDING")
        out.push({
          coin: c.coin,
          firedAtMs: parseMs(d.firedAt),
          entry: d.entry,
          fundingApr: d.fundingApr,
        });
  return out.sort((a, b) => a.firedAtMs - b.firedAtMs);
}

async function fetchKlines(coin: string): Promise<Map<number, OHLC>> {
  const m = new Map<number, OHLC>();
  try {
    const res = await fetch(
      `${BB_BASE}/v5/market/kline?category=linear&symbol=${coin}USDT&interval=60&limit=1000`,
    );
    const data = (await res.json()) as { result?: { list?: string[][] } };
    for (const r of data?.result?.list ?? []) {
      const hour = Math.floor(parseInt(r[0]) / 3_600_000) * 3_600_000;
      m.set(hour, {
        h: parseFloat(r[2]),
        l: parseFloat(r[3]),
        c: parseFloat(r[4]),
      });
    }
  } catch {
    /* empty */
  }
  return m;
}

async function fetchAll(coins: string[]): Promise<Map<string, Map<number, OHLC>>> {
  const out = new Map<string, Map<number, OHLC>>();
  for (let i = 0; i < coins.length; i += 10) {
    const chunk = coins.slice(i, i + 10);
    const res = await Promise.all(
      chunk.map(async (c) => [c, await fetchKlines(c)] as const),
    );
    for (const [c, p] of res) out.set(c, p);
  }
  return out;
}

function estFundingR(fundingApr: number, holdH: number): number {
  const per8h = Math.max(
    -FUNDING_CAP_8H,
    Math.min(FUNDING_CAP_8H, fundingApr / 100 / SETTLE_YR),
  );
  const fundingPct = per8h * (holdH / 8) * 100;
  return fundingPct / STOP_PCT; // express as R (1R = STOP_PCT% of notional)
}

interface Outcome {
  priceR: number; // R from price (before funding)
  holdH: number; // hours the slot is occupied
}

// Walk the path from entry; return per-policy outcome. null if no kline coverage.
function outcomes(
  sig: Sig,
  path: Map<number, OHLC>,
  nowMs: number,
): { A: Outcome; B: Outcome } | null {
  const stopPx = sig.entry * (1 + STOP_PCT / 100);
  const start = Math.floor(sig.firedAtMs / 3_600_000) * 3_600_000;
  const horizon = Math.min(
    sig.firedAtMs + HOLD_CAP_H * 3_600_000,
    nowMs,
  );
  let have = false;
  let stopH: number | null = null;
  let px24: number | null = null;
  let breakevenAfter24H: number | null = null;
  let lastClose = sig.entry;
  let windowH = 0;
  for (let t = start; t <= horizon; t += 3_600_000) {
    const o = path.get(t);
    if (!o) continue;
    have = true;
    const h = (t - sig.firedAtMs) / 3_600_000;
    windowH = h;
    lastClose = o.c;
    if (stopH === null && o.h >= stopPx) stopH = h;
    if (px24 === null && h >= TIMEOUT_H) px24 = o.c;
    if (h > TIMEOUT_H && breakevenAfter24H === null && o.l <= sig.entry)
      breakevenAfter24H = h;
  }
  if (!have) return null;

  // ── Policy A: stop OR 24h timeout ──────────────────────────────────────────
  let A: Outcome;
  if (stopH !== null && stopH <= TIMEOUT_H) {
    A = { priceR: -1, holdH: stopH };
  } else {
    const px = px24 ?? lastClose;
    A = { priceR: ((sig.entry - px) / sig.entry / (STOP_PCT / 100)), holdH: Math.min(TIMEOUT_H, windowH) };
  }

  // ── Policy B: stop anytime; keep winner@24h; else hold to breakeven/stop ───
  let B: Outcome;
  const pnl24R = px24 != null ? (sig.entry - px24) / sig.entry / (STOP_PCT / 100) : null;
  if (stopH !== null && stopH <= TIMEOUT_H) {
    B = { priceR: -1, holdH: stopH }; // stopped within 24h — same as A
  } else if (pnl24R != null && pnl24R > 0) {
    B = { priceR: pnl24R, holdH: TIMEOUT_H }; // winner — close at 24h
  } else {
    // underwater at 24h (or no 24h mark): hold until break-even or stop
    const beH = breakevenAfter24H;
    if (stopH !== null && (beH === null || stopH < beH)) {
      B = { priceR: -1, holdH: stopH }; // eventually stopped
    } else if (beH !== null) {
      B = { priceR: 0, holdH: beH }; // recovered to break-even (~0R)
    } else {
      // never recovered, never stopped within the window — still open
      B = {
        priceR: (sig.entry - lastClose) / sig.entry / (STOP_PCT / 100),
        holdH: windowH,
      };
    }
  }
  return { A, B };
}

interface SimRes {
  finalEq: number;
  retPct: number;
  maxDD: number;
  taken: number;
  skipped: number;
  wins: number;
  avgHoldH: number;
}

// Concurrency sim: chronological, MAX_POS slots, compounding, with funding.
function sim(
  rows: { sig: Sig; o: Outcome }[],
  withFunding: boolean,
): SimRes {
  let eq = START,
    peak = START,
    maxDD = 0,
    taken = 0,
    skipped = 0,
    wins = 0,
    sumHold = 0;
  const open: { closeMs: number; r: number; risk: number }[] = [];
  const resolve = (upTo: number) => {
    open.sort((a, b) => a.closeMs - b.closeMs);
    while (open.length && open[0].closeMs <= upTo) {
      const p = open.shift()!;
      eq += p.r * p.risk;
      if (p.r > 0) wins++;
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, ((peak - eq) / peak) * 100);
    }
  };
  for (const { sig: s, o } of rows) {
    resolve(s.firedAtMs);
    if (open.length >= MAX_POS) {
      skipped++;
      continue;
    }
    const fundingR = withFunding ? estFundingR(s.fundingApr, o.holdH) : 0;
    const r = o.priceR + fundingR;
    open.push({
      closeMs: s.firedAtMs + o.holdH * 3_600_000,
      r,
      risk: eq * RISK,
    });
    taken++;
    sumHold += o.holdH;
  }
  resolve(Infinity);
  return {
    finalEq: eq,
    retPct: ((eq - START) / START) * 100,
    maxDD,
    taken,
    skipped,
    wins,
    avgHoldH: taken ? sumHold / taken : 0,
  };
}

function fmt(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}
function line(label: string, r: SimRes): string {
  return (
    `  ${label.padEnd(22)} ${("$" + Math.round(r.finalEq).toLocaleString()).padStart(11)} ` +
    `${fmt(r.retPct).padStart(10)} ${("-" + r.maxDD.toFixed(1) + "%").padStart(8)} ` +
    `${String(r.taken).padStart(6)} ${String(r.skipped).padStart(6)} ` +
    `${(r.avgHoldH.toFixed(0) + "h").padStart(7)} ` +
    `${((100 * r.wins) / Math.max(1, r.taken)).toFixed(0).padStart(6)}%`
  );
}

async function main() {
  if (!existsSync(RESULT_FILE)) {
    console.error(`${RESULT_FILE} not found — run run_universe_backtest.ts first.`);
    process.exit(1);
  }
  const all = loadSignals();
  const now = Date.now();
  const coins = Array.from(new Set(all.map((s) => s.coin)));
  console.log(
    `Loading klines for ${coins.length} coins (${all.length} BUILDING signals)...`,
  );
  const klines = await fetchAll(coins);

  const A: { sig: Sig; o: Outcome }[] = [];
  const B: { sig: Sig; o: Outcome }[] = [];
  let covered = 0;
  for (const s of all) {
    const o = outcomes(s, klines.get(s.coin) ?? new Map(), now);
    if (!o) continue;
    covered++;
    A.push({ sig: s, o: o.A });
    B.push({ sig: s, o: o.B });
  }

  console.log(
    `\nHold-to-profit test — ${covered}/${all.length} signals with kline coverage`,
  );
  console.log(
    `Model: 15% stop, riskPerTrade ${(RISK * 100).toFixed(0)}%, maxPositions ${MAX_POS}, ` +
      `hold cap ${HOLD_CAP_H / 24}d, funding capped ${FUNDING_CAP_8H * 100}%/8h`,
  );
  console.log("─".repeat(82));
  console.log(
    `  ${"policy".padEnd(22)} ${"FinalEq".padStart(11)} ${"Return".padStart(10)} ` +
      `${"MaxDD".padStart(8)} ${"Taken".padStart(6)} ${"Skip".padStart(6)} ${"avgHold".padStart(7)} ${"Win".padStart(7)}`,
  );
  console.log("─".repeat(82));
  console.log(line("A: 24h timeout", sim(A, false)));
  console.log(line("A: 24h + funding", sim(A, true)));
  console.log(line("B: hold-to-profit", sim(B, false)));
  console.log(line("B: hold + funding", sim(B, true)));
  console.log("─".repeat(82));
  console.log(
    `\n  'Skip' = signals dropped because all ${MAX_POS} slots were full — the\n` +
      `  throughput cost of holding longer. 'avgHold' = mean slot-occupancy hours.\n` +
      `  Policy B keeps winners at 24h but holds losers to break-even/stop.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
