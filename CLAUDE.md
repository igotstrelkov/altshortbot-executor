# CLAUDE.md

This file is read by Claude Code at the start of every session. It describes the complete current state of the repository — architecture, file purposes, rules, and operational knowledge.

---

## What this project does

AltShortBot detects short squeeze signals on Bybit USDT perpetuals and executes short trades. Two PM2 processes:

- **Scanner** (`live_scanner.ts`) — runs every 15 min, scans ~400 Bybit USDT perps, detects signals, sends Telegram alerts, writes tradeable signals to `signal_queue.json`
- **Executor** (`bybit_executor.ts`) — runs every 5 min, reads queue, opens/manages shorts on Bybit (demo or live), sends Telegram updates

Communication is **file-only**: `signal_queue.json` and `bybit_positions.json`. No shared memory, no direct calls between processes.

**Why Bybit (not Hyperliquid):** Scanner uses Bybit data. Only ~14% of signals were listed on Hyperliquid. All signals are executable on Bybit.

---

## File map

### Production (do not rebuild from scratch)

| File                  | Role                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `live_scanner.ts`     | Scanner — signal detection, Telegram alerts, queue writes                |
| `bybit_executor.ts`   | Executor — order placement, position management, stop tracking           |
| `shared_types.ts`     | Shared TypeScript interfaces (Alert, QueuedSignal, PositionRecord, etc.) |
| `ecosystem.config.js` | PM2 process config for scanner + executor                                |

### Research tools (read-only from production perspective)

| File                          | Role                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `backtest_signals.ts`         | Offline signal backtester — not used in production                             |
| `verify_competitor_trades.ts` | Validates signals against known competitor trades — periodic research          |
| `check_building_signals.ts`   | Manual P&L monitor for scanner signals — not used in production                |
| `check_executor_positions.ts` | P&L monitor for executor positions — reads `bybit_positions.json`              |
| `check_near_misses.ts`        | Near-miss analysis — shows coins that almost triggered for 15m candle research |

### Test suite

| File                   | Role                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `test.ts`              | Pre-deploy wrapper — runs scanner_test + simulate_gates            |
| `scanner_test.ts`      | Regression tests for `live_scanner.ts` using fixtures              |
| `simulate_gates.ts`    | Asserts known signals pass/block gates correctly                   |
| `backtest_test.ts`     | Regression tests for `backtest_signals.ts` using fixtures          |
| `fixtures/<COIN>.json` | Deterministic test data: candles, fundingBybit, fundingBinance, oi |

### State files (runtime, not source)

| File                   | Written by | Purpose                                                                   |
| ---------------------- | ---------- | ------------------------------------------------------------------------- |
| `signal_queue.json`    | Scanner    | Signals pending execution — cleared by executor after equity check        |
| `scanner_state.json`   | Scanner    | Per-coin wave state across hourly runs                                    |
| `bybit_positions.json` | Executor   | Open and closed positions, paper equity                                   |
| `building_log.jsonl`   | Scanner    | Append-only log of every BUILDING signal for monitoring                   |
| `near_miss.jsonl`      | Scanner    | Coins that hit 15-19% cumulative but didn't trigger — 15m candle analysis |

---

## ⚠️ Do not rules

These are the most common ways to break the system:

1. **Do not change `PARAMS` in `live_scanner.ts`** without re-running the backtest across all 10 validated coins (HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH, ENA) and confirming win rates hold.

2. **Do not change `BUILDING_OI_RISING_MAX` or `BUILDING_REFIRE_MULTIPLIER`** without updating `simulate_gates.ts` and re-running — the constants are imported directly so the test will catch drift automatically.

3. **Do not clear `signal_queue.json` before confirming `fetchAccountEquity` succeeds** — the `clearQueue()` call in `main()` must come after the equity check, not before.

4. **Do not set `demoTrading: false`** in the RestClientV5 client without an explicit decision to go live. This is the single gate between demo and real money.

5. **Do not rebuild `backtest_signals.ts`, `backtest_test.ts`, or `fixtures/`** from scratch — fixture expectations are calibrated to specific behaviour.

6. **Do not add `console.log` calls to the scanner's main scan loop** without checking if `--dry-run` suppresses them — the `logBuildingSignal` call checks `!DRY_RUN`.

---

## Testing workflow

**Before every deploy:**

```bash
npx tsx test.ts          # scanner_test + simulate_gates — must pass
```

**When changing detection parameters:**

