// PM2 Ecosystem Config — AltShortBot
//
// Two processes:
//   altshortbot-scanner  — hourly at :05; reads Bybit, fires signals, queues tradeable ones
//   altshortbot-executor — every 5 min; reads queue, places shorts on Hyperliquid (or paper)
//
// Setup:
//   npm install -g pm2
//   export TELEGRAM_TOKEN="..."
//   export TELEGRAM_CHAT_ID="..."
//   export HL_WALLET_ADDRESS="0x..."   # main wallet (only for live mode)
//   export HL_AGENT_KEY="0x..."        # agent wallet private key (only for live mode)
//   pm2 start ecosystem.config.js
//   pm2 save           ← persist across reboots
//   pm2 startup        ← auto-start on server boot (follow the printed instruction)
//
// Useful commands:
//   pm2 logs altshortbot-scanner       ← scanner log tail
//   pm2 logs altshortbot-executor      ← executor log tail
//   pm2 status                         ← process health
//   pm2 restart altshortbot-executor   ← force a run immediately
//   pm2 stop altshortbot-executor      ← pause trading without stopping scanner
//   pm2 delete altshortbot-{scanner,executor}
//
// Migrating from the previous single-process config:
//   pm2 delete altshortbot && pm2 start ecosystem.config.js && pm2 save
//   (The old name was just `altshortbot`; both apps are now suffixed.)
//
// Going live (after paper validation):
//   1. Remove `--paper` from altshortbot-executor args below
//   2. pm2 restart altshortbot-executor

module.exports = {
  apps: [
    {
      name: "altshortbot-scanner",

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

      // Run once and exit — PM2 restarts on cron schedule.
      // ── KEEP `--paper` UNTIL YOU'VE VALIDATED 2-4 WEEKS OF PAPER P&L. ──
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
        BYBIT_PAPER_ACCOUNT: "10000", // simulated account size for paper mode
        HL_WALLET_ADDRESS: process.env.HL_WALLET_ADDRESS ?? "",
        HL_AGENT_KEY: process.env.HL_AGENT_KEY ?? "",
        HL_PAPER_ACCOUNT: "10000", // simulated account size for paper mode
        // HL_TESTNET:     "1",        // uncomment to use testnet
      },
    },
  ],
};
