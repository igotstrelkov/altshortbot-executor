# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

AltShortBot is a two-process trading bot for shorting overheated altcoin perpetuals on Hyperliquid. The architecture is split intentionally:

- **Scanner** (`live_scanner.ts`) — runs hourly, scans every active Bybit USDT perp, detects signals, sends Telegram alerts, and writes tradeable signals to `signal_queue.json`.
- **Executor** (`hl_executor.ts`) — runs every 5 minutes, reads and clears the queue, places real or paper shorts on Hyperliquid, manages open positions, sends Telegram updates.

The two communicate **only** via JSON files on disk (`signal_queue.json`, `hl_positions.json`). They never share memory and never call each other directly.

PM2 runs them as `altshortbot-scanner` (cron `5 * * * *`) and `altshortbot-executor` (cron `*/5 * * * *`). The executor ships with `--paper` baked into [ecosystem.config.js](ecosystem.config.js) — flipping to live is a one-line edit.

## The plan is the spec

[ALTSHORTBOT_COMPLETE_PLAN.md](ALTSHORTBOT_COMPLETE_PLAN.md) is the authoritative implementation guide, broken into 11 numbered stages. Always read the relevant stage before writing code — the plan calls out exact integration points, the JSON schema between processes, and risk parameters that have been tuned.

The plan also explicitly forbids rebuilding `backtest_signals.ts`, `backtest_test.ts`, `live_scanner.ts`, `ecosystem.config.js`, and `fixtures/` from scratch. Only the modifications named in Stages 1, 2e, and 10 are allowed against those files.

## Common commands

```bash
# ─── Scanner ────────────────────────────────────────────────────────────────
npx tsx live_scanner.ts                              # full Bybit universe
npx tsx live_scanner.ts --coins ORDI --dry-run       # single coin, no Telegram
npx tsx live_scanner.ts --watch                      # dev only; PM2 handles prod

# ─── Executor (paper mode short-circuits all order code paths) ──────────────
npx tsx hl_executor.ts --paper                       # simulate trades
npx tsx hl_executor.ts --paper --status              # open positions + paper P&L
npx tsx hl_executor.ts                               # LIVE — real orders

# ─── Backtest + regression tests ────────────────────────────────────────────
npx tsx backtest_signals.ts --coin ORDI --days 30 --chart   # see file header for validated CLI
npx tsx backtest_test.ts                             # all coins
npx tsx backtest_test.ts ORDI                        # single coin
npx tsx backtest_test.ts --update-fixtures           # re-capture from live API
npx tsx scanner_test.ts                              # live-scanner regression on fixtures
npx tsx scanner_test.ts KNC                          # single coin

# ─── Type-check (no tsconfig.json — module flags must be esnext+bundler) ────
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  --lib es2022,dom \
  hl_executor.ts shared_types.ts live_scanner.ts scanner_test.ts
```

PM2 (production): `pm2 start ecosystem.config.js && pm2 save && pm2 startup`. Stage 11 in [ALTSHORTBOT_COMPLETE_PLAN.md](ALTSHORTBOT_COMPLETE_PLAN.md) has the full first-boot and going-live runbook.

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

`Alert`, `QueuedSignal`, `PositionRecord`, `PositionStore`, `PaperTrade` are defined once in [shared_types.ts](shared_types.ts) and imported by both scanner and executor. The scanner used to define `Alert` locally — that's been removed; don't re-introduce it.

### Fixtures + scanner_test.ts

`fixtures/<COIN>.json` files hold `candles`, `fundingBybit`, `fundingBinance`, and `oi` arrays captured from live exchanges. `backtest_test.ts` and `scanner_test.ts` both replay these for deterministic tests. Refresh with `--update-fixtures` only when the algorithm has intentionally changed and old fixtures' expectations no longer hold.

`scanner_test.ts` expectations are **calibrated to actual live-scanner output**, not to the dates in the COMPLETE plan's Stage 2 section. The plan was authored against backtest behaviour (zero-fill funding gaps), which produces different signals than the live scanner's forward-fill. The header comment in `scanner_test.ts` documents this. Don't "fix" the tests by importing the plan's mustInclude list — that would put them back in a permanent-fail state.

The Bybit `/open-interest` endpoint caps at ~200 records (~8 days). Any expected signal earlier than that window can't fire because OI data doesn't exist. The current fixtures cover roughly 2026-04-29 to 2026-05-07 for OI; candles go back further. Don't write expectations for OI-gated signals (EXHAUSTION, Gate-2 FUNDING) before the OI window.

## Executor mechanics that aren't obvious

### Position sizing risks 2% of account, not 6%

`calcPositionSize` is **deliberately different from the plan**. The plan's formula `notional = (riskUsd / stopLossPct) × maxLeverage` produces $5,000 notional on a $10k account at 3× — meaning a 12% stop loses $600 = 6% of account, despite the variable being named `riskPerTrade: 0.02`. The shipped formula is `notional = riskUsd / stopLossPct` ($1,667 notional, $200 stop-loss = 2% of account, three concurrent stops = 6% drawdown). This is a policy choice; flipping it back is a one-line change but should be done knowingly.

