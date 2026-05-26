# HISTORY.md

Background, rationale, and deep reference for AltShortBot. This file is **not** loaded into
every Claude Code session — `CLAUDE.md` is the lean operational reference and points here for
detail. Read this when you need _why_, not _what_.

## Project history

- The executor originally targeted **Hyperliquid** (`hl_executor.ts`). It was replaced with
  `bybit_executor.ts` because only ~14% of scanner signals were listed on Hyperliquid — every
  signal is executable on Bybit.
- `kucoin_executor.ts` is a **third executor**, an in-progress migration target (Bybit →
  KuCoin). It is built and paper-tested but **not yet validated against the live KuCoin API
  or deployed** — `bybit_executor.ts` remains the live executor. Design detail below.
- An `ALTSHORTBOT_COMPLETE_PLAN.md` was the original 11-stage spec. It has been **removed**.
  The "Design deviations" table below is the surviving record of why the implementation
  differs from that plan.

## KuCoin executor — design notes

`kucoin_executor.ts` mirrors `bybit_executor.ts` section-for-section (same `RISK` block,
`--paper`/`--status`, two-exit model, `alertError`→Telegram, queue-safety ordering). The
KuCoin-specific decisions:

- **SDK: `kucoin-api` (tiagosiebler), not the official `kucoin-universal-sdk`.** Three SDKs
  exist: the old `kucoin-futures-node-sdk` (officially deprecated); `kucoin-universal-sdk`
  (KuCoin's current official SDK — first-party, but a verbose builder-pattern API); and
  `kucoin-api` (third-party, actively maintained, by the same author as `bybit-api`). Chose
  `kucoin-api` because the codebase already uses `bybit-api` — same idiom (flat client,
  `client.submitOrder({...})`), so the port from `bybit_executor.ts` is near-mechanical. The
  cost is a third-party dependency; the official SDK is a defensible alternative if
  first-party tracking is later preferred.
- **Sizing in integer contracts.** KuCoin futures `size` is a contract count, not a coin
  quantity — each contract = `multiplier` coins. `calcSize` converts the risk-based notional
  to `contracts = round(notional / (entry × multiplier))`, snapped to a `lotSize` multiple.
- **Round-up policy.** A positive fraction below one lot rounds **up** to 1 lot (never skips
  for size). Consequence: round-up only ever _increases_ risk — a trade on an expensive
  contract can come in above the 3% target. The executor stores the _actual_ notional and
  risk fraction on the position, and the entry alert flags `⚠️ size rounded up` when realized
  risk exceeds 1.5× target. This was a deliberate choice over skip-on-zero.
- **Two-order stop — a real limitation.** Bybit attaches the stop to the entry order
  atomically. KuCoin requires a separate stop-market close order after the entry. If the
  entry fills but the stop order fails, the position is briefly unprotected; the executor
  fires a loud 🚨 alert but cannot close the gap atomically.
- **Listing filter.** `getSymbols()` at startup caches every contract that is USDT-margined
  _and_ `status: "Open"` (a contract can be listed but Paused/BeingSettled). Signals for
  coins absent from that set are skipped — this is the "not listed on KuCoin" handling, since
  some Bybit-listed coins have no KuCoin USDT perpetual.
- **Paper-mode-only for v1.** KuCoin has a futures sandbox, but testnet support in
  `kucoin-api` was not verified — deferred. As with every executor, the first live run is the
  first real test of SDK signing and order round-trips.

## Risk parameter rationale

The live `RISK` block (`riskPerTrade 3%`, `maxPositions 10`, `stopLossPct 15%`, `timeoutH 48`)
was set from `run_universe_backtest.ts` (584 coins, 60-day window, 440 queued signals, ~73%
queued win rate) and `simulate_portfolio.ts` (equity curve + max drawdown).

- **`riskPerTrade 3%`** — the risk sweep showed return scales ~linearly with risk while
  drawdown scales faster. 4% gave a deeper modelled drawdown (~-30%); 3% (~-22%) is the
  return/drawdown balance. 2% under-uses the strategy.
- **`maxPositions 10`** — the concurrency sweep showed clean uncorrelated expansion from
  5→10 (return up ~4×, drawdown up modestly), then a cliff at 10→15 (drawdown nearly
  doubles). 10 is the aggressive-but-defensible edge; do not go higher.
- **`stopLossPct 15%`** — with no take-profit, a wide stop captures no extra upside, it only
  absorbs more loss. The stop-width sweep showed 20%→15% nearly doubles modelled return for
  ~1.6pt more drawdown; 15%→12% is the cliff (drawdown jumps to ~-31%). 15% is the sweet spot.

All three numbers are from **one** 60-day window — the modelled ~-24% drawdown is a floor on
bad, not a worst case. A worse correlated cluster (many squeeze shorts hit by one broad alt
selloff) goes deeper. Budget for -30%+ actually occurring.

## EXHAUSTION suspension — full rationale

EXHAUSTION signals still detect and fire Telegram alerts but are **not queued** for the
executor. The full-universe backtest showed EXHAUSTION as the only signal type with negative
realized P&L (≈ -20% to -4% per trade, ~86% stopped out). The detector fires while squeezes
are still accelerating — observed adverse excursions of +70–86% _after_ the exhaustion
signal. This is a detection fault, not a stop-loss issue.

Controlled by `EXHAUSTION_QUEUEING_ENABLED = false` in `backtest_signals.ts`, and by the
scanner's queue filter matching only `TREND_BREAK`. Fully reversible — re-enable once the
exhaustion detection logic is fixed and re-validated on the full universe.

## Rejected optimizations — detail

Each tested on the full universe and rejected on the data:

- **Trend-filter PUMP_TOP** (drop signals fired in a parabolic uptrend) — overall queued win
  rate moved 73%→73%/74%; the removed signals were net-positive. Tested three ways including
  realized P&L. The parabolic pump-tops earned money as a group; with the stop in place, the
  catastrophic outliers (e.g. RAVE's +359% adverse) are capped at -1R anyway.
- **Cap / tighten extreme funding for BUILDING** — funding-band win rate bounces 63–79% with
  no trend; the -2000%+ band ties for best (~79%). No mechanism to act on.
- **OI-rising gate on BUILDING** — 100% OI coverage in the test; the gate removed 14 signals
  (13 winners, 1 loser), win rate 73%→72%. It is anti-selective — it removes the violent
  mega-squeezes that do reverse.
- **Drop PUMP_TOP / run BUILDING-only** — PUMP_TOP is the best signal type (~76% win);
  removing it lowers the blended rate and cuts diversification.

General lesson: win rate can almost always be nudged up by cutting trades, and almost always
loses money doing so. Judge changes on realized P&L and drawdown, not win rate.

## Architecture deep reference

### Data sources

Both backtest and live scanner use **Bybit candles**. Funding is **merged Bybit + Binance**,
taking the most extreme (highest absolute) rate per hour — some coins show more extreme
negative funding on Binance during squeezes, and Bybit-only would miss those TREND_BREAK
signals.

- `backtest_signals.ts --source bybit` (default): Bybit candles + merged funding + Bybit OI.
- `--source binance`: Binance candles + merged funding + Binance OI. Used for `backtest_test.ts`
  fixture compatibility only.
- `--source hl`: Hyperliquid candles + funding. No OI, Gate 2 disabled.

### Gap-fill semantics — why live signals differ from backtest

Bybit settles funding every 4h or 8h. Between settlements the backtest **zero-fills**
non-settlement hours; the live scanner **forward-fills** the last settlement rate
(`buildMergedFundingByHour`).

During a deep squeeze at -1500% APR, the backtest's zero-fill makes `fundingApr` appear to
normalise at every non-settlement hour, which can satisfy the EXHAUSTION condition and fire
false EXHAUSTION alerts. The forward-fill keeps the rate negative and correctly blocks these.
Consequence: backtest EXHAUSTION signals may not transfer to live behaviour — `scanner_test.ts`
(calibrated to live forward-fill output) is the reliable reference. This predates, and is
separate from, the EXHAUSTION queueing suspension.

### BUILDING re-fire on intensification

`scanCoin()` tracks `lastBuildingFundingApr` in `CoinState`. BUILDING normally fires once per
squeeze wave (`waveAlertedBuilding = true`). Exception: if funding becomes **2× more extreme**
than when it last fired, it re-fires with an `(intensified from X%)` note. Controlled by
`BUILDING_REFIRE_MULTIPLIER = 2.0` in `live_scanner.ts`. `lastBuildingFundingApr` resets to 0
when the wave ends.

### Scanner state fields

`scanner_state.json` persists wave-tracking metadata across hourly runs. An all-null/default
coin entry is **expected** for a calm coin — not a bug.

- Reset when `!sq.triggered` (wave ends): `squeezeWaveStartMs`, `squeezeWaveHighPrice`,
  `waveAlertedBuilding`, `lastBuildingFundingApr`, `lastExhaustionMs`.
- Persist across wave resets: `lastBuildingMinFunding` (needed by `TREND_BREAK`),
  `waveAlertedTrendBreak` (resets on trend exit, not wave exit).

### Fixtures

`fixtures/<COIN>.json` holds `candles`, `fundingBybit`, `fundingBinance`, `oi` arrays replayed
by `backtest_test.ts` and `scanner_test.ts` for deterministic tests. Refresh with
`--update-fixtures` only when the algorithm has intentionally changed. The Bybit
`/open-interest` endpoint caps at ~200 records (~8 days) — OI-gated signals cannot fire for
events older than that window in the backtest.

### shared_types.ts — resolved type fixes

Two type gaps were fixed (previously the executors papered over them with casts):

- `PositionRecord.signalType` now includes `"PUMP_TOP"` —
  `"PUMP_TOP" | "BUILDING" | "EXHAUSTION" | "TREND_BREAK"`. PUMP*TOP became tradeable when it
  started queueing; the union had not been widened. Executors still cast `sig.type` to this,
  but it is now a \_safe narrowing* (5-member `Alert["type"]` minus the never-queued FUNDING),
  not an unsound widening.
- `PaperTrade.closeReason` trimmed to `"stop" | "timeout" | "manual"` — the dead `"target"`
  and `"trailing"` values were removed (no take-profit, no trailing stop in either executor).

Note: the executor position-store wrappers (`BybitPositionStore`, `KucoinPositionStore`) are
each defined **locally** in their own executor file, not in `shared_types.ts` — they are
structurally identical but kept local for consistency between the two executors.

## Design deviations (vs the removed ALTSHORTBOT_COMPLETE_PLAN.md)

| Where                | Plan                                  | Shipped                                                         | Rationale                                                                       |
| -------------------- | ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Execution venue      | Hyperliquid (`hl_executor.ts`)        | Bybit (`bybit_executor.ts`)                                     | Only ~14% of scanner signals listed on Hyperliquid; all executable on Bybit     |
| Sizing math          | `notional = marginUsed × maxLeverage` | `notional = riskUsd / stopLossPct`                              | Plan formula contradicted its own variable name; risk-based sizing is correct   |
| Pump threshold       | `--pump-pct 25`                       | `--pump-pct 19`                                                 | Validated on Bybit across the coin set — recovers pump-tops, no false positives |
| Backtest data source | Binance candles                       | Bybit candles + merged Bybit/Binance funding                    | Matches live scanner; `--source binance` retained for fixture compatibility     |
| Scanner funding      | Bybit funding only                    | Merged Bybit + Binance (most extreme per hour)                  | Bybit-only misses TREND_BREAK signals visible only in Binance funding           |
| Tradeable set        | `{EXHAUSTION, TREND_BREAK}`           | `{PUMP_TOP, TREND_BREAK, BUILDING≤-200%}`; EXHAUSTION suspended | Universe backtest: PUMP_TOP ~76% win; EXHAUSTION negative realized P&L          |
| BUILDING firing      | Once per wave                         | Re-fires when funding becomes 2× more extreme                   | Captures better entries when a squeeze intensifies                              |
| Alerts               | All → Telegram                        | FUNDING is console-only                                         | Broad-market regimes produce 300+ FUNDING/scan, flooding chat                   |
| `--dry-run`          | Suppresses Telegram                   | Suppresses queue writes; Telegram fires normally                | A dry run the executor would still trade from is not dry                        |
| Error handling       | `console.error` only                  | `alertError()` → stderr + Telegram for high-stakes paths        | Silent failures during live operation were unobservable                         |
| Stop loss            | 12% (early)                           | 15%                                                             | No-TP exit model: stop-width sweep showed 15% optimal                           |
| Risk / concurrency   | not specified at current values       | `riskPerTrade 3%`, `maxPositions 10`                            | Set from portfolio simulation — return-vs-drawdown balance                      |
