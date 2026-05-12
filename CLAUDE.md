# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

AltShortBot is a two-process trading bot for shorting overheated altcoin perpetuals on Hyperliquid. The architecture is split intentionally:

- **Scanner** (`live_scanner.ts`) — runs hourly, scans every active Bybit USDT perp, detects signals, sends Telegram alerts, and writes tradeable signals to `signal_queue.json`.
- **Executor** (`hl_executor.ts`) — runs every 5 minutes, reads and clears the queue, places real or paper shorts on Hyperliquid, manages open positions, sends Telegram updates.

The two communicate **only** via JSON files on disk (`signal_queue.json`, `hl_positions.json`). They never share memory and never call each other directly.

PM2 runs them as `altshortbot-scanner` (cron `5 * * * *`) and `altshortbot-executor` (cron `*/5 * * * *`). The executor ships with `--paper` baked into `ecosystem.config.js` — flipping to live is a one-line edit.

## The plan is the spec

`ALTSHORTBOT_COMPLETE_PLAN.md` is the authoritative implementation guide, broken into 11 numbered stages. Always read the relevant stage before writing code — the plan calls out exact integration points, the JSON schema between processes, and risk parameters that have been tuned.

See the **Plan deviations summary** section at the bottom of this file for all intentional departures from the plan.

## Common commands

```bash
# ─── Scanner ────────────────────────────────────────────────────────────────
npx tsx live_scanner.ts                              # full Bybit universe
npx tsx live_scanner.ts --coins ORDI --dry-run       # single coin, no queue write
npx tsx live_scanner.ts --watch                      # dev only; PM2 handles prod

# ─── Executor (paper mode short-circuits all order code paths) ──────────────
npx tsx hl_executor.ts --paper                       # simulate trades
npx tsx hl_executor.ts --paper --status              # open positions + paper P&L
npx tsx hl_executor.ts                               # LIVE — real orders

# ─── Backtest + regression tests ────────────────────────────────────────────
npx tsx backtest_signals.ts --coin ORDI --days 60 --chart   # Bybit default (see header for validated CLI)
npx tsx backtest_signals.ts --coin ORDI --source binance     # legacy Binance candles
npx tsx backtest_test.ts                             # all coins (uses --source binance + fixtures)
npx tsx backtest_test.ts ORDI                        # single coin
npx tsx backtest_test.ts --update-fixtures           # re-capture from live API
npx tsx scanner_test.ts                              # live-scanner regression on fixtures
npx tsx scanner_test.ts KNC                          # single coin

# ─── Competitor trade verification ──────────────────────────────────────────
npx tsx verify_competitor_trades.ts                  # uses --source bybit (merged funding)

# ─── Building signal P&L monitor (Strategy B) ───────────────────────────────
npx tsx check_building_signals.ts                    # active signals + live P&L
npx tsx check_building_signals.ts --all              # include expired (>48h)
npx tsx check_building_signals.ts --seed             # seed today's signals from SEED_SIGNALS

# ─── Type-check ──────────────────────────────────────────────────────────────
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  --lib es2022,dom \
  hl_executor.ts shared_types.ts live_scanner.ts scanner_test.ts
```

PM2 (production): `pm2 start ecosystem.config.js && pm2 save && pm2 startup`. Stage 11 in `ALTSHORTBOT_COMPLETE_PLAN.md` has the full first-boot and going-live runbook.

## Validated signal parameters

These are the tuned parameters currently live in `PARAMS` in `live_scanner.ts` and used as the default CLI in `backtest_signals.ts`. Do **not** change them without re-running the backtest across all 10 validated coins (HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH, ENA) and confirming win rates hold.

```
--threshold 10 --min-positive 2 --min-oi 2 --max-price 2
--pump-pct 19 --pump-vol 5 --pump-rsi 88 --pump-funding 0
--squeeze-pct 20 --squeeze-hours 10 --squeeze-funding -100 --squeeze-oi-drop 0
--exhaust-funding -20 --exhaust-oi-drop 3 --lookahead 48
```

