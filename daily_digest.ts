/**
 * AltShortBot Daily Digest
 * ========================
 * Runs once a day via PM2 cron. Reads state files, sends a Telegram summary.
 *
 * Purpose: catches silent failures that would otherwise go unnoticed.
 *   • scanner stopped writing scanner_state.json  → "scanner stale" alert
 *   • executor stopped writing bybit_positions.json → "executor stale" alert
 *   • normal day → 24h P&L summary + open positions + queue depth
 *
 * Setup (in ecosystem.config.js):
 *   {
 *     name: "altshortbot-digest",
 *     script: "npx",
 *     args: "tsx daily_digest.ts",
 *     cron_restart: "0 9 * * *",   // 09:00 UTC daily
 *     autorestart: false,
 *   }
 *
 * Run manually:
 *   npx tsx daily_digest.ts
 */

import { existsSync, readFileSync, statSync } from "fs";
import { fileURLToPath } from "url";
import type { PaperTrade, PositionRecord } from "./shared_types.ts";

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

const SCANNER_STATE = "scanner_state.json";
const POSITIONS = "bybit_positions.json";
const QUEUE = "signal_queue.json";

// Scanner runs every 15 min; executor every 5 min.
// 1h staleness = 4 missed scanner runs or 12 missed executor runs.
const STALE_SCANNER_H = 1;
const STALE_EXECUTOR_H = 1;

// ─── Types ────────────────────────────────────────────────────────────────────
interface PositionStore {
  open: Record<string, PositionRecord>;
  closed: PaperTrade[];
  paperEquityUsdt: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[telegram]", msg);
    return;
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "Markdown",
    }),
  });
}

function fileAgeH(path: string): number | null {
  if (!existsSync(path)) return null;
  return (Date.now() - statSync(path).mtimeMs) / 3_600_000;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const lines: string[] = [];
  const warnings: string[] = [];
  const dateStr = new Date().toISOString().slice(0, 10);
  lines.push(`📊 *AltShortBot daily digest* — ${dateStr}`);

  // ── Staleness checks ────────────────────────────────────────────────────────
  const scannerAge = fileAgeH(SCANNER_STATE);
  if (scannerAge === null) {
    warnings.push(`🚨 ${SCANNER_STATE} missing — scanner may never have run`);
  } else if (scannerAge > STALE_SCANNER_H) {
    warnings.push(`🚨 scanner stale: last write ${scannerAge.toFixed(1)}h ago`);
  }

  const executorAge = fileAgeH(POSITIONS);
  if (executorAge === null) {
    warnings.push(`🚨 ${POSITIONS} missing — executor may never have run`);
  } else if (executorAge > STALE_EXECUTOR_H) {
    warnings.push(
      `🚨 executor stale: last write ${executorAge.toFixed(1)}h ago`,
    );
  }

  // ── Positions / P&L ─────────────────────────────────────────────────────────
  if (existsSync(POSITIONS)) {
    try {
      const store = JSON.parse(
        readFileSync(POSITIONS, "utf8"),
      ) as PositionStore;
      const since = Date.now() - 24 * 3_600_000;
      const closed24h = store.closed.filter((t) => t.closedAt >= since);

      const wins = closed24h.filter((t) => t.pnlPct > 0).length;
      const losses = closed24h.length - wins;
      const pnlUsdt = closed24h.reduce((a, t) => a + t.pnlUsdc, 0);
      const openCount = Object.keys(store.open).length;
      const pendingCount = Object.values(store.open).filter(
        (p) => p.pending,
      ).length;

      lines.push("");
      lines.push(
        `*Positions:* ${openCount} open` +
          (pendingCount ? ` (${pendingCount} pending)` : ""),
      );
      lines.push(
        `*Closed 24h:* ${closed24h.length}` +
          (closed24h.length ? ` (${wins}W / ${losses}L)` : ""),
      );
      lines.push(
        `*P&L 24h:* ${pnlUsdt >= 0 ? "+" : ""}$${pnlUsdt.toFixed(2)}`,
      );
      lines.push(`*Paper equity:* $${store.paperEquityUsdt.toFixed(2)}`);

      // Per-position summary if any open
      if (openCount > 0) {
        lines.push("");
        lines.push("*Open:*");
        for (const pos of Object.values(store.open)) {
          const ageH = (Date.now() - pos.openedAt) / 3_600_000;
          const pendingTag = pos.pending ? " ⏳" : "";
          lines.push(
            `• ${pos.coin}${pendingTag} — ${ageH.toFixed(1)}h, ` +
              `entry $${pos.entryPx.toFixed(6)} (${pos.signalType})`,
          );
        }
      }
    } catch (e) {
      warnings.push(
        `🚨 failed to parse ${POSITIONS}: ${(e as Error).message}`,
      );
    }
  }

  // ── Queue depth ─────────────────────────────────────────────────────────────
  if (existsSync(QUEUE)) {
    try {
      const queue = JSON.parse(readFileSync(QUEUE, "utf8")) as unknown[];
      if (queue.length) {
        lines.push("");
        lines.push(`*Queue depth:* ${queue.length} pending`);
      }
    } catch {
      /* ignore — corrupt queue is not worth alerting separately */
    }
  }

  // ── Compose: warnings first if any, then summary ───────────────────────────
  const body = warnings.length
    ? [lines[0], "", ...warnings, "", ...lines.slice(1)].join("\n")
    : lines.join("\n");

  await sendTelegram(body);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(async (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`daily_digest crashed: ${msg}`);
    await sendTelegram(
      `🚨 *altshortbot* — daily_digest crashed\n\`${msg}\``,
    );
    process.exit(1);
  });
}
