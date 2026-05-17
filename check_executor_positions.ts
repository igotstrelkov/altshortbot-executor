/**
 * check_executor_positions.ts
 * ===========================
 * Monitors paper/live positions managed by bybit_executor.ts.
 * Reads bybit_positions.json and fetches live prices from Bybit.
 * Also shows long positions from long_positions.json if active.
 *
 * Usage:
 *   npx tsx check_executor_positions.ts          ← open + last 10 closed
 *   npx tsx check_executor_positions.ts --all    ← open + all closed
 *   npx tsx check_executor_positions.ts --open   ← open positions only
 */

import { existsSync, readFileSync } from "fs";
import type { PaperTrade, PositionRecord } from "./shared_types.ts";

const POSITIONS_FILE = "bybit_positions.json";
const LONG_POSITIONS_FILE = "long_positions.json";
const BB_BASE = "https://api.bybit.com";
const PAPER_START = 10_000;
const SHOW_ALL = process.argv.includes("--all");
const OPEN_ONLY = process.argv.includes("--open");

// ── Types ─────────────────────────────────────────────────────────────────────
interface BybitPositionStore {
  open: Record<string, PositionRecord>;
  closed: PaperTrade[];
  paperEquityUsdt: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchPrice(coin: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${BB_BASE}/v5/market/tickers?category=linear&symbol=${coin}USDT`,
    );
    const d = (await res.json()) as {
      result?: { list?: { lastPrice: string }[] };
    };
    const p = d?.result?.list?.[0]?.lastPrice;
    return p ? parseFloat(p) : null;
  } catch {
    return null;
  }
}

function fmtAge(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + "Z";
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
}

function pnlIcon(pct: number): string {
  if (pct > 3) return "\u2705";
  if (pct < -3) return "\u274c";
  return "\ud83d\ude10";
}

function reasonIcon(r: string): string {
  return r === "stop"
    ? "\ud83d\uded1"
    : r === "timeout"
      ? "\u23f1"
      : r === "target"
        ? "\ud83c\udfaf"
        : r === "trailing"
          ? "\ud83d\udcd0"
          : "\ud83d\udccb";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(POSITIONS_FILE)) {
    console.log(`\nNo ${POSITIONS_FILE} found — executor hasn\'t run yet.\n`);
    return;
  }

  const store: BybitPositionStore = JSON.parse(
    readFileSync(POSITIONS_FILE, "utf8"),
  );
  const nowMs = Date.now();

  console.log(`\nAltShortBot Bybit — Position Monitor`);
  console.log(
    `${new Date().toISOString()}  |  paper equity: $${store.paperEquityUsdt.toFixed(2)}`,
  );

  // ── Short positions ─────────────────────────────────────────────────────────
  const openEntries = Object.entries(store.open);
  console.log(`\nShorts — Active (${openEntries.length})`);

  if (openEntries.length === 0) {
    console.log("  No open short positions.");
  } else {
    const hdr = `${"Coin".padEnd(10)} ${"Opened".padStart(7)} ${"Age".padStart(9)}   ${"Entry".padStart(10)} ${"Now".padStart(10)}    ${"P&L".padStart(7)} ${"At 3x".padStart(8)}   ${"Signal".padStart(10)}  Stop`;
    console.log(hdr);
    console.log("─".repeat(hdr.length + 4));

    for (const [coin, pos] of openEntries) {
      const price = await fetchPrice(coin);
      if (!price) {
        console.log(`  ${coin}: price unavailable`);
        continue;
      }
      const pnlPct = ((pos.entryPx - price) / pos.entryPx) * 100;
      const pnl3x = pnlPct * 3;
      const age = fmtAge(nowMs - pos.openedAt);
      const icon = pnlIcon(pnlPct);
      const stopPct = (
        ((pos.stopLossPx - pos.entryPx) / pos.entryPx) *
        100
      ).toFixed(0);
      const trailLine =
        pos.trailingActive && pos.trailingStopPx
          ? `\n  ${"".padEnd(10)}  \ud83d\udcd0 trail $${pos.trailingStopPx.toFixed(6)} | low $${(pos.lowestPriceSeen ?? price).toFixed(6)} | locks in ${(((pos.entryPx - pos.trailingStopPx) / pos.entryPx) * 100).toFixed(2)}%`
          : "";
      console.log(
        `${coin.padEnd(10)} ${fmtTime(pos.openedAt).padStart(7)} ${age.padStart(9)}` +
          `   ${("$" + pos.entryPx.toFixed(6)).padStart(10)} ${("$" + price.toFixed(6)).padStart(10)}` +
          `   ${(pnlPct.toFixed(2) + "%").padStart(7)} ${(pnl3x.toFixed(2) + "%").padStart(8)}` +
          `   ${pos.signalType.padStart(10)}  $${pos.stopLossPx.toFixed(6)} (+${stopPct}%)  ${icon}` +
          trailLine,
      );
    }
  }

