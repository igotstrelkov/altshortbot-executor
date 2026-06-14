# HISTORY.md

Background, rationale, and deep reference for AltShortBot. This file is **not** loaded into
every Claude Code session — `CLAUDE.md` is the lean operational reference and points here for
detail. Read this when you need _why_, not _what_.

## Project history

- The executor originally targeted **Hyperliquid** (`hl_executor.ts`). It was replaced with
  `bybit_executor.ts` because only ~14% of scanner signals were listed on Hyperliquid — every
  signal is executable on Bybit.
- An `ALTSHORTBOT_COMPLETE_PLAN.md` was the original 11-stage spec. It has been **removed**.
  The "Design deviations" table below is the surviving record of why the implementation
  differs from that plan.

## Risk parameter rationale

The live `RISK` block (`riskPerTrade 3%`, `maxPositions 10`, `stopLossPct 15%`, `timeoutH 24`)
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
- **`timeoutH 24`** — the timeout sweep (2026-05-28) tested 12h/24h/48h/72h on the live
  config. Result was an inverted-V centred on 24h: return +997% vs 48h's +935% and 72h's
  +868%, with drawdown roughly halved (-11.1% vs -24.5% vs -21.4%). 12h collapsed to +239%
  with -21.9% drawdown — the floor where winners are cut before the reversal completes. The
  mechanism: longer hold = more time for price to drift into the 15% stop _and_ more
  give-back past the peak (the give-back analysis showed 48h winners had already given back
  ~3pts on average). 24h catches winners closer to peak, with fewer accidental stop-outs.
  This was the FIRST signal/exit-layer optimization this session that improved the system
  net; six prior experiments were rejected. Validated and applied.

All four numbers are from **one** 60-day window — the modelled ~-11% drawdown at 24h is a
floor on bad, not a worst case. A worse correlated cluster (many squeeze shorts hit by one
broad alt selloff) goes deeper.

## Executor entry safety (2026-06-11)

Three executor-layer fixes from investigating a live **H** liquidation. The scanner detects on
**Bybit**; the executor trades **KuCoin** — that split is the root of two of these.

- **Fill-anchored stops & sizing.** The stop, recorded entry, and notional originally used the
  scanner's _signal_ price. When the market moved between scan and fill, the stop could land
  beyond the liquidation point — H filled 53% from signal, stop stranded above liquidation,
  position liquidated instead of stopping out. Fix: after the market entry fills, read the
  actual average fill (`avgEntryPrice` on KuCoin / `avgPrice` on Bybit) and derive stop +
  bookkeeping from THAT. If the fill can't be read or the stop is rejected, the entry is
  immediately closed rather than left unprotected (close-if-unprotected). Confirmed live: H
  later filled at 0.087, stop at 0.0999 (+15%), stopped out at −13% instead of liquidating.
- **Venue-agreement guard + `EXCLUDE_COINS`.** `H` is priced ~2× apart on Bybit (0.19) vs
  KuCoin (0.099) — a token redenomination that hit one venue, confirmed live. Every Bybit
  signal therefore mis-describes the KuCoin instrument. `H` is now hard-excluded (scanner,
  universe runner, both executors). Generic guard: before ordering, the executor compares the
  live trading-venue price to the signal's entry and skips on >15% divergence
  (`MAX_SIGNAL_DIVERGENCE`) — catches cross-venue mismatches and genuine staleness; logs a
  Telegram ⚠️ so the threshold can be tuned. A useful side effect: it bounds the signal-price
  sizing error to <15%.
- **`reentryCooldownH 24`** — after a coin stops out, do not re-short it for 24h. Live logs
  showed serial re-stacking into a still-squeezing coin (HOME re-opened 7 min after an −$82
  stop), a net loser. Universe sim (60d, H-excluded) full-window at 24h: return +571%→+715%,
  max drawdown −49%→−23%, win rate 70%→73%. BUT the out-of-sample split (`simulate_portfolio.ts
  --split`) shows the benefit is **regime-dependent**: the high-drawdown first half halves DD
  and lifts return; the benign second half _loses_ return (343%→244%) with no DD to save. It
  is therefore **drawdown insurance**, adopted deliberately to prioritise not blowing up,
  accepting lower return in favourable regimes — not a free edge. 24h chosen over 48h/72h: it
  captures most of the DD protection and aligns with `timeoutH`.

