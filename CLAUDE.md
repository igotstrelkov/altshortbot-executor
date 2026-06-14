# CLAUDE.md

Operational reference for AltShortBot — loaded into every Claude Code session. Keep it lean.
Background, rationale, deviations, and deep architecture detail live in **`HISTORY.md`**.

> Some claims are marked _(unverified)_ — files not reviewed in the last update
> (`ecosystem.config.js`, `scanner_test.ts`, `check_building_signals.ts`). Confirm before relying.

## What this project is

A two-process bot for shorting overheated altcoin perpetuals on **Bybit**:

- **Scanner** (`live_scanner.ts`) — hourly; scans every active Bybit USDT perp, detects
  signals, sends Telegram alerts, writes tradeable signals to `signal_queue.json`.
- **Executor** (`bybit_executor.ts`) — every 5 min; reads/clears the queue, places real or
  paper shorts on Bybit, manages open positions, sends Telegram updates.

They communicate **only** via JSON files (`signal_queue.json`, `bybit_positions.json`) — no
shared memory, no direct calls. PM2 runs them as `altshortbot-scanner` (cron `5 * * * *`) and
`altshortbot-executor` (cron `*/5 * * * *`); executor ships `--paper` in `ecosystem.config.js`
_(unverified)_. The executor previously targeted Hyperliquid — see `HISTORY.md`.

## Current risk configuration

`RISK` block (shape shared by both executors; KuCoin is the live venue — see note below).
Rationale: `HISTORY.md` → Risk parameter rationale + Executor entry safety.

```typescript
const RISK = {
  maxLeverage: 3, // safety cap; rarely binding (sizing is risk-based)
  riskPerTrade: 0.03, // 3% of equity lost on a stop-out (= 1R)
  stopLossPct: 0.15, // 15% stop loss
  maxPositions: 10, // max concurrent open positions
  timeoutH: 24, // close after 24h regardless (validated 2026-05-28)
  reentryCooldownH: 24, // no re-short of a coin for 24h after it stops out
} as const;
```

> KuCoin is the live venue (`kucoin_executor.ts`); its block uses `riskPerTrade 0.05`,
> `maxPositions 5`. `bybit_executor.ts` mirrors the structure with `0.03` / `10`. The
> `stopLossPct`, `timeoutH`, and `reentryCooldownH` values match across both.

**Exits — only two.** A short closes on **stop** (price rose `stopLossPct` above entry) or
**timeout** (24h elapsed, closed at live price). There is **no take-profit and no trailing
stop** — a winning short rides until it reverses into the stop or times out. Any analysis or
tooling MUST model this two-exit behaviour.

**Sizing — risk-based:** `riskUsdt = equity * riskPerTrade`; `notional = riskUsdt /
stopLossPct`. A stop-out always costs exactly 1R (3% of equity); stop width does not change
dollar risk per trade.

**Entry gates (executor, pre-order).** Before opening, the executor skips a signal when:
the coin is on `EXCLUDE_COINS` (e.g. `H` — Bybit-scanner vs KuCoin-executor price split from
a redenomination); the live trading-venue price diverges >15% from the signal's entry
(`MAX_SIGNAL_DIVERGENCE` — venue mismatch or stale signal); or the coin stopped out within
`reentryCooldownH`. **Stop, entry, and sizing anchor to the actual fill price, not the
scanner's signal price.** Rationale + backtests: `HISTORY.md` → Executor entry safety.

## Common commands

```bash
# Scanner
npx tsx live_scanner.ts                           # full Bybit universe
npx tsx live_scanner.ts --coins ORDI --dry-run    # single coin, no queue write

# Executor (--paper short-circuits all order code)
npx tsx bybit_executor.ts --paper                 # simulate
npx tsx bybit_executor.ts --paper --status        # positions + paper P&L
npx tsx bybit_executor.ts                         # LIVE — real orders

# Backtest + regression tests
npx tsx backtest_signals.ts --coin ORDI --days 60 --chart
npx tsx backtest_test.ts                          # regression suite
npx tsx scanner_test.ts                           # live-scanner regression

# Universe-scale research tools (not in the live loop)
npx tsx run_universe_backtest.ts                  # full universe → universe_result.json
npx tsx analyze_stops.ts                          # per-trade P&L by stop / type
npx tsx simulate_portfolio.ts                     # equity curve + max drawdown

# Type-check
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  --lib es2022,dom \
  bybit_executor.ts shared_types.ts live_scanner.ts scanner_test.ts
```

