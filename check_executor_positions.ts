/**
 * check_executor_positions.ts
 * ===========================
 * Monitors paper/live positions managed by bybit_executor.ts.
 * Reads bybit_positions.json and fetches live prices from Bybit.
 *
 * Usage:
 *   npx tsx check_executor_positions.ts          ← open + last 10 closed
 *   npx tsx check_executor_positions.ts --all    ← open + all closed
 *   npx tsx check_executor_positions.ts --open   ← open positions only
 */

import { existsSync, readFileSync } from "fs";
import type { PaperTrade, PositionRecord } from "./shared_types.ts";

const POSITIONS_FILE = "bybit_positions.json";
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
  if (pct > 3) return "✅";
  if (pct < -3) return "❌";
  return "😐";
}

function reasonIcon(r: string): string {
  return r === "stop"
    ? "🛑"
    : r === "timeout"
      ? "⏱"
      : r === "target"
        ? "🎯"
        : r === "trailing"
          ? "📐"
          : "📋";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(POSITIONS_FILE)) {
    console.log(`\nNo ${POSITIONS_FILE} found — executor hasn't run yet.\n`);
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

  // ── Open positions ──────────────────────────────────────────────────────────
  const openEntries = Object.entries(store.open);
  console.log(`\nActive (${openEntries.length})`);

  if (openEntries.length === 0) {
    console.log("  No open positions.");
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

      console.log(
        `${coin.padEnd(10)} ${fmtTime(pos.openedAt).padStart(7)} ${age.padStart(9)}` +
          `   ${("$" + pos.entryPx.toFixed(6)).padStart(10)} ${("$" + price.toFixed(6)).padStart(10)}` +
          `   ${(pnlPct.toFixed(2) + "%").padStart(7)} ${(pnl3x.toFixed(2) + "%").padStart(8)}` +
          `   ${pos.signalType.padStart(10)}  $${pos.stopLossPx.toFixed(6)} (+${stopPct}%)  ${icon}`,
      );
    }
  }

  if (OPEN_ONLY) {
    console.log();
    return;
  }

  // ── Closed positions ────────────────────────────────────────────────────────
  const closed = store.closed;
  const showN = SHOW_ALL ? closed.length : Math.min(closed.length, 10);
  const showing = closed.slice(-showN).reverse();

  console.log(
    `\nClosed (${closed.length})${!SHOW_ALL && closed.length > 10 ? ` — showing last ${showN}` : ""}`,
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

    if (!SHOW_ALL && closed.length > 10) {
      console.log(`  ... ${closed.length - 10} more. Run --all to see all.`);
    }
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
    if (stopOuts || timeouts) {
      console.log(`  Stop-outs: ${stopOuts}  |  Timeouts: ${timeouts}`);
    }
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
