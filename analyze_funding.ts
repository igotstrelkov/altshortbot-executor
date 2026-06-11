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

// ─── CLI ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const flagVal = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DAYS = flagVal("--days") ? parseFloat(flagVal("--days")!) : null;
const FILE = flagVal("--file") ?? "kucoin_positions.json";

// ─── KuCoin client (read-only: getFundingHistory) ───────────────────────────────
const KEY = process.env.KUCOIN_API_KEY ?? "";
const SECRET = process.env.KUCOIN_API_SECRET ?? "";
const PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE ?? "";
if (!KEY || !SECRET || !PASSPHRASE) {
  console.error(
    "Missing KuCoin creds. Run:  set -a; source .env; set +a  before this script.",
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
    ` from ${FILE}\nUsing funding stored on each record; re-fetching from KuCoin for older trades...\n`,
);

// ─── Enrich each trade with real funding ─────────────────────────────────────────
interface Enriched {
  t: PaperTrade;
  riskUsdt: number;
  priceR: number;
  fundingUsdt: number | null; // null = fetch failed
  fundingR: number; // 0 when null (excluded from funding sums via fundingUsdt check)
  totalR: number; // priceR + fundingR (priceR only when funding null)
}

let refetched = 0;
const rows: Enriched[] = [];
for (const t of trades) {
  const notional = t.sizeCoin * t.entryPx;
  const riskUsdt = STOP_LOSS_PCT * notional;
  const priceR = riskUsdt > 0 ? t.pnlUsdc / riskUsdt : 0;
  // Prefer funding persisted on the record (kucoin_executor now stores it);
  // only hit the exchange for older trades written before that field existed.
  let fundingUsdt: number | null;
  if (t.fundingPaidUsdt != null) {
    fundingUsdt = t.fundingPaidUsdt;
  } else {
    fundingUsdt = await fetchFundingPaid(
      toKucoinSymbol(t.coin),
      t.openedAt,
      t.closedAt,
    );
    if (fundingUsdt != null) refetched++;
  }
  const fundingR =
    fundingUsdt != null && riskUsdt > 0 ? fundingUsdt / riskUsdt : 0;
  rows.push({
    t,
    riskUsdt,
    priceR,
    fundingUsdt,
    fundingR,
    totalR: priceR + fundingR,
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
  console.log(`ℹ️  Re-fetched funding from KuCoin for ${refetched} older trade(s).\n`);
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

// ─── Per-trade detail ────────────────────────────────────────────────────────────
if (VERBOSE) {
  console.log("\nPer-trade (sorted by funding drag):");
  const sorted = [...rows].sort(
    (a, b) => (a.fundingUsdt ?? 0) - (b.fundingUsdt ?? 0),
  );
  console.log(
    "DATE        COIN       TYPE        reason    priceR   fundR  totalR    $fund",
  );
  for (const r of sorted) {
    const d = new Date(r.t.closedAt).toISOString().slice(0, 10);
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
        (r.fundingUsdt == null ? "n/a" : fmtUsd(r.fundingUsdt)).padStart(8),
    );
  }
}
