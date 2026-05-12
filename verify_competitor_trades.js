/**
 * verify_competitor_trades.ts
 * ============================
 * Cross-references competitor trades against AltShortBot backtest signals.
 * For each competitor trade, runs the backtest and checks whether any signal
 * fired within PRICE_TOLERANCE % of the competitor's entry price.
 *
 * Usage: npx tsx verify_competitor_trades.ts
 */
import { spawnSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
const COMPETITOR_TRADES = [
    { coin: "ENJ", leverage: 1, roi: 15.44, entry: 0.09826, exit: 0.083085 },
    { coin: "SPK", leverage: 1, roi: 17.24, entry: 0.054369, exit: 0.044994 },
    { coin: "HYPER", leverage: 1, roi: 22.91, entry: 0.1638, exit: 0.12626 },
    { coin: "BSB", leverage: 1, roi: 25.55, entry: 1.1394, exit: 0.8482 },
    { coin: "KNC", leverage: 1, roi: 12.26, entry: 0.16874, exit: 0.14805 },
    { coin: "HIVE", leverage: 1, roi: 16.06, entry: 0.08004, exit: 0.06718 },
];
// ── Parameters (validated set) ────────────────────────────────────────────────
const BACKTEST_ARGS = [
    "--days",
    "60",
    "--threshold",
    "10",
    "--min-positive",
    "2",
    "--min-oi",
    "2",
    "--max-price",
    "2",
    "--pump-pct",
    "25",
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
    // NOTE: --exhaust-oi-drop intentionally omitted here.
    // Bybit OI covers only ~8 days; signals older than that would be blocked,
    // making this a test of OI data coverage rather than signal detection.
    // The live scanner always has fresh OI so the filter works correctly in production.
    "--source",
    "bybit", // matches live scanner data source
    "--lookahead",
    "48",
];
// How close does our signal price need to be to the competitor's entry?
const PRICE_TOLERANCE_PCT = 10; // within ±10%
// ── Runner ────────────────────────────────────────────────────────────────────
function runBacktest(coin) {
    const jsonFile = `/tmp/verify_${coin}.json`;
    const fixture = `fixtures/${coin}.json`;
    const fixtureArg = existsSync(fixture)
        ? ["--use-fixtures", "fixtures"]
        : ["--save-fixtures", "fixtures"];
    try {
        unlinkSync(jsonFile);
    }
    catch { }
    const result = spawnSync("npx", [
        "tsx",
        "backtest_signals.ts",
        "--coin",
        coin,
        "--json",
        jsonFile,
        ...fixtureArg,
        ...BACKTEST_ARGS,
    ], {
        encoding: "utf8",
        timeout: 180_000,
        shell: true,
        cwd: process.cwd(),
    });
    if (result.status !== 0 || !existsSync(jsonFile)) {
        console.error(`  ❌ Backtest failed for ${coin}`);
        console.error(result.stderr?.slice(0, 200));
        return null;
    }
    const data = JSON.parse(require("fs").readFileSync(jsonFile, "utf8"));
    return data.coins.find((c) => c.coin === coin) ?? null;
}
function findClosestSignal(result, compEntry) {
    const allSignals = [
        ...result.pump.signals_detail.map((s) => ({ sig: s, type: "PUMP_TOP" })),
        ...result.squeeze.signals_detail.map((s) => ({
            sig: s,
            type: s.phase ?? "SQUEEZE",
        })),
    ];
    if (!allSignals.length)
        return { matched: false };
    // Find the signal whose entry price is closest to competitor's
    let best = allSignals[0];
    let bestDiff = Math.abs(((best.sig.entry - compEntry) / compEntry) * 100);
    for (const s of allSignals.slice(1)) {
        const diff = Math.abs(((s.sig.entry - compEntry) / compEntry) * 100);
        if (diff < bestDiff) {
            best = s;
            bestDiff = diff;
        }
    }
    return {
        matched: bestDiff <= PRICE_TOLERANCE_PCT,
        signal: best.sig,
        signalType: best.type,
        priceDiff: bestDiff,
    };
}
// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("AltShortBot — Competitor Trade Verification");
    console.log("═".repeat(70));
    console.log(`Tolerance: competitor entry within ±${PRICE_TOLERANCE_PCT}% of AltShortBot signal`);
    console.log(`Backtest:  --days 60 with validated parameters\n`);
    let caught = 0;
    for (const trade of COMPETITOR_TRADES) {
        console.log(`\n── ${trade.coin} ─────────────────────────────────────────────`);
        console.log(`   Competitor: Short ${trade.leverage}x @ $${trade.entry} → $${trade.exit}` +
            ` (ROI: +${trade.roi}% / at 3x: +${(trade.roi * 3).toFixed(1)}%)`);
        process.stdout.write(`   Running backtest...`);
        const result = runBacktest(trade.coin);
        if (!result) {
            console.log(" failed");
            continue;
        }
        console.log(" done");
        const match = findClosestSignal(result, trade.entry);
        if (match.matched && match.signal) {
            caught++;
            const s = match.signal;
            console.log(`   ✅ CAUGHT — ${match.signalType} @ $${s.entry.toFixed(6)}`);
            console.log(`      Fired:     ${s.firedAt}`);
            console.log(`      Verdict:   ${s.verdict}  (${s.finalPct > 0 ? "+" : ""}${s.finalPct.toFixed(2)}% in 48h)`);
            console.log(`      Price gap: ${match.priceDiff.toFixed(1)}% from competitor entry`);
            console.log(`      AltShortBot at 3x: ${(Math.abs(s.finalPct) * 3).toFixed(1)}% ROI`);
        }
        else if (match.signal) {
            const s = match.signal;
            console.log(`   ⚠️  NEAR MISS — closest signal: ${match.signalType} @ $${s.entry.toFixed(6)}`);
            console.log(`      Fired:    ${s.firedAt}`);
            console.log(`      Verdict:  ${s.verdict}`);
            console.log(`      Price gap: ${match.priceDiff.toFixed(1)}% from competitor entry (>${PRICE_TOLERANCE_PCT}%)`);
        }
        else {
            console.log(`   ❌ NOT CAUGHT — no signals fired within ±${PRICE_TOLERANCE_PCT}% of $${trade.entry}`);
        }
    }
    console.log(`\n${"═".repeat(70)}`);
    console.log(`Result: ${caught}/${COMPETITOR_TRADES.length} competitor trades caught by AltShortBot`);
    console.log();
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