Leverage genuinely doesn't enter sizing — it determines margin posted (`margin = notional / leverage`) but not position size or dollar loss at stop. `RISK.maxLeverage` is informational and used only by `updateLeverage`.

### updateLeverage fires before every entry

`openShort` calls `client.updateLeverage({ asset, isCross: true, leverage })` before placing the IOC order, with `leverage = min(RISK.maxLeverage, asset.maxLeverage)`. **Don't remove this** — Hyperliquid leverage is per-account-per-asset; whatever was last set on a coin (default can be 10×–20×) determines liquidation distance. At 20× the liq sits at +5%, well inside our +12% stop, so liquidation would fire before the stop. The clamp is necessary because HL rejects `updateLeverage` values above the asset's published cap.

If `updateLeverage` fails, `openShort` returns null AND fires a Telegram alert (silent skips would look like a dry spell in production). The order itself is then never placed.

### Paper mode short-circuits everything

Every order helper (`openShort`, `placeStopLoss`, `cancelOrder`, `closePosition`) starts with `if (IS_PAPER) return -1` (or `return`). 2-4 weeks of clean paper P&L tells you nothing about whether the SDK signing path, `formatPrice`, `updateLeverage`, or order-status parsing actually work. **Testnet is the first time those run.** The going-live procedure in plan Stage 11 has a mandatory `HL_TESTNET=1` step before flipping the flag — don't skip it.

### Price/size formatting comes from the SDK

`@nktkas/hyperliquid/utils` exports `formatPrice(price, szDecimals)` and `formatSize(size, szDecimals)` which implement Hyperliquid's tick/lot rules (max `6 - szDecimals` decimal places, max 5 sig figs, integer prices always allowed, throws `RangeError` on zero). We use those, not custom helpers. If anyone reintroduces a hand-rolled `.toFixed(4)` they'll get silent live-mode order rejections on assets with `szDecimals ≥ 3`.

### About half of Bybit signals never trade

The scanner runs against Bybit's ~400 USDT perps; Hyperliquid lists ~230 perps. The intersection is roughly half. `executeSignal` skips with `coin: not listed on Hyperliquid` for the rest. This is expected behaviour, not a bug — surfacing it in PM2 logs is fine.

### Queue file races

`signal_queue.json` uses non-atomic read-modify-write. Both `appendToQueue` (scanner) and `loadQueue` (executor) wrap `JSON.parse` in try/catch returning `[]` on failure, which handles the truncated-read case during a partial write. The wider race (scanner appending between executor's read and `clearQueue`) is **not** handled — that signal can be lost or double-processed in a sub-second window. Plan Critical Note #1 accepts this tradeoff. Cheapest hardening if it ever matters in practice: atomic write via `writeFile(tmp); rename(tmp, queue.json)` plus changing executor's `clearQueue` to `queue.filter(s => !processed.includes(s))` instead of unconditional truncation.

## Plan deviations summary

For when someone asks "why is the code different from the plan":

| Where | Plan | Shipped | Rationale |
|---|---|---|---|
| Stage 5 `formatPrice` | `.toFixed(4)` | SDK `formatPrice` from `@nktkas/hyperliquid/utils` | Plan's hard-coded 4dp fails HL validation for `szDecimals ≥ 3` |
| Stage 5 `HttpTransport` | `{ url: API_URL }` | `{ isTestnet: IS_TESTNET }` | Plan option name doesn't exist on the SDK |
| Stage 5 `openShort` | 4 args, no leverage management | 6 args; calls `updateLeverage` first; Telegram on failure | HL leverage is per-position-at-entry; without setting, liq could fire before stop |
| Stage 6 sizing math | `notional = marginUsed × maxLeverage` (6% real risk) | `notional = riskUsd / stopLossPct` (2% real risk) | Plan formula contradicted its own variable name |
| Stage 6 size precision | `Math.min(szDecimals, 4)` cap | full `szDecimals` (and SDK formatter handles it) | Cap was paranoia; SDK truncates correctly |
| Stage 8 `closeReason` | `string` + `as any` cast | typed union `"stop"\|"target"\|"trailing"\|"timeout"` | Drop the cast, catch typos at compile time |
| Stage 10 PM2 name | `altshortbot` | `altshortbot-scanner` + `altshortbot-executor` | Two processes need distinct names |

## Environment

Required (always): `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
Required for live executor: `HL_WALLET_ADDRESS` (main wallet, read-only on this side), `HL_AGENT_KEY` (separate agent-only private key).
Optional: `HL_TESTNET=1` (point both read and SDK transport at testnet), `HL_PAPER_ACCOUNT` (simulated account size for paper mode, default $10,000), `SCANNER_COINS` (comma-separated override of the Bybit universe scan).

The agent key vs main key split is the load-bearing safety property: only the agent key sits on the VPS, only it can be lost if the box is compromised, and it can be revoked at any time at app.hyperliquid.xyz → Settings → API. The main key (which custodies USDC) never touches this codebase.
