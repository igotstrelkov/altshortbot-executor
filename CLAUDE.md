# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

AltShortBot is a two-process trading bot for shorting overheated altcoin perpetuals on Hyperliquid. The architecture is split intentionally:

- **Scanner** (`live_scanner.ts`) — runs hourly, scans every active Bybit USDT perp, detects signals, sends Telegram alerts, and writes tradeable signals to `signal_queue.json`.
- **Executor** (`hl_executor.ts`, not yet built) — runs every 5 minutes, reads and clears the queue, places real or paper shorts on Hyperliquid, manages open positions.

The two communicate **only** via JSON files on disk (`signal_queue.json`, `hl_positions.json`). They never share memory and never call each other directly.

## The plan is the spec

[ALTSHORTBOT_COMPLETE_PLAN.md](ALTSHORTBOT_COMPLETE_PLAN.md) is the authoritative implementation guide, broken into 11 numbered stages. Always read the relevant stage before writing code — the plan calls out exact integration points, the JSON schema between processes, and risk parameters that have been tuned.

The plan also explicitly forbids rebuilding `backtest_signals.ts`, `backtest_test.ts`, `live_scanner.ts`, `ecosystem.config.js`, and `fixtures/` from scratch. Only the modifications named in Stages 1, 2e, and 10 are allowed against those files.

## Common commands

```bash
# Scanner — production-style run against full Bybit universe
npx tsx live_scanner.ts

# Scanner — single coin, no Telegram (best for development)
npx tsx live_scanner.ts --coins ORDI --dry-run

# Scanner — run every hour on the hour (used in dev; PM2 handles this in prod)
npx tsx live_scanner.ts --watch

# Backtest — replay historical Bybit+Binance data with tuned params (see header
# of backtest_signals.ts for the full validated CLI)
npx tsx backtest_signals.ts --coin ORDI --days 30 --chart

# Regression tests — replay captured API fixtures and assert known-good signals
npx tsx backtest_test.ts            # all coins
npx tsx backtest_test.ts ORDI       # single coin
npx tsx backtest_test.ts --update-fixtures   # re-capture from live API

# Type check (no tsconfig.json — pass flags explicitly)
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
  --strict --allowImportingTsExtensions --types node --lib es2022,dom \
  live_scanner.ts shared_types.ts
```

PM2 (production): `pm2 start ecosystem.config.js && pm2 save`. Scanner cron is `5 * * * *` (5 minutes after the hour, giving exchanges time to settle funding).

## Architecture notes that aren't obvious from one file

### Backtest vs live scanner are two separate codepaths

`backtest_signals.ts` and `live_scanner.ts` independently implement the same signal logic. Parameters in `live_scanner.ts` (the `PARAMS` object) are the **validated set** from backtest tuning across HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH. Do **not** tune `PARAMS` directly without first re-running the backtest and the fixture regression tests — the values are co-dependent and tuned together.

Two real divergences worth knowing about:

1. **Funding source**. Backtest merges Binance + Bybit (largest absolute value per hour); live scanner is Bybit-only. This turns out to be cosmetic on the validated coin set — both venues agree on direction during squeezes — so it does not explain signal-count differences.

2. **Gap-fill semantics — this *does* explain signal differences.** Bybit settles every 4h or 8h. Between settlements:
   - **Backtest** zero-fills (see warning comment in `backtest_signals.ts` near `mergeToHighestFunding`).
   - **Live scanner** forward-fills the last settlement rate (`buildFundingByHour`).

   During a deep squeeze with funding at -1500%, the backtest's zero-fill makes `fundingApr` flip to 0 at every non-settlement hour, which satisfies the EXHAUSTION conjunction (`-20 < apr < 5`) and fires alerts that look like "funding normalised" but are actually post-settlement gaps inside an active squeeze. Those alerts coincide with squeeze peaks by timing coincidence (settlement cadence aligns with the move). The live scanner does not fire these — its forward-fill keeps the rate at -1500% throughout the gap, blocking false EXHAUSTION.

   **Consequence:** `backtest_test.ts` EXHAUSTION assertions (e.g. KNC at 2026-05-02 09:00) rely on this artifact and **do not transfer to live behaviour**. `scanner_test.ts` is calibrated to actual live-scanner output, which is sparser but semantically truthful. Backtest EXHAUSTION win-rate numbers should be treated with skepticism for the same reason — the timing is real, the stated cause is not.

### Signal types, confidence, and what gets queued

Five signal types fire from `scanCoin()`: `FUNDING`, `PUMP_TOP`, `BUILDING`, `EXHAUSTION`, `TREND_BREAK`. Only the last two are tradeable — and only at HIGH/MEDIUM confidence. Everything else (including all LOW-confidence EXHAUSTION) is Telegram-only by design. The queue-write filter lives in `live_scanner.ts` main loop and is intentional, not a bug.

Confidence is computed in `getConfidence()`:
- `TREND_BREAK` → always HIGH.
- `BUILDING` → always MEDIUM (not tradeable on its own — informational).
- `EXHAUSTION` → HIGH if a BUILDING fired ≥6h ago, MEDIUM if 2–6h, LOW otherwise. The gap between BUILDING and EXHAUSTION is the strongest available proxy for squeeze maturity.

### scanner_state.json fields are conditional

The state file persists wave-tracking metadata across hourly runs. Most fields stay at their `defaultState()` values until their specific condition fires, and several get reset to defaults when `!sq.triggered` (no active squeeze). An all-null/all-default coin entry is the **expected** shape for a calm coin — it's not a bug or an empty run. Only investigate if a coin you know is mid-wave shows defaults.

`lastBuildingMinFunding` is the one field that persists across wave resets — it's how `TREND_BREAK` detection remembers how negative funding got during the prior building phase. Don't reset it in the wave-cleanup branch.

### Shared types live in shared_types.ts

`Alert`, `QueuedSignal`, `PositionRecord`, `PositionStore`, `PaperTrade` are defined once in [shared_types.ts](shared_types.ts) and imported by both scanner and (eventually) executor. The scanner used to define `Alert` locally — that's been removed; don't re-introduce it.

### Fixtures are captured API snapshots

`fixtures/<COIN>.json` files hold `candles`, `fundingBybit`, and `oi` arrays captured from live Bybit. `backtest_test.ts` and the planned `scanner_test.ts` both replay these for deterministic tests. Refresh with `--update-fixtures` only when the algorithm has intentionally changed and old fixtures' expectations no longer hold.

## Environment

Required: `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
For executor (Stages 3+): `HL_WALLET_ADDRESS`, `HL_AGENT_KEY`, optionally `HL_TESTNET=1`, `HL_PAPER_ACCOUNT`.

The Hyperliquid agent key is a separate wallet approved at app.hyperliquid.xyz → Settings → API. The main private key holding USDC must never be deployed to the VPS.