`--pump-pct 19` (not 25) was validated against Bybit data across all 10 coins: no false positives added, two new high-quality pump-top signals recovered (HYPER 100%, WIF 100%).

## Architecture notes that aren't obvious from one file

### Backtest vs live scanner — data sources

Both use **Bybit candles**. Funding comes from **both Bybit and Binance merged**, taking the most extreme (highest absolute) rate per hour. This matters because some coins (HYPER, SPK) show more extreme negative funding on Binance during squeezes — Bybit-only would miss those TREND_BREAK signals entirely.

`backtest_signals.ts --source bybit` (the default): Bybit candles + merged Bybit/Binance funding + Bybit OI.
`backtest_signals.ts --source binance`: Binance candles + merged Bybit/Binance funding + Binance OI. Used for `backtest_test.ts` fixture compatibility only.
`backtest_signals.ts --source hl`: Hyperliquid candles + Hyperliquid funding. No OI data, Gate 2 disabled.

`backtest_test.ts` passes `--source binance` explicitly because its fixtures were captured on Binance data. To migrate to Bybit fixtures: delete `fixtures/` and re-run — but this will change signal expectations.

### Gap-fill semantics — why live signals can differ from backtest

Bybit settles funding every 4h or 8h. Between settlements, the backtest zero-fills non-settlement hours (see `mergeToHighestFunding` in `backtest_signals.ts`). The live scanner forward-fills the last known settlement rate (`buildMergedFundingByHour`).

During a deep squeeze at -1500% APR, the backtest's zero-fill makes `fundingApr` appear to normalise at every non-settlement hour, which can satisfy the EXHAUSTION condition (`-20 < apr < 5`) and fire false EXHAUSTION alerts. The live scanner's forward-fill keeps the rate at -1500% throughout, correctly blocking these.

**Consequence:** backtest EXHAUSTION signals (including `backtest_test.ts` expectations) may not transfer to live behaviour. `scanner_test.ts` is calibrated to actual live-scanner output and is the reliable reference.

### Signal types, confidence, and what gets queued

Five signal types fire from `scanCoin()`:

| Type          | Telegram        | Queue                      | Condition                                      |
| ------------- | --------------- | -------------------------- | ---------------------------------------------- |
| `FUNDING`     | ❌ console only | ❌                         | Gate 1 passes (broad-market regime noise)      |
| `PUMP_TOP`    | ✅              | ❌                         | Large candle + volume + RSI + positive funding |
| `BUILDING`    | ✅              | ✅ if `fundingApr ≤ -200%` | Squeeze active, funding extreme                |
| `EXHAUSTION`  | ✅              | ✅ if HIGH or MEDIUM       | Squeeze ending                                 |
| `TREND_BREAK` | ✅              | ✅ always                  | Blow-off top during uptrend                    |

The `-200% APR` threshold for BUILDING was validated against 10 days of live paper signals: 9/9 winners at ≤ -200% (avg +11% at 1×, +33% at 3×). Signals above -200% APR (e.g. -100%) entered mega-squeezes that ran 80%+ further before reversing.

FUNDING is console-only to prevent broad-market regimes from producing 300+ alerts/scan and flooding Telegram. It never affects positions.

### BUILDING re-fire on intensification

`scanCoin()` tracks `lastBuildingFundingApr` in `CoinState`. Once a BUILDING fires, it normally won't fire again for the same squeeze wave (`waveAlertedBuilding = true`). Exception: if funding becomes **2× more extreme** than when the signal last fired, it re-fires with an `(intensified from X%)` note in the details string.

Example: BUILDING fires at -300% APR → `lastBuildingFundingApr = -300`. Next scan at -650% APR: `-650 < -300 × 2 = -600` → re-fires as a better entry. `lastBuildingFundingApr` resets to 0 when the squeeze wave ends (`!sq.triggered`).

This is controlled by `BUILDING_REFIRE_MULTIPLIER = 2.0` at the top of `live_scanner.ts`.

### Scanner state fields are conditional

