/**
 * analyze_funding.ts — funding-adjusted P&L by signal type.
 *
 * The live executor reports a trade's R-multiple from PRICE ONLY; funding is
 * fetched at close and shown as a separate diagnostic note, never folded into
 * `pnlUsdc` / `rMultiple` or the equity update (see kucoin_executor.ts
 * managePositions). For BUILDING shorts — selected precisely for extreme
 * negative funding, where shorts PAY — that carry is a first-order cost, not
 * noise. This tool re-fetches the real funding paid per closed trade and
 * recomputes R = priceR + fundingR, then aggregates by signal type so the
 * `-180%` floor and EXHAUSTION-suspension calls can be judged on the cost the
 * backtest does not model.
 *
 * Ground truth: funding comes from KuCoin getFundingHistory (the same call the
 * executor makes at close), so it reflects actual account funding, not an
 * estimate. Paper trades held no real position, so their windows return ~0
 * funding and fold into the price-only picture.
 *
 * Run (needs the live store + read-only KuCoin keys in env):
 *   set -a; source .env; set +a
 *   npx tsx analyze_funding.ts                 # all closed trades
 *   npx tsx analyze_funding.ts --days 30       # closed in the last 30 days
 *   npx tsx analyze_funding.ts --verbose       # + per-trade table
 *   npx tsx analyze_funding.ts --file kucoin_positions.json
 */

import { existsSync, readFileSync } from "fs";
import { FuturesClient } from "kucoin-api";
import type { PaperTrade } from "./shared_types.ts";

// ─── Must match kucoin_executor.ts RISK ─────────────────────────────────────────
const STOP_LOSS_PCT = 0.15; // 1R = stopLossPct × notional
const KC_OK = "200000";

// check_building_signals.ts caps modeled funding at this rate per 8h settlement
// (FUNDING_CAP_PER_8H = 0.02). This tool measures the REALIZED rate so the cap
// can be validated: if realized |rate| routinely exceeds it, the cap under-states.
const CAP_PER_8H_PCT = 2.0;

// ─── CLI ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const flagVal = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DAYS = flagVal("--days") ? parseFloat(flagVal("--days")!) : null;
const FILE = flagVal("--file") ?? "kucoin_positions.json";
// --refetch: estimate funding for trades that lack a stored fundingPaidUsdt by
// summing KuCoin funding-history over the trade window. OFF by default — that
// path does NOT filter historical windows reliably (it returns the same recent
// total per symbol), so re-fetched values are untrustworthy. Trades closed since
// the executor started persisting fundingPaidUsdt are exact and used regardless.
const REFETCH = argv.includes("--refetch");

// ─── KuCoin client (only needed for --refetch) ──────────────────────────────────
const KEY = process.env.KUCOIN_API_KEY ?? "";
const SECRET = process.env.KUCOIN_API_SECRET ?? "";
const PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE ?? "";
if (REFETCH && (!KEY || !SECRET || !PASSPHRASE)) {
  console.error(
    "--refetch needs KuCoin creds. Run:  set -a; source .env; set +a  first.",
  );
  process.exit(1);
}
const client = new FuturesClient({
  apiKey: KEY,
  apiSecret: SECRET,
  apiPassphrase: PASSPHRASE,
});

interface KucoinEnvelope<T> {
  code?: string;
  data?: T;
}

function toKucoinSymbol(coin: string): string {
  const base = coin.toUpperCase() === "BTC" ? "XBT" : coin.toUpperCase();
  return `${base}USDTM`;
}

/** Realised funding over [fromMs, toMs] in USDT; negative = paid. null on failure.
 *  Mirrors fetchFundingPaid in kucoin_executor.ts. */