```bash
npx tsx test.ts --all    # also runs backtest_test
```

**When changing gate thresholds:**

```bash
npx tsx simulate_gates.ts   # confirms known signals still pass/block correctly
```

**When changing scanner logic:**

```bash
npx tsx scanner_test.ts     # 8 fixture-based tests
```

---

## Common commands

```bash
# ─── Scanner ────────────────────────────────────────────────────────────────
npx tsx live_scanner.ts                           # full Bybit universe (~400 coins)
npx tsx live_scanner.ts --coins ORDI              # single coin, writes queue + Telegram
npx tsx live_scanner.ts --coins ORDI --dry-run    # single coin, no queue write, Telegram fires
npx tsx live_scanner.ts --watch                   # dev only; PM2 handles prod

# ─── Executor ───────────────────────────────────────────────────────────────
npx tsx bybit_executor.ts --paper                 # paper simulation (no Bybit orders)
npx tsx bybit_executor.ts --paper --status        # paper positions + P&L
npx tsx bybit_executor.ts --status                # demo/live positions + P&L
npx tsx bybit_executor.ts                         # demo/live — places real orders

# ─── Monitors ───────────────────────────────────────────────────────────────
npx tsx check_executor_positions.ts               # open + last 10 closed executor positions
npx tsx check_executor_positions.ts --all         # all closed
npx tsx check_executor_positions.ts --open        # open only
npx tsx check_building_signals.ts                 # scanner signal P&L (manual monitor)
npx tsx check_building_signals.ts --all           # include expired >48h
npx tsx check_near_misses.ts                      # coins that almost triggered (15-19% cumul.)
npx tsx check_near_misses.ts --days 7             # last 7 days of near-misses
npx tsx check_near_misses.ts --all                # all time

# ─── PM2 ────────────────────────────────────────────────────────────────────
pm2 status                                        # process health
pm2 restart all                                   # restart both processes
pm2 restart altshortbot-scanner                   # restart scanner only
pm2 restart altshortbot-executor                  # restart executor only
pm2 logs altshortbot-scanner --lines 50           # scanner logs
pm2 logs altshortbot-executor --lines 50          # executor logs
pm2 save                                          # persist process list across reboots

# ─── Backtest ────────────────────────────────────────────────────────────────
npx tsx backtest_signals.ts --coin ORDI --days 60 --chart   # default: Bybit source
npx tsx backtest_signals.ts --coin ORDI --source binance     # legacy Binance source

# ─── Type-check ─────────────────────────────────────────────────────────────
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  --lib es2022,dom \
  bybit_executor.ts shared_types.ts live_scanner.ts scanner_test.ts
```

---

## Architecture details

### Data sources

- **Candles**: Bybit (`/v5/market/kline`, 1h interval)
- **Funding**: Merged Bybit + Binance (most extreme per hour via `buildMergedFundingByHour`)
- **OI**: Bybit (`/v5/market/open-interest`, caps at ~200 records ≈ 8 days)
- **Coin discovery**: Bybit instruments-info filtered to active USDT perps

### Signal types and queue rules

| Type          | Telegram        | Queue                  | Gate                                           |
| ------------- | --------------- | ---------------------- | ---------------------------------------------- |
| `FUNDING`     | ❌ console only | ❌                     | Broad-market noise; 300+/scan would flood chat |
| `PUMP_TOP`    | ✅              | ❌                     | Informational only                             |
| `BUILDING`    | ✅              | ✅ if all 3 gates pass | See below                                      |
| `EXHAUSTION`  | ✅              | ✅ if HIGH or MEDIUM   | Squeeze ending                                 |
| `TREND_BREAK` | ✅              | ✅ always              | Blow-off top                                   |

**BUILDING queue gates:**

1. `fundingApr ≤ -200%`
2. `oiDropPct ≥ BUILDING_OI_RISING_MAX` — first fire: -150%, re-fire: -200%
3. `!recentPumpTop` — `PUMP_TOP_COOLDOWN_H = 0` (disabled — re-enable with evidence)

### BUILDING re-fire

Once a BUILDING fires, it re-fires when funding becomes 2× more extreme (`BUILDING_REFIRE_MULTIPLIER = 2.0`). Tracked via `lastBuildingFundingApr` in `CoinState`. Re-fires include `(intensified from X%)` in the Telegram details.

