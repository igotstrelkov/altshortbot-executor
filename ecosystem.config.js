// PM2 Ecosystem Config — AltShortBot
//
// Three processes:
//   altshortbot-scanner  — hourly at :05; reads Bybit, fires signals, queues tradeable ones
//   altshortbot-executor — every 5 min; reads queue, places shorts on Bybit (demo or live)
//   altshortbot-digest   — daily at 09:00 UTC; heartbeat + 24h P&L summary to Telegram
//
// Setup:
//   npm install -g pm2
//   export TELEGRAM_TOKEN="..."
//   export TELEGRAM_CHAT_ID="..."
//   export BYBIT_API_KEY="..."         # Bybit API key (executor — demo or live)
//   export BYBIT_API_SECRET="..."      # Bybit API secret
//   pm2 start ecosystem.config.js
//   pm2 save           ← persist across reboots
//   pm2 startup        ← auto-start on server boot (follow the printed instruction)
//
// Useful commands:
//   pm2 logs altshortbot-scanner       ← scanner log tail
//   pm2 logs altshortbot-executor      ← executor log tail
//   pm2 logs altshortbot-digest        ← digest log tail
//   pm2 status                         ← process health
//   pm2 restart altshortbot-executor   ← force a run immediately
//   pm2 stop altshortbot-executor      ← pause trading without stopping scanner
//   pm2 delete altshortbot-{scanner,executor,digest}
//
// Migrating from the previous single-process config:
//   pm2 delete altshortbot && pm2 start ecosystem.config.js && pm2 save
//   (The old name was just `altshortbot`; the apps are now suffixed.)
//
// Going live (after demo validation):
//   The executor runs in demo mode — real demo orders — via `demoTrading: true`
//   in bybit_executor.ts. There is no `--paper` flag in use. To trade real
//   money, set `demoTrading: false` in bybit_executor.ts (CLAUDE.md "Do not"
//   rule #4 — that flag is the single gate), then:
//     pm2 restart altshortbot-executor
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

module.exports = {
  apps: [
    {
      name: "altshortbot-scanner",
      cwd: __dirname, // pin state-file paths regardless of where `pm2 start` runs

      // Run once and exit — PM2 restarts on cron schedule
      script: "npx",
      args: "tsx live_scanner.ts",

      // Hourly at :05 past (gives exchanges 5 min after settlement)
      cron_restart: "5 * * * *",
      autorestart: false,

      out_file: "logs/scanner.log",
      error_file: "logs/scanner-error.log",
      time: true,

      env: {
        NODE_ENV: "production",
        TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN ?? "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
        // Optional: override watchlist (comma-separated)
        // SCANNER_COINS: "ORDI,KNC,HIVE,HYPER,ENJ",
      },
    },
    {
      name: "altshortbot-executor",
      cwd: __dirname,

      // Run once and exit — PM2 restarts on cron schedule.
      // Runs in demo mode (real demo orders) via `demoTrading: true` in
      // bybit_executor.ts. Go live by flipping that flag — not via a PM2 arg.
      script: "npx",
      args: "tsx bybit_executor.ts",

      // Every 5 minutes
      cron_restart: "*/5 * * * *",
      autorestart: false,

      out_file: "logs/executor.log",
      error_file: "logs/executor-error.log",
      time: true,

      env: {
        NODE_ENV: "production",
        TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN ?? "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
        BYBIT_API_KEY: process.env.BYBIT_API_KEY ?? "",
        BYBIT_API_SECRET: process.env.BYBIT_API_SECRET ?? "",
        BYBIT_PAPER_ACCOUNT: "10000", // simulated account size — only used with --paper
        // BYBIT_TESTNET:     "1",        // uncomment to use testnet
      },
    },
    {
      name: "altshortbot-digest",
      cwd: __dirname, // digest reads state files by relative path — must run here

      // Heartbeat + 24h P&L summary. Catches silent failures (e.g. scanner
      // stopped firing, executor not running) by checking file mtimes.
      script: "npx",
      args: "tsx daily_digest.ts",

      // Daily at 09:00 UTC
      cron_restart: "0 9 * * *",
      autorestart: false,

      out_file: "logs/digest.log",
      error_file: "logs/digest-error.log",
      time: true,

      env: {
        NODE_ENV: "production",
        TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN ?? "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
      },
    },
  ],
};