async function fetchFundingPaid(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<number | null> {
  try {
    const res = (await client.getFundingHistory({
      symbol,
      from: fromMs,
      to: toMs,
    })) as KucoinEnvelope<{ dataList?: { funding?: number }[] }>;
    if (res?.code !== KC_OK || !res.data?.dataList) return null;
    return res.data.dataList.reduce((s, r) => s + (Number(r.funding) || 0), 0);
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────────
// Wrapped in a function so the per-trade `await fetchFundingPaid` is not a
// top-level await — tsx emits CJS on some Node setups, which rejects it.
async function main(): Promise<void> {
// ─── Load closed trades ──────────────────────────────────────────────────────────
if (!existsSync(FILE)) {
  console.error(`Store file not found: ${FILE} (run on the VPS, or scp it here).`);
  process.exit(1);
}
let closed: PaperTrade[] = [];
try {
  const store = JSON.parse(readFileSync(FILE, "utf8"));
  closed = Array.isArray(store.closed) ? store.closed : [];
} catch (e) {
  console.error(`Could not parse ${FILE}: ${(e as Error).message}`);
  process.exit(1);
}

const cutoff = DAYS != null ? Date.now() - DAYS * 86_400_000 : 0;
const trades = closed.filter((t) => t.closedAt >= cutoff);
if (trades.length === 0) {
  console.log("No closed trades in range.");
  process.exit(0);
}

console.log(
  `Analyzing ${trades.length} closed trade(s)` +
    (DAYS != null ? ` from the last ${DAYS}d` : "") +
    ` from ${FILE}\n` +
    (REFETCH
      ? "Using stored funding; re-fetching the rest from KuCoin (⚠️ unreliable — see --refetch).\n"
      : "Using funding stored per trade only; trades without it are price-only (--refetch to estimate).\n"),
);

// ─── Enrich each trade with real funding ─────────────────────────────────────────
interface Enriched {
  t: PaperTrade;
  riskUsdt: number;
  priceR: number;
  fundingUsdt: number | null; // null = fetch failed
  fundingR: number; // 0 when null (excluded from funding sums via fundingUsdt check)
  totalR: number; // priceR + fundingR (priceR only when funding null)
  // Realized funding rate normalized to %/8h (negative = paid). The figure to
  // compare against check_building_signals' 2%/8h cap. null when no funding data.
  fundRate8hPct: number | null;
}

let refetched = 0;
let noFunding = 0;
const rows: Enriched[] = [];
for (const t of trades) {
  // True notional from the realized-P&L relationship (pnlUsdc = pnlPct% ×
  // notional) — independent of sizeCoin's contract-vs-coin units. sizeCoin ×
  // entryPx under-counts for coins with a contract multiplier ≠ 1 (e.g. PORTAL),
  // which blows up fundR/%-8h. Fall back to sizeCoin × entryPx only at ~0 pnlPct.
  const notional =
    Math.abs(t.pnlPct) > 1e-9
      ? Math.abs(t.pnlUsdc / (t.pnlPct / 100))
      : t.sizeCoin * t.entryPx;
  const riskUsdt = STOP_LOSS_PCT * notional;
  const priceR = riskUsdt > 0 ? t.pnlUsdc / riskUsdt : 0;
  // Exact stored funding (kucoin_executor persists it per trade) is the only
  // trustworthy source. Trades without it are price-only unless --refetch is
  // set, and even then the funding-history sum is unreliable (see REFETCH).
  let fundingUsdt: number | null;
  if (t.fundingPaidUsdt != null) {
    fundingUsdt = t.fundingPaidUsdt;
  } else if (REFETCH) {
    fundingUsdt = await fetchFundingPaid(
      toKucoinSymbol(t.coin),
      t.openedAt,
      t.closedAt,
    );
    if (fundingUsdt != null) refetched++;
  } else {
    fundingUsdt = null;
    noFunding++;
  }
  const fundingR =
    fundingUsdt != null && riskUsdt > 0 ? fundingUsdt / riskUsdt : 0;
  // Realized funding as a fraction of notional, normalized to a per-8h rate.
  const holdH = (t.closedAt - t.openedAt) / 3_600_000;
  const fundRate8hPct =
    fundingUsdt != null && notional > 0 && holdH > 0
      ? (fundingUsdt / notional) * (8 / holdH) * 100
      : null;
  rows.push({
    t,
    riskUsdt,
    priceR,
    fundingUsdt,
    fundingR,
    totalR: priceR + fundingR,
    fundRate8hPct,
  });
}

// ─── Aggregate by signal type ────────────────────────────────────────────────────
const fmtR = (r: number) => (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
const fmtUsd = (u: number) => (u >= 0 ? "+" : "") + u.toFixed(2);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(0) : "0") + "%";

const byType = new Map<string, Enriched[]>();
for (const r of rows) {
  const k = r.t.signalType || "UNKNOWN";
  (byType.get(k) ?? byType.set(k, []).get(k)!).push(r);
}

if (refetched > 0) {
  console.log(
    `⚠️  Re-fetched funding for ${refetched} trade(s) via funding-history — UNRELIABLE ` +
      `(same recent total per symbol); treat those funding values with suspicion.\n`,
  );
}
if (noFunding > 0) {
  console.log(
    `ℹ️  ${noFunding} trade(s) have no stored funding → counted PRICE-ONLY. ` +
      `Funding stats reflect only the ${rows.length - noFunding} trade(s) with exact stored funding.\n`,
  );
}

const fundingNulls = rows.filter((r) => r.fundingUsdt == null).length;
if (fundingNulls > 0) {
  console.log(
    `⚠️  ${fundingNulls} trade(s) had no funding data (API/retention) — counted price-only.\n`,
  );
}

const header =
  "TYPE          n   priceR   fundR   totalR | win% price→total |   $price     $funding";
console.log(header);
console.log("─".repeat(header.length));

const printGroup = (label: string, g: Enriched[]) => {
  const n = g.length;
  const sumPriceR = g.reduce((s, r) => s + r.priceR, 0);
  const sumFundR = g.reduce((s, r) => s + r.fundingR, 0);
  const sumTotalR = g.reduce((s, r) => s + r.totalR, 0);
  const winPrice = g.filter((r) => r.priceR > 0).length;
  const winTotal = g.filter((r) => r.totalR > 0).length;
  const sumPriceUsd = g.reduce((s, r) => s + r.t.pnlUsdc, 0);
  const sumFundUsd = g.reduce((s, r) => s + (r.fundingUsdt ?? 0), 0);
  console.log(
    label.padEnd(13) +
      String(n).padStart(3) +
      "  " +
      fmtR(sumPriceR / n).padStart(7) +
      " " +
      fmtR(sumFundR / n).padStart(7) +
      " " +
      fmtR(sumTotalR / n).padStart(7) +
      " | " +
      (pct(winPrice, n) + "→" + pct(winTotal, n)).padStart(11) +
      " | " +
      fmtUsd(sumPriceUsd).padStart(9) +
      "  " +
      fmtUsd(sumFundUsd).padStart(11),
  );
};

for (const [type, g] of [...byType.entries()].sort()) printGroup(type, g);
console.log("─".repeat(header.length));
printGroup("ALL", rows);

console.log(
  "\nColumns: mean R per trade (price-only, funding, total) | win-rate price→funding-adjusted | total $.",
);
console.log(
  "Funding negative = paid (a cost for shorts on negative funding). totalR = priceR + fundingR.",
);

// ─── Realized funding rate vs the 2%/8h cap ────────────────────────────────────────
// check_building_signals.ts clamps modeled funding to CAP_PER_8H_PCT. Measure the
// realized rate to see whether that cap is realistic or under-states the drag.
const rated = rows.filter(
  (r): r is Enriched & { fundRate8hPct: number } => r.fundRate8hPct != null,
);
if (rated.length) {
  const median = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  // Magnitude of the funding rate (paid), %/8h — what the cap clamps.
  const mags = rated.map((r) => Math.abs(r.fundRate8hPct));
  const exceed = rated.filter((r) => Math.abs(r.fundRate8hPct) > CAP_PER_8H_PCT);
  const worst = rated.reduce((a, b) =>
    Math.abs(b.fundRate8hPct) > Math.abs(a.fundRate8hPct) ? b : a,
  );
  console.log("\n" + "─".repeat(72));
  console.log(`  REALIZED FUNDING RATE vs ${CAP_PER_8H_PCT}%/8h cap (check_building_signals)`);
  console.log("─".repeat(72));
  console.log(
    `  trades w/ funding: ${rated.length}  |  ` +
      `exceed cap: ${exceed.length} (${((100 * exceed.length) / rated.length).toFixed(0)}%)`,
  );
  console.log(
    `  realized |rate| %/8h:  median ${median(mags).toFixed(2)}  ` +
      `mean ${(mags.reduce((s, x) => s + x, 0) / mags.length).toFixed(2)}  ` +
      `max ${Math.max(...mags).toFixed(2)} (${worst.t.coin})`,
  );
  console.log(
    `\n  Read: if a large share exceed ${CAP_PER_8H_PCT}%/8h, the cap UNDER-states funding for\n` +
      `  extreme coins — raise/remove it and align analyze_stops/simulate_portfolio.\n` +
      `  If realized clusters at/below the cap, the cap is fine and the uncapped\n` +
      `  backtest model overstates. (KuCoin venue; one venue, real fills.)`,
  );
}

// ─── Per-trade detail ────────────────────────────────────────────────────────────
if (VERBOSE) {
  console.log("\nPer-trade (sorted by funding drag):");
  const sorted = [...rows].sort(
    (a, b) => (a.fundingUsdt ?? 0) - (b.fundingUsdt ?? 0),
  );
  console.log(
    "DATE        COIN       TYPE        reason    priceR   fundR  totalR    $fund   %/8h",
  );
  for (const r of sorted) {
    const d = new Date(r.t.closedAt).toISOString().slice(0, 10);
    const rate =
      r.fundRate8hPct == null
        ? "n/a"
        : (r.fundRate8hPct >= 0 ? "+" : "") + r.fundRate8hPct.toFixed(2);
    const overCap = r.fundRate8hPct != null && Math.abs(r.fundRate8hPct) > CAP_PER_8H_PCT;
    console.log(
      d +
        "  " +
        r.t.coin.padEnd(9) +
        "  " +
        (r.t.signalType || "?").padEnd(10) +
        "  " +
        r.t.closeReason.padEnd(8) +
        "  " +
        fmtR(r.priceR).padStart(6) +
        "  " +
        fmtR(r.fundingR).padStart(6) +
        "  " +
        fmtR(r.totalR).padStart(6) +
        "  " +
        (r.fundingUsdt == null ? "n/a" : fmtUsd(r.fundingUsdt)).padStart(8) +
        "  " +
        rate.padStart(6) +
        (overCap ? " ⚠️" : ""),
    );
  }
}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