Re-fires use a **more permissive OI gate (-200%)** vs the first-fire gate (-150%). Evidence: SOLV May-12 16:00 re-fired at -997% APR (OI -172.5%, between the two thresholds) and dropped immediately with +0.27% max adverse — one of the cleanest signals in the dataset. The first fire at -447% had a 5%+ adverse excursion because the squeeze was still building.

### Backtest gap-fill divergence

Backtest zero-fills non-settlement funding hours; live scanner forward-fills. This causes the backtest to fire false EXHAUSTION signals during deep squeezes. `scanner_test.ts` is calibrated to live-scanner behaviour and is the reliable reference. `backtest_test.ts` EXHAUSTION assertions reflect the artefact.

### Gate simulation tool

`simulate_gates.ts` verifies that known-good signals are queued and known-bad signals are blocked. Constants (`BUILDING_OI_RISING_MAX`, `BUILDING_OI_RISING_MAX_REFIRE`, `FUNDING_THRESHOLD`, `PUMP_TOP_COOLDOWN_H`) are **imported directly from `live_scanner.ts`** — no manual sync required. Run it whenever gate thresholds change.

Add new signals to the `SIGNALS` array with:

- `expectBlocked: true` — the gate should block this signal (known bad)
- `expectBlocked: false` (default) — the gate should queue this signal (known good)
- `isRefire: true` — applies the re-fire OI threshold (-200%)

The script exits non-zero on any assertion failure, making it safe for CI.

### Scanner state

`scanner_state.json` persists wave metadata across runs.

- **Resets on wave end**: `squeezeWaveStartMs`, `squeezeWaveHighPrice`, `waveAlertedBuilding`, `lastBuildingFundingApr`, `lastExhaustionMs`
- **Persists across resets**: `lastBuildingMinFunding` (needed by TREND_BREAK to remember prior squeeze depth), `waveAlertedTrendBreak` (resets on trend exit not wave exit), `lastPumpTopMs` (harmless while `PUMP_TOP_COOLDOWN_H = 0`)

### Near-miss logging

Each scan, coins with cumulative squeeze ≥ 15% but < 20% (approaching threshold without triggering) are logged to `near_miss.jsonl` with their actual `fundingApr` and `price`. Skipped in `--dry-run`.

`check_near_misses.ts` aggregates by coin, showing peak near-miss %, how many times seen, and last occurrence. Use this after 4-6 weeks to decide if 15m candles would meaningfully improve signal capture.

The `candleHighGapPct` field on BUILDING alerts (also logged to `building_log.jsonl`) shows the % between the candle high and close at signal time — if this is consistently large (5%+), entries are being made late within the hour.

---

## Bybit executor

### Client

```typescript
const client = new RestClientV5({
  key: BYBIT_API_KEY,
  secret: BYBIT_API_SECRET,
  testnet: false,
  demoTrading: true, // ← set false to go live with real money
});
```

Uses `bybit-api` npm SDK. HMAC auth handled automatically.

### Key behaviours

- **`setLeverage`** requires both `buyLeverage` and `sellLeverage` (Bybit requires both)
- **Stop loss** attached directly to `submitOrder` — no separate stop order
- **`closePosition`** uses `qty: "0"` + `reduceOnly: true` + `closeOnTrigger: true` to close full position
- **`clearQueue`** runs **after** `fetchAccountEquity` succeeds — signals preserved on API failure
- **Exchange-closed detection**: `getPositionInfo` returns `size: "0"` when stop triggered by exchange

### Paper vs demo vs live

| Mode                 | Orders           | Prices                 | Credentials      |
| -------------------- | ---------------- | ---------------------- | ---------------- |
| `--paper`            | None (simulated) | Real Bybit market data | Not needed       |
| `demoTrading: true`  | Real demo orders | Real mainnet prices    | Mainnet API keys |
| `demoTrading: false` | Real live orders | Real mainnet prices    | Mainnet API keys |

**Always use demo, not testnet** — testnet has fake prices that don't reproduce squeeze dynamics.

### Position sizing

`notional = riskUsd / stopLossPct` → $1,667 notional on $10k account → $200 loss at 12% stop → 2% account risk. Leverage (3×) affects margin posted, not loss at stop.

---

## Environment

All credentials in `~/.bashrc` so both manual runs and PM2 inherit them:

```bash
export TELEGRAM_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
export BYBIT_API_KEY="..."        # not needed for --paper
export BYBIT_API_SECRET="..."     # not needed for --paper
```

After editing: `source ~/.bashrc && pm2 restart all`

---

## Validated signal parameters