`scanner_state.json` persists wave-tracking metadata across hourly runs. An all-null/all-default coin entry is **expected** for a calm coin — not a bug. Only investigate if a coin known to be mid-wave shows defaults.

Fields that reset when `!sq.triggered` (wave ends): `squeezeWaveStartMs`, `squeezeWaveHighPrice`, `waveAlertedBuilding`, `lastBuildingFundingApr`, `lastExhaustionMs`.

Fields that **persist across wave resets**: `lastBuildingMinFunding` (needed by `TREND_BREAK` to remember how negative prior funding got) and `waveAlertedTrendBreak` (resets on trend exit, not wave exit).

### Fixtures and scanner_test.ts

`fixtures/<COIN>.json` holds `candles`, `fundingBybit`, `fundingBinance`, and `oi` arrays captured from live exchanges. Both `backtest_test.ts` and `scanner_test.ts` replay these for deterministic tests. Refresh with `--update-fixtures` only when the algorithm has intentionally changed.

`scanner_test.ts` expectations are calibrated to live-scanner forward-fill output — not to the backtest or to the plan's Stage 2 signal list (which was authored against backtest zero-fill behaviour). Don't "fix" failing tests by importing the plan's `mustInclude` list.

The Bybit `/open-interest` endpoint caps at ~200 records (~8 days). Signals gated by OI (EXHAUSTION with `--exhaust-oi-drop 3`, Gate 2 FUNDING) cannot fire for events older than that window in the backtest.

### Shared types live in shared_types.ts

`Alert`, `QueuedSignal`, `PositionRecord`, `PositionStore`, `PaperTrade` are defined once in `shared_types.ts` and imported by both scanner and executor. `signalType` in `PositionRecord` is `"EXHAUSTION" | "TREND_BREAK" | "BUILDING"` — all three are now tradeable.

## Executor mechanics that aren't obvious

### Position sizing risks 2% of account, not 6%

`calcPositionSize` uses `notional = riskUsd / stopLossPct` ($1,667 notional on a $10k account = $200 loss at the 12% stop = 2% of account). The plan's formula (`notional = marginUsed × maxLeverage`) would risk 6%. This is an intentional policy choice.

Leverage does not enter sizing — it determines margin posted but not dollar loss at stop. `RISK.maxLeverage` is used only by `updateLeverage`.

### updateLeverage fires before every entry

`openShort` calls `updateLeverage` before placing the IOC order, clamped to `min(RISK.maxLeverage, asset.maxLeverage)`. Without this, Hyperliquid's per-asset default leverage (up to 20×) can place the liquidation price inside the stop loss. If `updateLeverage` fails, the order is not placed and a Telegram alert fires.

### Paper mode short-circuits everything

Every order helper starts with `if (IS_PAPER) return`. Paper P&L reveals nothing about whether SDK signing, `formatPrice`, or order-status parsing work. **Testnet is the first time those run.** See plan Stage 11 for the mandatory `HL_TESTNET=1` step before going live.

### About half of Bybit signals never trade

The scanner covers ~400 Bybit USDT perps; Hyperliquid lists ~230. The executor logs `coin: not listed on Hyperliquid` for the rest. Expected, not a bug.

### Operational errors fan out to Telegram

`alertError(context, err)` writes to stderr and sends a `🚨` Telegram alert. Wired through: top-level crashes, `openShort`/`placeStopLoss`/`cancelOrder`/`closePosition` failures, `fetchAccountState` failure, `managePositions` reconciliation failure, `updateLeverage` failure.

### Queue file races

`signal_queue.json` uses non-atomic read-modify-write. Both processes wrap `JSON.parse` in try/catch returning `[]` on failure (handles truncated reads). The scanner-appends-between-read-and-clear race is not handled — a signal can be lost or double-processed in a sub-second window. Accepted tradeoff per plan Critical Note #1.

## Environment