PM2 (prod): `pm2 start ecosystem.config.js && pm2 save && pm2 startup` _(unverified)_.

## Validated signal parameters

Detection parameters — live in `PARAMS` in `live_scanner.ts`, and the default CLI in
`backtest_signals.ts`. Do **not** change without re-running the backtest across the validated
coin set and confirming win rates hold.

```
--threshold 10 --min-positive 2 --min-oi 2 --max-price 2
--pump-pct 19 --pump-vol 5 --pump-rsi 88 --pump-funding 0
--squeeze-pct 20 --squeeze-hours 10 --squeeze-funding -100 --squeeze-oi-drop 0
--exhaust-funding -20 --exhaust-oi-drop 3 --lookahead 48
--building-min-funding -180 --building-max-extreme-funding -2000
```

## Signal types and what gets queued

Five types fire from `scanCoin()`. The executor only trades the subset written to
`signal_queue.json`:

| Type          | Telegram        | Queued (traded)              | Condition                                      |
| ------------- | --------------- | ---------------------------- | ---------------------------------------------- |
| `FUNDING`     | ❌ console only | ❌ never                     | Gate 1 passes (broad-market noise)             |
| `PUMP_TOP`    | ✅              | ✅ always                    | Large candle + volume + RSI + positive funding |
| `BUILDING`    | ✅              | ✅ if `-2000% < fundingApr ≤ -180%` | Squeeze active, funding in the validated band  |
| `EXHAUSTION`  | ✅              | ⛔ **SUSPENDED**             | Squeeze ending                                 |
| `TREND_BREAK` | ✅              | ✅ always (always HIGH conf) | Blow-off top during uptrend                    |

**EXHAUSTION queueing is suspended** — it still alerts on Telegram but is not traded. It was
the only signal type with negative realized P&L. Controlled by `EXHAUSTION_QUEUEING_ENABLED =
false` in `backtest_signals.ts` and the scanner's queue filter. Reversible — re-enable after
the detector is fixed. Full rationale in `HISTORY.md`.

BUILDING is queued in a **band**: `-2000% < fundingApr ≤ -180%` (Strategy B).

- **Floor (`-180%`, `MIN_FUNDING_APR`)** — loosened from `-200%` on 2026-06-07: the
  `-180..-200` band was the highest-win-rate marginal slice (82% win, +0.28R) and beat `-200`
  on return in BOTH halves of a 120d out-of-sample split with matched drawdown. Looser floors
  (`-150`/`-120`) added drawdown without robust gain — rejected; do not loosen below `-180`
  without re-validating.
- **Ceiling (`-2000%`, `MAX_EXTREME_FUNDING_APR`)** — added 2026-06-14. The earlier
  "no degradation at extreme funding" claim was **win-rate only**; with integrated funding the
  `≤-2000%` band wins most on price (80%) but is a **net loser all-in (-0.19R)** — carry
  overwhelms the edge. Capping it lifted funding-adjusted return `+228%→+526%` and cut MaxDD
  `-62%→-23%`, robust across BOTH out-of-sample halves with `-2000%` the best threshold in
  each. Judge on realized P&L: re-test (return + drawdown + OOS, not win rate) before moving it.

FUNDING is console-only to avoid flooding Telegram (300+/scan in broad regimes); it never
affects positions.

## Do not re-investigate these

Tested on the full universe and **rejected on the data** (detail + numbers in `HISTORY.md`):
trend-filtering PUMP_TOP, an OI-rising gate on BUILDING, and dropping PUMP_TOP / BUILDING-only.
The signal layer (~73% queued win rate across 440 signals) is settled. Judge any future change
on **realized P&L and drawdown**, never win rate alone.

