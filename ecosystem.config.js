// PM2 Ecosystem Config — AltShortBot Live Scanner
//
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save          ← persist across reboots
//   pm2 startup       ← auto-start on server boot (follow the printed instruction)
//
// Useful commands:
//   pm2 logs altshortbot        ← live log tail
//   pm2 status                  ← process health
//   pm2 stop altshortbot        ← stop scanner
//   pm2 restart altshortbot     ← restart now
//   pm2 delete altshortbot      ← remove from PM2

module.exports = {
  apps: [
    {
      name: "altshortbot",

      // Run once and exit — PM2 restarts on cron schedule
      script: "npx",
      args:   "tsx live_scanner.ts",

      // Restart every hour at :05 past (gives exchanges 5 min after settlement)
      cron_restart: "5 * * * *",

      // Don't auto-restart on crash between scheduled runs
      // (next cron tick will start a fresh run anyway)
      autorestart: false,

      // Log config
      out_file:   "logs/scanner.log",
      error_file: "logs/scanner-error.log",
      time:       true,   // prepend timestamps to log lines

      // Environment — set your Telegram credentials here OR export them in shell
      env: {
        NODE_ENV:          "production",
        TELEGRAM_TOKEN:    process.env.TELEGRAM_TOKEN    ?? "",
        TELEGRAM_CHAT_ID:  process.env.TELEGRAM_CHAT_ID ?? "",
        // Optional: override watchlist
        // SCANNER_COINS: "ORDI,KNC,HIVE,HYPER,ENJ",
      },
    },
  ],
};