  // ── Long positions ──────────────────────────────────────────────────────────
  if (existsSync(LONG_POSITIONS_FILE)) {
    const ls: BybitPositionStore = JSON.parse(
      readFileSync(LONG_POSITIONS_FILE, "utf8"),
    );
    const lOpen = Object.entries(ls.open);
    console.log(`\nLongs — Active (${lOpen.length})`);

    if (lOpen.length === 0) {
      console.log("  No open long positions.");
    } else {
      const hdrL = `${"Coin".padEnd(10)} ${"Opened".padStart(7)} ${"Age".padStart(9)}   ${"Entry".padStart(10)} ${"Now".padStart(10)}    ${"P&L".padStart(7)} ${"At 3x".padStart(8)}   Stop`;
      console.log(hdrL);
      console.log("─".repeat(hdrL.length + 4));
      for (const [coin, pos] of lOpen) {
        const price = await fetchPrice(coin);
        if (!price) {
          console.log(`  ${coin}: price unavailable`);
          continue;
        }
        const pnlPct = ((price - pos.entryPx) / pos.entryPx) * 100;
        const stopPct = (
          ((pos.entryPx - pos.stopLossPx) / pos.entryPx) *
          100
        ).toFixed(0);
        const wideStop =
          (pos.entryPx - pos.stopLossPx) / pos.entryPx > 0.15
            ? " \ud83d\udd36WIDE"
            : "";
        const highPx = pos.highestPriceSeen ?? price;
        const trailL =
          pos.trailingActive && pos.trailingStopPx
            ? `\n  ${"".padEnd(10)}  \ud83d\udcd0 trail $${pos.trailingStopPx.toFixed(6)} | high $${highPx.toFixed(6)} | locks in +${(((pos.trailingStopPx - pos.entryPx) / pos.entryPx) * 100).toFixed(2)}%`
            : "";
        console.log(
          `${coin.padEnd(10)} ${fmtTime(pos.openedAt).padStart(7)} ${fmtAge(nowMs - pos.openedAt).padStart(9)}` +
            `   ${("$" + pos.entryPx.toFixed(6)).padStart(10)} ${("$" + price.toFixed(6)).padStart(10)}` +
            `   ${(pnlPct.toFixed(2) + "%").padStart(7)} ${(pnlPct * 3).toFixed(2).padStart(7) + "%"}` +
            `   $${pos.stopLossPx.toFixed(6)} (-${stopPct}%)${wideStop}  ${pnlIcon(pnlPct)}` +
            trailL,
        );
      }
    }

    if (!OPEN_ONLY && ls.closed.length > 0) {
      const showLN = SHOW_ALL
        ? ls.closed.length
        : Math.min(ls.closed.length, 5);
      const showingL = ls.closed.slice(-showLN).reverse();
      console.log(
        `\nLongs — Closed (${ls.closed.length})${!SHOW_ALL && ls.closed.length > 5 ? ` — last ${showLN}` : ""}`,
      );
      const hdrL2 = `${"Coin".padEnd(10)} ${"Opened".padStart(16)} ${"Entry".padStart(10)} ${"Exit".padStart(10)}    ${"P&L".padStart(7)} ${"At 3x".padStart(8)} ${"USDT".padStart(8)}   Reason`;
      console.log(hdrL2);
      console.log("─".repeat(hdrL2.length));
      for (const t of showingL) {
        console.log(
          `${t.coin.padEnd(10)} ${fmtDate(t.openedAt).padStart(16)}` +
            ` ${("$" + t.entryPx.toFixed(6)).padStart(10)} ${("$" + t.exitPx.toFixed(6)).padStart(10)}` +
            `   ${(t.pnlPct.toFixed(2) + "%").padStart(7)} ${(t.pnlPct * 3).toFixed(2).padStart(7) + "%"}` +
            ` ${(t.pnlUsdc >= 0 ? "+" : "") + t.pnlUsdc.toFixed(2).padStart(7)}` +
            `   ${reasonIcon(t.closeReason)} ${t.closeReason}  ${pnlIcon(t.pnlPct)}`,
        );
      }
      const lWins = ls.closed.filter((t) => t.pnlPct > 0).length;
      const lAvg =
        ls.closed.reduce((a, t) => a + t.pnlPct, 0) / ls.closed.length;
      console.log(
        `  ${ls.closed.length} closed  |  ${lWins}W ${ls.closed.length - lWins}L  |  avg: ${lAvg >= 0 ? "+" : ""}${lAvg.toFixed(2)}% (${(lAvg * 3).toFixed(2)}% at 3x)`,
      );
    }
  }