Required (always): `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
Required for live executor: `HL_WALLET_ADDRESS`, `HL_AGENT_KEY`.
Optional: `HL_TESTNET=1`, `HL_PAPER_ACCOUNT` (default $10,000), `SCANNER_COINS`.

The agent key vs main key split is the load-bearing safety property — only the agent key sits on the VPS, only it can be lost if the box is compromised, and it can be revoked at `app.hyperliquid.xyz → Settings → API`. The main key never touches this codebase.

## Plan deviations summary

| Where                   | Plan                                                 | Shipped                                                                                     | Rationale                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 5 `formatPrice`   | `.toFixed(4)`                                        | SDK `formatPrice` from `@nktkas/hyperliquid/utils`                                          | Hard-coded 4dp fails HL validation for `szDecimals ≥ 3`                                                                                                   |
| Stage 5 `HttpTransport` | `{ url: API_URL }`                                   | `{ isTestnet: IS_TESTNET }`                                                                 | Plan option name doesn't exist on the SDK                                                                                                                 |
| Stage 5 `openShort`     | 4 args, no leverage management                       | 6 args; calls `updateLeverage` first; Telegram on failure                                   | HL leverage is per-position-at-entry; without setting, liq can fire before stop                                                                           |
| Stage 6 sizing math     | `notional = marginUsed × maxLeverage` (6% real risk) | `notional = riskUsd / stopLossPct` (2% real risk)                                           | Plan formula contradicted its own variable name                                                                                                           |
| Stage 6 size precision  | `Math.min(szDecimals, 4)` cap                        | full `szDecimals` (SDK handles it)                                                          | Cap was paranoia; SDK truncates correctly                                                                                                                 |
| Stage 8 `closeReason`   | `string` + `as any` cast                             | typed union `"stop"\|"target"\|"trailing"\|"timeout"`                                       | Drop the cast, catch typos at compile time                                                                                                                |
| Stage 10 PM2 name       | `altshortbot`                                        | `altshortbot-scanner` + `altshortbot-executor`                                              | Two processes need distinct names                                                                                                                         |
| Post-validation         | `--pump-pct 25`                                      | `--pump-pct 19`                                                                             | Validated on Bybit data across 10 coins — recovers HYPER/WIF pump-tops with no false positives added                                                      |
| Post-validation         | Backtest default: Binance candles                    | Backtest default (`--source bybit`): Bybit candles + merged Bybit/Binance funding           | Matches live scanner data source; `--source binance` retained for fixture compatibility                                                                   |
| Post-validation         | Live scanner: Bybit funding only                     | Live scanner: merged Bybit + Binance funding (most extreme per hour)                        | Bybit-only misses HYPER/SPK TREND_BREAK signals which only appear in Binance funding data                                                                 |
| Post-validation         | `TRADEABLE = {EXHAUSTION, TREND_BREAK}`              | `+ BUILDING` when `fundingApr ≤ -200% APR`                                                  | 10-day paper observation: BUILDING at ≤ -200% produced 9/9 winners (~+11% at 1×). Above -200% entered mega-squeezes running 80%+ further before reversing |
| Post-validation         | BUILDING fires once per wave                         | BUILDING re-fires when funding becomes 2× more extreme (`BUILDING_REFIRE_MULTIPLIER = 2.0`) | Captures better entries when a squeeze intensifies after the initial alert                                                                                |
| Post-validation         | All alerts → Telegram                                | FUNDING is console-only                                                                     | Broad-market regimes produce 300+ FUNDING/scan, flooding chat. FUNDING never affects positions                                                            |
| Post-validation         | `--dry-run` suppresses Telegram                      | `--dry-run` suppresses queue writes; Telegram fires normally                                | A dry run the executor would still trade from is not dry                                                                                                  |
| Post-validation         | `console.error` only                                 | `alertError()` → stderr + Telegram for high-stakes paths                                    | Silent failures during live operation were unobservable without tailing logs                                                                              |
| Post-validation         | `signalType: "EXHAUSTION"\|"TREND_BREAK"`            | `+ "BUILDING"` in `shared_types.ts`                                                         | Widened to match runtime values after BUILDING became tradeable                                                                                           |