**Rejected here (same investigation), on the data:** a runaway-funding ceiling (skip BUILDING
at clamp-level funding) and a squeeze-stall delayed entry (wait for the squeeze to top before
shorting). Both only cost return — with a correctly-anchored stop every trade is already
bounded at ~1R, so entry/queue filters only remove net-positive trades. The lesson:
enter-immediately + stop + timeout is the edge; the cooldown works only because it removes a
genuinely net-negative subset (re-stacks), not because it filters signal quality.

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
- **Cap / tighten extreme funding for BUILDING** — ⚠️ **REVERSED 2026-06-14.** This was
  rejected on **win rate** (the -2000%+ band ties for best, ~79–80%). That data was incomplete:
  funding was not modelled. With integrated funding the deepest band is a net loser, and a
  `-2000%` ceiling is now adopted. See "Funding ceiling" below.
- **OI-rising gate on BUILDING** — 100% OI coverage in the test; the gate removed 14 signals
  (13 winners, 1 loser), win rate 73%→72%. It is anti-selective — it removes the violent
  mega-squeezes that do reverse.
- **Drop PUMP_TOP / run BUILDING-only** — PUMP_TOP is the best signal type (~76% win);
  removing it lowers the blended rate and cuts diversification.

General lesson: win rate can almost always be nudged up by cutting trades, and almost always
loses money doing so. Judge changes on realized P&L and drawdown, not win rate.

## Funding ceiling (2026-06-14)

BUILDING is now queued only in a **band**: `-2000% < fundingApr ≤ -180%`. The `-2000%` ceiling
(`MAX_EXTREME_FUNDING_APR` in `live_scanner.ts` + both executors; `buildingMaxExtremeFundingApr`
in `backtest_signals.ts`) was added after the funding-cost work made realized P&L measurable.

**Why it was missed before.** Earlier analysis judged extreme funding on **win rate**, where the
`≤-2000%` band looks great (~80% win, lowest adverse excursion). But funding was never modelled.
Once realized funding was integrated from the actual per-settlement path (matching live KuCoin
fills — e.g. ASTR -1.67% modelled vs -1.65% paid), the picture inverted.

**The evidence** (24h universe, integrated funding, live risk):

- Per-trade all-in R by funding band (BUILDING): every band from -180% to -2000% is solidly
  net-positive (+0.22 to +0.35R), but the `≤-2000%` band is a **net loser (-0.19R)** despite the
  highest price edge (+0.51R, 80% win) — carry (-0.70R) overwhelms it. The carry is front-loaded
  (most paid in the first 24h), so it does not shrink at the live timeout.
- Portfolio (funding-adjusted, `simulate_portfolio.ts` ceiling sweep): a `-2000%` ceiling lifted
  return **+228%→+526%** and cut MaxDD **-62%→-23%**. Out-of-sample: neutral-to-positive in the
  first half (few bombs present), and in the second half flipped a **-19% / -62% MaxDD** disaster
  to **+42% / -19% MaxDD**. `-2000%` was the best threshold in BOTH halves.

So the ceiling is as much drawdown insurance as a return boost — the -62% baseline drawdowns
*are* the extreme-funding mega-squeezes. Re-validate (return + drawdown + OOS, never win rate)
before moving the threshold. Tooling: `analyze_stops.ts` (all-in R by funding band) and
`simulate_portfolio.ts --split` (ceiling sweep, OOS).

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

### Known type gaps (shared_types.ts)

`PositionRecord.signalType` is typed `"EXHAUSTION" | "TREND_BREAK" | "BUILDING"` but
`PUMP_TOP` is now tradeable — the executor force-casts via `signalType as
PositionRecord["signalType"]`. `closeReason` still includes `"target"` and `"trailing"`,
which the current executor never produces (no TP, no trailing stop). Harmless at runtime;
worth tightening if `shared_types.ts` is next edited.

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
| Timeout              | 48h (early)                           | 24h                                                             | 2026-05-28 sweep: 12h/24h/48h/72h inverted-V; 24h ~halves drawdown vs 48h       |
