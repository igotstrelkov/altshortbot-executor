# CLAUDE.md

Operational reference for AltShortBot — loaded into every Claude Code session. Keep it lean.
Background, rationale, deviations, and deep architecture detail live in **`HISTORY.md`**.

> Some claims are marked _(unverified)_ — files not reviewed in the last update
> (`ecosystem.config.js`, `scanner_test.ts`, `check_building_signals.ts`). Confirm before relying.

## What this project is

A two-process bot for shorting overheated altcoin perpetuals:

- **Scanner** (`live_scanner.ts`) — hourly; scans every active Bybit USDT perp, detects
  signals, sends Telegram alerts, writes tradeable signals to `signal_queue.json`. The
  scanner is **always Bybit-based** — it detects _signals_ on Bybit regardless of which
  exchange the executor trades on.
- **Executor** — every 5 min; reads/clears the queue, places real or paper shorts, manages
  open positions, sends Telegram updates.

They communicate **only** via JSON files (`signal_queue.json`, plus the executor's positions
file) — no shared memory, no direct calls. PM2 runs them as `altshortbot-scanner` (cron
`5 * * * *`) and `altshortbot-executor` (cron `*/5 * * * *`); executor ships `--paper` in
`ecosystem.config.js` _(unverified)_.

### Two executors — Bybit is live, KuCoin is the migration target

- **`bybit_executor.ts`** — the **live** executor. Trades on Bybit USDT perps, positions in
  `bybit_positions.json`. This is what currently runs.
- **`kucoin_executor.ts`** — a **migration target, paper-tested only, NOT yet live.** Trades
  the same Bybit-detected signals on KuCoin USDT perps; positions in `kucoin_positions.json`.
  Built but not validated against the real KuCoin API — see its section below and `HISTORY.md`.

Both share the scanner, the queue, the `RISK` block, and the two-exit model. They differ only
in exchange API and sizing. Executor history: Hyperliquid → Bybit → (KuCoin, in progress).
See `HISTORY.md`.

## Current risk configuration

The `RISK` block — **identical in both `bybit_executor.ts` and `kucoin_executor.ts`.**
Rationale: `HISTORY.md` → Risk parameter rationale.

```typescript
const RISK = {
  maxLeverage: 3, // safety cap; rarely binding (sizing is risk-based)
  riskPerTrade: 0.03, // 3% of equity lost on a stop-out (= 1R)
  stopLossPct: 0.15, // 15% stop loss
  maxPositions: 10, // max concurrent open positions
  timeoutH: 48, // close after 48h regardless
} as const;
```

**Exits — only two.** A short closes on **stop** (price rose `stopLossPct` above entry) or
**timeout** (48h elapsed, closed at live price). There is **no take-profit and no trailing
stop** — a winning short rides until it reverses into the stop or times out. Any analysis or
tooling MUST model this two-exit behaviour.

**Sizing — risk-based:** `riskUsdt = equity * riskPerTrade`; `notional = riskUsdt /
stopLossPct`. A stop-out always costs exactly 1R (3% of equity); stop width does not change
dollar risk per trade.

## Common commands

```bash
# Scanner
npx tsx live_scanner.ts                           # full Bybit universe
npx tsx live_scanner.ts --coins ORDI --dry-run    # single coin, no queue write

# Executor — Bybit (live). --paper short-circuits all order code
npx tsx bybit_executor.ts --paper                 # simulate
npx tsx bybit_executor.ts --paper --status        # positions + paper P&L
npx tsx bybit_executor.ts                         # LIVE — real orders

# Executor — KuCoin (migration target, paper-tested only)
npx tsx kucoin_executor.ts --paper                # simulate
npx tsx kucoin_executor.ts --paper --status       # positions + paper P&L
npx tsx kucoin_executor.ts                        # LIVE — real orders (NOT yet validated)

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
  bybit_executor.ts kucoin_executor.ts shared_types.ts live_scanner.ts scanner_test.ts
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
--building-min-funding -200
```

## Signal types and what gets queued

Five types fire from `scanCoin()`. The executor only trades the subset written to
`signal_queue.json`:

| Type          | Telegram        | Queued (traded)              | Condition                                      |
| ------------- | --------------- | ---------------------------- | ---------------------------------------------- |
| `FUNDING`     | ❌ console only | ❌ never                     | Gate 1 passes (broad-market noise)             |
| `PUMP_TOP`    | ✅              | ✅ always                    | Large candle + volume + RSI + positive funding |
| `BUILDING`    | ✅              | ✅ if `fundingApr ≤ -200%`   | Squeeze active, funding extreme                |
| `EXHAUSTION`  | ✅              | ⛔ **SUSPENDED**             | Squeeze ending                                 |
| `TREND_BREAK` | ✅              | ✅ always (always HIGH conf) | Blow-off top during uptrend                    |

**EXHAUSTION queueing is suspended** — it still alerts on Telegram but is not traded. It was
the only signal type with negative realized P&L. Controlled by `EXHAUSTION_QUEUEING_ENABLED =
false` in `backtest_signals.ts` and the scanner's queue filter. Reversible — re-enable after
the detector is fixed. Full rationale in `HISTORY.md`.

The `-200%` BUILDING threshold (Strategy B) is a floor, not a band — funding-band analysis
showed no win-rate degradation at more extreme funding. FUNDING is console-only to avoid
flooding Telegram (300+/scan in broad regimes); it never affects positions.

## Do not re-investigate these