> **Reversed 2026-06-14:** "capping extreme funding" was previously listed here as rejected —
> but that rejection was decided on **win rate** (the win-rate-era data was incomplete: no
> integrated funding model). With integrated funding it's a clear win, so a `-2000%` ceiling is
> now **adopted** (see the BUILDING band above). A lesson in the rule itself: realized P&L > win rate.

## Architecture rules

- **Data sources** — backtest and scanner both use Bybit candles + merged Bybit/Binance
  funding (most extreme per hour). Detail and `--source` flags: `HISTORY.md`.
- **Gap-fill** — backtest zero-fills non-settlement funding hours; the live scanner
  forward-fills. This makes backtest EXHAUSTION signals unreliable vs live. `scanner_test.ts`
  (calibrated to live output) is the reference. Detail: `HISTORY.md`.
- **Scanner state** — `scanner_state.json` all-null entries are normal for calm coins. Field
  reset/persist rules: `HISTORY.md`.
- **Fixtures** — `fixtures/<COIN>.json` replayed by both test suites; refresh with
  `--update-fixtures` only on intentional algorithm changes.
- **Shared types** — `Alert`, `QueuedSignal`, `PositionRecord`, `PositionStore`, `PaperTrade`
  in `shared_types.ts`. Known stale-type gaps noted in `HISTORY.md`.

## Executor mechanics (bybit_executor.ts)

- **Bybit REST** via `RestClientV5` from `bybit-api`, category `linear`. `BYBIT_TESTNET=1`
  → testnet. `formatPrice(price, tickSize)` formats to the instrument tick size.
- **`setLeverage` fires before every entry**, clamped to `min(RISK.maxLeverage,
asset.maxLeverage)`. On failure the order is not placed and a Telegram alert fires.
- **Position management** — stop or timeout only. Live mode detects stop-out by polling
  `fetchLivePositionSize` (0 → exchange closed it); paper compares price to `stopLossPx`.
- **Paper mode** short-circuits all order helpers (`if (IS_PAPER) return`). SDK signing,
  `formatPrice`, order-status parsing run for the first time on **testnet** — use it.
- **Errors** — `alertError(ctx, err)` → stderr + `🚨` Telegram, wired through order
  placement, leverage, account fetches, position management.
- **Queue races** — `signal_queue.json` is non-atomic read-modify-write; `JSON.parse` is
  wrapped to return `[]` on truncated reads. A sub-second append/clear race can lose or
  double-process a signal. Accepted tradeoff.

## Environment

Always: `TELEGRAM_TOKEN`, `TELEGRAM_GROUP_ID`.
Live executor: `BYBIT_API_KEY`, `BYBIT_API_SECRET`.
Optional: `BYBIT_TESTNET=1`, `BYBIT_PAPER_ACCOUNT` (default `10000`), `SCANNER_COINS`.

Use a Bybit API key scoped to **derivatives trading only** — no withdrawal permission.
Restrict it to the VPS IP where possible. Only that key sits on the VPS.

## Config sync checklist

These must agree, or the backtest measures a system you are not running:

1. **Detection PARAMS** — `live_scanner.ts` `PARAMS` == `backtest_signals.ts` default CLI.
2. **Queue rules** — scanner `appendToQueue` filter == backtest `collectQueuedSignals` ==
   executor entry gates: PUMP_TOP + TREND_BREAK + BUILDING(`-2000% < funding ≤ -180%`) queued;
   EXHAUSTION suspended; FUNDING never. Ceiling lives in `MAX_EXTREME_FUNDING_APR`
   (scanner + both executors) and `buildingMaxExtremeFundingApr` (backtest).
3. **Risk block** — `bybit_executor.ts` `RISK` == analysis-tool defaults
   (`stopLossPct 0.15`, `riskPerTrade 0.03`, `maxPositions 10`, `timeoutH 24`).

After any change to detection, queueing, or risk: run `backtest_test.ts` and `scanner_test.ts`.
