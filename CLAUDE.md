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

> KuCoin is the live venue (`kucoin_executor.ts`); its block uses `riskPerTrade 0.025`
> (halved from `0.05` on 2026-07-02 — see below), `maxPositions 5`. `bybit_executor.ts`
> mirrors the structure with `0.03` / `10`. The `stopLossPct`, `timeoutH`, and
> `reentryCooldownH` values match across both.

> **Sized down 2026-07-02:** BUILDING is a **high-variance, regime-dependent** edge
> (+475% one month, −25% the next; +332% over 60d). In a squeeze-heavy regime (31% stop
> rate) `riskPerTrade` was halved `0.05→0.025` to cut drawdown. `checkRollingHealth`
> (executor) warns on Telegram once/day when the trailing-30-trade net R goes negative —
> the objective trigger to pause or cut risk further. Raise risk back toward `0.05` when
> win rate recovers. See HISTORY.md → Regime dependence.

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
--exhaust-funding -20 --exhaust-oi-drop 3 --lookahead 24
--building-min-funding -200
```

## Signal types and what gets queued

Five types fire from `scanCoin()`. The executor only trades the subset written to
`signal_queue.json`:

| Type          | Telegram        | Queued (traded)              | Condition                                      |
| ------------- | --------------- | ---------------------------- | ---------------------------------------------- |
| `FUNDING`     | ❌ console only | ❌ never                     | Gate 1 passes (broad-market noise)             |
| `PUMP_TOP`    | ✅              | ❌ **not queued**            | Large candle + volume + RSI + positive funding |
| `BUILDING`    | ✅              | ✅ if `fundingApr ≤ -200%`   | Squeeze active, extreme negative funding (no ceiling) |
| `EXHAUSTION`  | ✅              | ✅ if HIGH/MEDIUM conf        | Squeeze ending (≥2h after a BUILDING)          |
| `TREND_BREAK` | ✅              | ✅ always (always HIGH conf) | Blow-off top during uptrend                    |

> **Queue logic REVERTED 2026-07-02 to commit `9e34170` (the "major refactor" baseline).**
> At the operator's request the 2026-06 changes were undone: **EXHAUSTION is queued again,
> PUMP_TOP is no longer queued, the BUILDING floor is back to `-200%`, and the `-2000%` funding
> ceiling was removed.** This was done **over** the backtest, which on identical 60-day data
> showed the newer logic was better (+139R vs +123R — PUMP_TOP is the best bucket and EXHAUSTION
> is ~zero R / net-negative after funding). If reverting the revert, the newer rules and their
> rationale (funding ceiling, PUMP_TOP inclusion, `-180` floor) are in git history + HISTORY.md.

Controlled by `EXHAUSTION_QUEUEING_ENABLED = true` / `PUMP_TOP_QUEUEING_ENABLED = false` in
`backtest_signals.ts`, the scanner's queue filter (`live_scanner.ts`), and the executor entry
gates. FUNDING is console-only (300+/scan in broad regimes); it never affects positions.

## Do not re-investigate these

Tested on the full universe and **rejected on the data** (detail + numbers in `HISTORY.md`):
trend-filtering PUMP_TOP, an OI-rising gate on BUILDING, dropping PUMP_TOP / BUILDING-only, and
a **7d run-up (momentum) ceiling on BUILDING** — regime-dependent, not robust: it rescues the
squeeze-heavy regime (recent 30d: −25%→~breakeven, OOS-consistent) but **costs ~50pts in the
normal regime** (60d: +332%→+283%), so it's a market-timing bet, not an edge. Kept as a monitor
(`analyze_stops` run-up band; `simulate_portfolio` momentum sweep), never a live gate. Funding,
OI, and listing-age also fail to separate stops from wins — **no at-entry filter robustly lifts
BUILDING**. The signal layer (~73% queued win rate across 440 signals) is settled. Judge any
future change on **realized P&L and drawdown**, never win rate alone.

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
2. **Queue rules** (reverted 2026-07-02 to commit-9e34170) — scanner `appendToQueue` filter ==
   backtest `collectQueuedSignals` == executor entry gates: EXHAUSTION(HIGH/MED) + TREND_BREAK +
   BUILDING(`funding ≤ -200%`, no ceiling) queued; PUMP_TOP NOT queued; FUNDING never. Toggles:
   `EXHAUSTION_QUEUEING_ENABLED` / `PUMP_TOP_QUEUEING_ENABLED` (backtest).
3. **Risk block** — `bybit_executor.ts` `RISK` == analysis-tool defaults
   (`stopLossPct 0.15`, `riskPerTrade 0.03`, `maxPositions 10`, `timeoutH 24`).

After any change to detection, queueing, or risk: run `backtest_test.ts` and `scanner_test.ts`.