  if (OPEN_ONLY) {
    console.log();
    return;
  }

  // ── Short — Closed ──────────────────────────────────────────────────────────
  const closed = store.closed;
  const showN = SHOW_ALL ? closed.length : Math.min(closed.length, 10);
  const showing = closed.slice(-showN).reverse();

  console.log(
    `\nShorts — Closed (${closed.length})${!SHOW_ALL && closed.length > 10 ? ` — showing last ${showN}` : ""}`,
  );

  if (closed.length === 0) {
    console.log("  No closed positions yet.");
  } else {
    const hdr2 = `${"Coin".padEnd(10)} ${"Opened".padStart(16)} ${"Entry".padStart(10)} ${"Exit".padStart(10)}    ${"P&L".padStart(7)} ${"At 3x".padStart(8)} ${"USDT".padStart(8)}   Reason`;
    console.log(hdr2);
    console.log("─".repeat(hdr2.length));
    for (const t of showing) {
      const icon = pnlIcon(t.pnlPct);
      console.log(
        `${t.coin.padEnd(10)} ${fmtDate(t.openedAt).padStart(16)}` +
          ` ${("$" + t.entryPx.toFixed(6)).padStart(10)} ${("$" + t.exitPx.toFixed(6)).padStart(10)}` +
          `   ${(t.pnlPct.toFixed(2) + "%").padStart(7)} ${(t.pnlPct * 3).toFixed(2).padStart(7) + "%"}` +
          ` ${(t.pnlUsdc >= 0 ? "+" : "") + t.pnlUsdc.toFixed(2).padStart(7)}` +
          `   ${reasonIcon(t.closeReason)} ${t.closeReason.padEnd(8)} ${icon}`,
      );
    }
    if (!SHOW_ALL && closed.length > 10)
      console.log(`  ... ${closed.length - 10} more. Run --all to see all.`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (closed.length > 0) {
    const wins = closed.filter((t) => t.pnlPct > 0).length;
    const losses = closed.filter((t) => t.pnlPct < 0).length;
    const neutral = closed.length - wins - losses;
    const avgPnl = closed.reduce((a, t) => a + t.pnlPct, 0) / closed.length;
    const totalPnl = store.paperEquityUsdt - PAPER_START;
    const totalPct = (totalPnl / PAPER_START) * 100;
    const stopOuts = closed.filter((t) => t.closeReason === "stop").length;
    const timeouts = closed.filter((t) => t.closeReason === "timeout").length;

    console.log(`\n${"─".repeat(50)}`);
    console.log(
      `  ${closed.length} closed  |  ` +
        `${wins}W ${losses}L${neutral ? ` ${neutral}N` : ""}  |  ` +
        `win rate: ${((wins / (wins + losses || 1)) * 100).toFixed(0)}%  |  ` +
        `avg: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}% (${(avgPnl * 3).toFixed(2)}% at 3x)`,
    );
    if (stopOuts || timeouts)
      console.log(`  Stop-outs: ${stopOuts}  |  Timeouts: ${timeouts}`);
    console.log(
      `  Paper equity: $${store.paperEquityUsdt.toFixed(2)}  ` +
        `(start: $${PAPER_START.toLocaleString()}  ` +
        `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}  ` +
        `${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(2)}%)`,
    );
  }

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
