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
npx tsx scanner_test.ts                              # live-scanner regression — run before every deploy
npx tsx scanner_test.ts KNC                          # single coin

# ─── Gate simulation — run whenever gate thresholds change ──────────────────
npx tsx simulate_gates.ts                            # verify known winners still pass all gates
npx tsx simulate_gates.ts --days 30                  # wider window for older signals

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

**Minimum pre-deploy checklist:**

```bash
npx tsx scanner_test.ts    # always — tests production scanner logic
npx tsx simulate_gates.ts  # always — ensures gates don't block known winners
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

| Type          | Telegram        | Queue                | Condition                                      |
| ------------- | --------------- | -------------------- | ---------------------------------------------- |
| `FUNDING`     | ❌ console only | ❌                   | Gate 1 passes (broad-market regime noise)      |
| `PUMP_TOP`    | ✅              | ❌                   | Large candle + volume + RSI + positive funding |
| `BUILDING`    | ✅              | ✅ see gates below   | Squeeze active, funding extreme                |
| `EXHAUSTION`  | ✅              | ✅ if HIGH or MEDIUM | Squeeze ending                                 |
| `TREND_BREAK` | ✅              | ✅ always            | Blow-off top during uptrend                    |

**BUILDING queue gates** — all three must pass:

1. `fundingApr ≤ -200%` — funding must be extreme (calibrated: above -200% entered mega-squeezes)
2. `oiDropPct ≥ BUILDING_OI_RISING_MAX (-150%)` — OI must not be rising strongly; calibrated so SOLAYER (-103.7% OI) passes and SOLV (-182.9% OI) is blocked
3. `!recentPumpTop` — no PUMP_TOP in prior `PUMP_TOP_COOLDOWN_H` hours (**currently 0 = disabled**; only one supporting data point; re-enable when more evidence accumulates)

FUNDING is console-only to prevent broad-market regimes from flooding Telegram. It never affects positions.

### BUILDING re-fire on intensification

`scanCoin()` tracks `lastBuildingFundingApr` in `CoinState`. Once a BUILDING fires, it won't fire again for the same squeeze wave unless funding becomes **2× more extreme** than when it last fired. Re-fires include `(intensified from X%)` in the details.

Controlled by `BUILDING_REFIRE_MULTIPLIER = 2.0`. `lastBuildingFundingApr` resets to 0 when the squeeze wave ends.

### Scanner state fields are conditional

`scanner_state.json` persists wave-tracking metadata across hourly runs. An all-null/all-default coin entry is **expected** for a calm coin — not a bug.

Fields that reset when `!sq.triggered` (wave ends): `squeezeWaveStartMs`, `squeezeWaveHighPrice`, `waveAlertedBuilding`, `lastBuildingFundingApr`, `lastExhaustionMs`.

Fields that **persist across wave resets**: `lastBuildingMinFunding` (needed by `TREND_BREAK` to remember how negative prior funding got), `waveAlertedTrendBreak` (resets on trend exit), `lastPumpTopMs` (persists until overwritten by a new PUMP_TOP — harmless while `PUMP_TOP_COOLDOWN_H = 0`).

### Shared types live in shared_types.ts

`Alert`, `QueuedSignal`, `PositionRecord`, `PositionStore`, `PaperTrade` are defined once in `shared_types.ts` and imported by both scanner and executor.

`Alert` carries two optional diagnostic fields set only for BUILDING signals:

- `oiDropPct?: number` — positive = OI dropped, negative = OI rose (squeeze still building)
- `recentPumpTop?: boolean` — true if a PUMP_TOP fired within `PUMP_TOP_COOLDOWN_H` hours

`signalType` in `PositionRecord` is `"EXHAUSTION" | "TREND_BREAK" | "BUILDING"` — all three are tradeable.

### Fixtures and scanner_test.ts

`fixtures/<COIN>.json` holds `candles`, `fundingBybit`, `fundingBinance`, and `oi` arrays. Both `backtest_test.ts` and `scanner_test.ts` replay these for deterministic tests. Refresh with `--update-fixtures` only when the algorithm has intentionally changed.

`scanner_test.ts` expectations are calibrated to live-scanner forward-fill output. Don't fix failing tests by importing the plan's `mustInclude` list.

The Bybit `/open-interest` endpoint caps at ~200 records (~8 days). Signals gated by OI cannot fire for events older than that window.

## Executor mechanics that aren't obvious

### Position sizing risks 2% of account, not 6%

`calcPositionSize` uses `notional = riskUsd / stopLossPct` ($1,667 notional on a $10k account = $200 loss at the 12% stop = 2% of account). The plan's formula would risk 6%. Intentional policy choice.

Leverage does not enter sizing — it determines margin posted but not dollar loss at stop. `RISK.maxLeverage` is used only by `updateLeverage`.

### updateLeverage fires before every entry

`openShort` calls `updateLeverage` before placing the IOC order, clamped to `min(RISK.maxLeverage, asset.maxLeverage)`. Without this, Hyperliquid's per-asset default leverage can place the liquidation price inside the stop loss. If `updateLeverage` fails, the order is not placed and a Telegram alert fires.

### Paper mode short-circuits everything

Every order helper starts with `if (IS_PAPER) return`. Testnet is the first time SDK signing, `formatPrice`, and order-status parsing actually run. See plan Stage 11 for the mandatory `HL_TESTNET=1` step before going live.

### About half of Bybit signals never trade

The scanner covers ~400 Bybit USDT perps; Hyperliquid lists ~230. The executor logs `coin: not listed on Hyperliquid` for the rest. Expected, not a bug.

### Operational errors fan out to Telegram

`alertError(context, err)` writes to stderr and sends a `🚨` Telegram alert. Wired through: top-level crashes, order helper failures, `fetchAccountState` failure, `managePositions` reconciliation failure, `updateLeverage` failure.

### Queue file races

`signal_queue.json` uses non-atomic read-modify-write. Both processes wrap `JSON.parse` in try/catch returning `[]` on failure. The scanner-appends-between-read-and-clear race is accepted per plan Critical Note #1.

## Environment

Required (always): `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
Required for live executor: `HL_WALLET_ADDRESS`, `HL_AGENT_KEY`.
Optional: `HL_TESTNET=1`, `HL_PAPER_ACCOUNT` (default $10,000), `SCANNER_COINS`.