Tested on the full universe and **rejected on the data** (detail + numbers in `HISTORY.md`):
trend-filtering PUMP_TOP, capping extreme funding, an OI-rising gate on BUILDING, and
dropping PUMP_TOP / BUILDING-only. The signal layer (~73% queued win rate across 440 signals)
is settled. Judge any future change on **realized P&L and drawdown**, never win rate alone.

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

## Executor mechanics — Bybit (bybit_executor.ts, live)

- **Bybit REST** via `RestClientV5` from `bybit-api`, category `linear`. `BYBIT_TESTNET=1`
  → testnet. `formatPrice(price, tickSize)` formats to the instrument tick size.
- **`setLeverage` fires before every entry**, clamped to `min(RISK.maxLeverage,
asset.maxLeverage)`. On failure the order is not placed and a Telegram alert fires.
- **Order sizing** — `qty` is a **coin quantity**: `notional / entryPrice`.
- **Stop-loss is attached to the entry order** (`stopLoss` param on `submitOrder`) — one
  atomic call; the position is never briefly unprotected.
- **Position management** — stop or timeout only. Live mode detects stop-out by polling
  `fetchLivePositionSize` (0 → exchange closed it); paper compares price to `stopLossPx`.
- **Paper mode** short-circuits all order helpers (`if (IS_PAPER) return`). SDK signing,
  `formatPrice`, order-status parsing run for the first time on **testnet** — use it.
- **Errors** — `alertError(ctx, err)` → stderr + `🚨` Telegram, wired through order
  placement, leverage, account fetches, position management.
- **Queue races** — `signal_queue.json` is non-atomic read-modify-write; `JSON.parse` is
  wrapped to return `[]` on truncated reads. A sub-second append/clear race can lose or
  double-process a signal. Accepted tradeoff.

## Executor mechanics — KuCoin (kucoin_executor.ts, migration target)

**Status: paper-tested only, NOT yet validated against the real KuCoin API.** Mirrors the
Bybit executor's structure (same `RISK` block, `--paper`/`--status`, two-exit model,
`alertError`, queue-safety ordering). KuCoin-specific differences:

- **KuCoin REST** via `FuturesClient` from `kucoin-api` (tiagosiebler — same SDK family as
  `bybit-api`; the official `kucoin-universal-sdk` was considered, see `HISTORY.md`). The SDK
  returns the full `{ code, data }` envelope; `unwrap()` checks `code === "200000"` and
  returns `.data`.
- **Order sizing is in INTEGER CONTRACTS, not coins.** Each contract = `multiplier` coins.
  `calcSize` converts risk-based notional → `contracts = round(notional / (entry ×
multiplier))` to a `lotSize` multiple, **floored at 1 lot** (round-up). Realized risk is
  therefore quantized — it is logged on the position, and the entry alert flags
  `⚠️ size rounded up` when actual risk exceeds 1.5× the 3% target.
- **Leverage is passed inline** on `submitOrder` — there is no separate `setLeverage` call.
- **Stop-loss is a SEPARATE second order**, not attached to the entry. The executor places a
  market short, then a stop-market close order (`closeOrder: true, stop: 'up'`). **If the
  entry succeeds but the stop order fails, the position is briefly UNPROTECTED** — the
  executor sends a loud 🚨 alert, but cannot prevent the gap atomically. This is a real
  KuCoin limitation, unlike Bybit's attached stop.
- **Listing filter** — `loadContracts()` calls `getSymbols()` once at startup and caches
  every contract that is **USDT-margined AND `status: "Open"`**. A signal whose coin is not
  in that set is skipped and logged. This is the "not listed on KuCoin" handling — some
  Bybit-listed coins are not on KuCoin.
- **Symbol mapping** — `toKucoinSymbol()`: `{COIN}USDT` → `{COIN}USDTM`, with `BTC` → `XBT`
  (KuCoin uses `XBTUSDTM` for Bitcoin).
- **Verified field accessors** — `getBalance().data.accountEquity` (equity),
  `getPosition().data.currentQty`/`.isOpen` (stop detection), `getSymbol`/`getSymbols`
  `.multiplier`/`.lotSize`/`.maxLeverage`/`.tickSize`/`.status`. Confirmed against live API
  responses.
- **No testnet wired** — paper-mode-only for v1; KuCoin sandbox support deferred.

## Environment

Always: `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.

Bybit executor (live): `BYBIT_API_KEY`, `BYBIT_API_SECRET`.
Optional: `BYBIT_TESTNET=1`, `BYBIT_PAPER_ACCOUNT` (default `10000`), `SCANNER_COINS`.

KuCoin executor (migration target): `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`,
`KUCOIN_API_PASSPHRASE` — note KuCoin needs **three** credentials, not two.
Optional: `KUCOIN_PAPER_ACCOUNT` (default `10000`).

Use an exchange API key scoped to **derivatives trading only** — no withdrawal permission.
Restrict it to the VPS IP where possible. Only that key sits on the VPS.

## Config sync checklist

These must agree, or the backtest measures a system you are not running:

1. **Detection PARAMS** — `live_scanner.ts` `PARAMS` == `backtest_signals.ts` default CLI.
2. **Queue rules** — scanner `appendToQueue` filter == backtest `collectQueuedSignals`:
   PUMP_TOP + TREND_BREAK + BUILDING(≤-200%) queued; EXHAUSTION suspended; FUNDING never.
3. **Risk block** — the `RISK` block in **both** `bybit_executor.ts` and
   `kucoin_executor.ts` == analysis-tool defaults (`stopLossPct 0.15`, `riskPerTrade 0.03`,
   `maxPositions 10`, `timeoutH 48`). The two executors must not drift apart.

After any change to detection, queueing, or risk: run `backtest_test.ts` and `scanner_test.ts`.