```
--threshold 10 --min-positive 2 --min-oi 2 --max-price 2
--pump-pct 19 --pump-vol 5 --pump-rsi 88 --pump-funding 0
--squeeze-pct 20 --squeeze-hours 10 --squeeze-funding -100 --squeeze-oi-drop 0
--exhaust-funding -20 --exhaust-oi-drop 3 --lookahead 48
```

Validated across 10 coins. Do not change without full backtest revalidation.

---

## Going-live strategy

### Don't change anything until 30+ live signals

The current setup (2% account risk, 3× leverage, 12% stop) is well-calibrated. Six signals is too small a sample to optimise sizing. Resist premature changes.

### Phase 1 — demo mode (current)

Accumulate signals. Validate the full scanner → queue → executor pipeline. Study peak-vs-final gaps in `building_log.jsonl` and `bybit_positions.json`. Watch `near_miss.jsonl` for patterns.

### Phase 2 — first 4 weeks live

Drop to **1% account risk** (not 2%). The jump from demo to live introduces execution slippage and psychological pressure. Scale back to 2% after confirming live executor matches demo behaviour. Start with a real $10,000 account regardless of total Bybit balance — use `BYBIT_ACCOUNT_CAP` env var to cap sizing if needed.

### Phase 3 — after 20+ live signals

Two levers, in this order:

**1. Trailing stops** — highest impact. Study the peak-vs-final gap across 30+ signals to calibrate the trail distance. Example: if SNT at -2444% APR peaked at +20% before settling at +10%, a trailing stop that activates at +8% and trails 5% would lock in +15% instead of waiting 48h.

The executor already has `closeReason: "trailing"` typed in `shared_types.ts`. Implementation: add a `trailingActive` flag to `PositionRecord` and update `managePositions` to move the stop up as price drops.

**2. Tiered sizing by funding intensity** — only after trailing stops are working:

| Funding APR     | Account risk  |
| --------------- | ------------- |
| -200% to -500%  | 2% (standard) |
| -500% to -1500% | 3%            |
| > -1500%        | 4%            |

More extreme funding = more violent reversal = higher conviction. Cap total concurrent risk at 20% of account regardless of tier.

### Never increase leverage

3× is the ceiling. At 4–5× the liquidation price on Bybit's mark-price model gets dangerously close to the 12% stop on volatile alts.

---

## Deviations from original HL plan

| Where               | Original                                        | Shipped                                                         | Rationale                                                 |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Executor            | Hyperliquid (`hl_executor.ts`)                  | Bybit (`bybit_executor.ts`)                                     | Only 14% of signals listed on HL; all executable on Bybit |
| Executor client     | HL SDK                                          | `bybit-api` RestClientV5 with `demoTrading: true`               | Bybit native; demo uses real prices unlike testnet        |
| Scanner cron        | `5 * * * *` (hourly)                            | `*/15 * * * *` (15-min)                                         | Catches signals 45 min earlier; well within rate limits   |
| Sizing math         | `notional = marginUsed × maxLeverage` (6% risk) | `notional = riskUsd / stopLossPct` (2% risk)                    | Plan formula contradicted its own variable name           |
| PM2 names           | `altshortbot`                                   | `altshortbot-scanner` + `altshortbot-executor`                  | Two processes need distinct names                         |
| `--pump-pct`        | 25                                              | 19                                                              | Recovers HYPER/WIF pump-tops, no false positives          |
| Funding source      | Bybit only                                      | Merged Bybit + Binance (most extreme per hour)                  | Bybit-only misses HYPER/SPK signals                       |
| Tradeable signals   | `{EXHAUSTION, TREND_BREAK}`                     | `+ BUILDING` when all 3 gates pass                              | 10-day paper: 9/9 winners at ≤ -200% APR                  |
| BUILDING fires      | Once per wave                                   | Re-fires at 2× funding; OI gate -150% (first) / -200% (re-fire) | Captures better entries; SOLV/PEAQ evidence               |
| `clearQueue` timing | Before equity check                             | After equity check                                              | Signals were lost on transient API failures               |
| `FUNDING` alerts    | Telegram                                        | Console only                                                    | 300+/scan floods chat; never affects positions            |
| `--dry-run`         | Suppresses Telegram                             | Suppresses queue + building log; Telegram fires                 | A dry run the executor would trade from is not dry        |
| `signalType`        | `"EXHAUSTION"\|"TREND_BREAK"`                   | `+ "BUILDING"`                                                  | Widened after BUILDING became tradeable                   |