The agent key vs main key split is the load-bearing safety property — only the agent key sits on the VPS and can be revoked at `app.hyperliquid.xyz → Settings → API`. The main key never touches this codebase.

## Plan deviations summary

| Where                   | Plan                                                 | Shipped                                                                            | Rationale                                                                                                                                          |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 5 `formatPrice`   | `.toFixed(4)`                                        | SDK `formatPrice` from `@nktkas/hyperliquid/utils`                                 | Hard-coded 4dp fails HL validation for `szDecimals ≥ 3`                                                                                            |
| Stage 5 `HttpTransport` | `{ url: API_URL }`                                   | `{ isTestnet: IS_TESTNET }`                                                        | Plan option name doesn't exist on the SDK                                                                                                          |
| Stage 5 `openShort`     | 4 args, no leverage management                       | 6 args; calls `updateLeverage` first; Telegram on failure                          | HL leverage is per-position-at-entry; without setting, liq can fire before stop                                                                    |
| Stage 6 sizing math     | `notional = marginUsed × maxLeverage` (6% real risk) | `notional = riskUsd / stopLossPct` (2% real risk)                                  | Plan formula contradicted its own variable name                                                                                                    |
| Stage 6 size precision  | `Math.min(szDecimals, 4)` cap                        | full `szDecimals` (SDK handles it)                                                 | Cap was paranoia; SDK truncates correctly                                                                                                          |
| Stage 8 `closeReason`   | `string` + `as any` cast                             | typed union `"stop"\|"target"\|"trailing"\|"timeout"`                              | Drop the cast, catch typos at compile time                                                                                                         |
| Stage 10 PM2 name       | `altshortbot`                                        | `altshortbot-scanner` + `altshortbot-executor`                                     | Two processes need distinct names                                                                                                                  |
| Post-validation         | `--pump-pct 25`                                      | `--pump-pct 19`                                                                    | Validated on Bybit data across 10 coins — recovers HYPER/WIF pump-tops with no false positives                                                     |
| Post-validation         | Backtest default: Binance candles                    | Backtest default (`--source bybit`): Bybit candles + merged Bybit/Binance funding  | Matches live scanner data source                                                                                                                   |
| Post-validation         | Live scanner: Bybit funding only                     | Live scanner: merged Bybit + Binance funding (most extreme per hour)               | Bybit-only misses HYPER/SPK TREND_BREAK signals                                                                                                    |
| Post-validation         | `TRADEABLE = {EXHAUSTION, TREND_BREAK}`              | `+ BUILDING` when all three queue gates pass                                       | 10-day paper: BUILDING ≤ -200% → 9/9 winners (~+11% at 1×)                                                                                         |
| Post-validation         | BUILDING fires once per wave                         | Re-fires when funding becomes 2× more extreme (`BUILDING_REFIRE_MULTIPLIER = 2.0`) | Captures better entries when a squeeze intensifies                                                                                                 |
| Post-validation         | All alerts → Telegram                                | FUNDING is console-only                                                            | 300+ FUNDING/scan in broad regimes would flood chat                                                                                                |
| Post-validation         | `--dry-run` suppresses Telegram                      | Suppresses queue writes + building log; Telegram fires normally                    | A dry run the executor would still trade from is not dry                                                                                           |
| Post-validation         | `console.error` only                                 | `alertError()` → stderr + Telegram                                                 | Silent failures were unobservable without tailing logs                                                                                             |
| Post-validation         | `signalType: "EXHAUSTION"\|"TREND_BREAK"`            | `+ "BUILDING"` in `shared_types.ts`                                                | Widened after BUILDING became tradeable                                                                                                            |
| Post-validation         | No BUILDING queue gates beyond funding               | `BUILDING_OI_RISING_MAX = -150` (OI gate)                                          | Live data: SOLAYER (-103.7% OI) won +16.86% → passes; SOLV (-182.9% OI) neutral → blocked. -150% calibrated between both                           |
| Post-validation         | No pump-top awareness                                | `PUMP_TOP_COOLDOWN_H = 0` (disabled)                                               | Added for ENJ Apr 8 case but blocked XION (+9.30%) and 1000XEC (+13.79%). Disabled — re-enable with a calibrated window when more cases accumulate |
