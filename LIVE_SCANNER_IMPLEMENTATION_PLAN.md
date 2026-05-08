# AltShortBot Live Scanner — Implementation Plan

## Purpose
Build a live scanner that runs every hour, detects 4 signal types across a watchlist
of altcoin perpetuals, and sends Telegram alerts. The scanner shares signal detection
logic with a validated backtest engine (`backtest_signals.ts`).

---

## Project Context

The backtest engine has been validated across 10 coins (HYPER, HIVE, KNC, WIF, BSB,
SPK, ENJ, ORDI, ENA, DASH) with the following validated parameter set:

```bash
--threshold 10 --min-positive 2 --min-oi 2 --max-price 2
--pump-pct 25 --pump-vol 5 --pump-rsi 88 --pump-funding 0
--squeeze-pct 20 --squeeze-hours 10 --squeeze-funding -100 --squeeze-oi-drop 0
--exhaust-funding -20 --lookahead 48
```

The live scanner must implement the same signal logic with identical parameters.

---

## Architecture

```
live_scanner.ts          — main entry point
scanner_state.json       — persisted coin state (auto-created, gitignored)
backtest_signals.ts      — reference implementation (do not modify)
```

### Files to create
1. `live_scanner.ts` — the complete scanner (all logic in one file)
2. `.env.example` — template for TELEGRAM_TOKEN and TELEGRAM_CHAT_ID
3. `scanner_state.json` — auto-created on first run

### Runtime
- TypeScript via `npx tsx live_scanner.ts`
- No build step required
- No external dependencies beyond `tsx` and `typescript` (already in package.json)

---

## Stage 1 — Types and Configuration

Define all types and the validated parameter constants.

### CoinState interface
```typescript
interface CoinState {
  // Wave tracking
  squeezeWaveStartMs:     number | null;  // when current squeeze wave started
  squeezeWaveHighPrice:   number;          // highest price in current squeeze wave
  lastBuildingSignalMs:   number | null;  // timestamp of last BUILDING alert fired
  lastBuildingMinFunding: number;          // most negative APR seen in wave (persists across wave resets — needed for TREND_BREAK)
  lastSqueezePhase:       "BUILDING" | "EXHAUSTION" | "TREND_BREAK" | null;

  // Per-wave fired flags — reset when wave ends so new waves fire fresh alerts
  waveAlertedBuilding:    boolean;         // BUILDING fires once per wave
  waveAlertedTrendBreak:  boolean;         // TREND_BREAK fires once per trending episode

  // EXHAUSTION: timestamp-based (not boolean) — allows re-fire after 6h gap
  // WHY: first exhaustion can fire too early (MEDIUM confidence). Boolean would block
  // the later HIGH confidence signal on the same wave. 6h gap allows it through.
  lastExhaustionMs:       number | null;
  // Funding alert
  lastFundingAlertMs:     number | null;
  // Trend state — needed to detect when coin exits uptrend and reset waveAlertedTrendBreak
  wasTrending:            boolean;
}

// NOTE: Do NOT add signal history, prices, or outcomes to CoinState.
// Those belong in signal_log.db (SQLite) — a separate store added later.
// scanner_state.json is transient operational state only.
```

### Alert interface
```typescript
interface Alert {
  coin:            string;
  type:            "FUNDING" | "PUMP_TOP" | "BUILDING" | "EXHAUSTION" | "TREND_BREAK";
  firedAt:         number;    // Unix ms timestamp — required for signal_log.db + test assertions
  firedAtStr:      string;    // "2026-05-02 09:00" — used in scanner_test.ts approxHour matching
  entry:           number;    // current price at signal time
  fundingApr:      number;    // merged funding APR at signal time
  details:         string;    // signal-specific detail string (see Stage 8 for format per type)
  confidence:      "HIGH" | "MEDIUM" | "LOW";
  msSinceBuilding: number | null;  // null = no prior building in session
}
```

### Validated parameters (hardcoded constants, not CLI flags)
```typescript
const FUNDING_COOLDOWN_MS = 8 * 3_600_000;  // once per Bybit settlement cycle
const MIN_EXHAUSTION_GAP_H = 6;              // min hours between exhaustion re-fires

const BB_BASE = "https://api.bybit.com";
const HOUR    = 3_600_000;
const floorH  = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const avgArr  = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

const PARAMS = {
  // Gate 1 — crowded longs
  fundingAprThreshold:   10,    // % APR
  minPositiveReadings:    2,    // out of last 8 hourly readings

  // Gate 2 — OI divergence
  minOiChangePct:         2,    // % OI growth over 4h
  maxPriceChangePct:      2,    // max price movement % (price must be flat)

  // Pump top
  pumpMinPct:            25,    // min candle size %
  pumpMinVolMult:         5,    // min volume multiple vs 48h avg
  pumpMinRsi:            88,    // min RSI at trigger hour
  pumpMinFundingApr:      0,    // funding must be positive (confirms crowded longs)

  // Short squeeze — building phase
  squeezeMinPct:         20,    // min cumulative price rise % over window
  squeezeHours:          10,    // hour window for cumulative calculation
  squeezeMaxFundingApr: -100,   // funding must be BELOW this (building phase)
  squeezeMinOiDrop:       0,    // OI drop % required (0 = disabled, OI data unreliable)

  // Short squeeze — exhaustion phase
  exhaustMaxFundingApr:  -20,   // funding must be ABOVE this (genuinely normalised)
                                 // Tighter than building (-100%) to prevent false exhaustion
                                 // when funding oscillates between -200% and -50% mid-squeeze

  // Trend filter
  trendDays7Pct:         30,    // 7-day price rise % to classify as parabolic uptrend
  trendDays14Pct:        50,    // 14-day price rise % to classify as parabolic uptrend
  trendBreakFundingApr: -500,   // lastBuildingMinFunding must be below this for TREND_BREAK
} as const;
```

### Coin discovery
The scanner runs against **all active USDT perpetuals** — not a fixed watchlist.
The 9 validation coins (HYPER, HIVE, KNC, WIF, BSB, SPK, ENJ, ORDI, DASH) were
used to tune the algorithm. Those parameters now apply universally to every coin.

New listings are picked up automatically on each run. Delisted coins (403 response)
are skipped silently.

```typescript
// Skip index tokens and large caps that almost never fire the strategy
const EXCLUDE_COINS  = new Set(["BTC", "ETH", "BNB", "BTCDOM"]);
const FALLBACK_COINS = ["HYPER", "HIVE", "KNC", "WIF", "BSB", "SPK", "ENJ", "ORDI", "DASH"];

async function fetchAllCoins(): Promise<string[]> {
  try {
    const data = await fetchJSON(
      `${BB_BASE}/v5/market/instruments-info?category=linear&status=Trading&limit=1000`
    ) as { result?: { list?: { symbol: string; quoteCoin: string }[] } };
    const coins = (data?.result?.list ?? [])
      .filter(s => s.quoteCoin === "USDT")
      .map(s => s.symbol.replace("USDT", ""))
      .filter(c => !EXCLUDE_COINS.has(c))
      .sort();
    if (coins.length) return coins;
  } catch { /* fall through to fallback */ }
  console.warn("  ⚠️  Could not fetch coin list — using fallback validated set");
  return FALLBACK_COINS;
}

// --coins flag or SCANNER_COINS env overrides full discovery
async function getCoins(): Promise<string[]> {
  const arg = process.argv.find((_, i) => process.argv[i - 1] === "--coins");
  const env = process.env.SCANNER_COINS;
  if (arg ?? env) return (arg ?? env)!.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
  return fetchAllCoins();  // full Bybit universe
}
```

**Scalability note:** Bybit currently lists ~400 active USDT perpetuals. At 150ms
delay between coins + ~1.5s fetch time each, a full scan takes ~6 minutes —
comfortably within the hourly window. If coin count grows beyond 500, batch in
groups of 20 with a 1s pause between groups.

---

## Stage 2 — State Persistence

Load and save `CoinState` per coin between runs. This is critical — the scanner
must remember squeeze wave context across hourly executions.

```typescript
const STATE_FILE = "scanner_state.json";

function loadState(): Record<string, CoinState> {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function saveState(state: Record<string, CoinState>): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function defaultState(): CoinState {
  return {
    // Wave tracking
    squeezeWaveStartMs:     null,
    squeezeWaveHighPrice:   0,
    lastBuildingSignalMs:   null,
    lastBuildingMinFunding: 0,
    lastSqueezePhase:       null,
    // Per-wave fired flags
    waveAlertedBuilding:    false,
    waveAlertedTrendBreak:  false,
    // Exhaustion re-fire tracking
    lastExhaustionMs:       null,
    // Funding cooldown
    lastFundingAlertMs:     null,
    // Trend tracking (for waveAlertedTrendBreak reset)
    wasTrending:            false,
  };
}
```

Also add to `.gitignore` on first setup:
```bash
echo "scanner_state.json" >> .gitignore
echo "logs/" >> .gitignore
```

State resets per coin:
- `squeezeWaveStartMs`, `squeezeWaveHighPrice`: reset when `sq.triggered === false`
- `lastBuildingMinFunding`: **DO NOT reset on wave end** — persists so TREND_BREAK
  can fire even when the wave briefly drops out between squeeze episodes
- `lastSqueezePhase`: reset to null when wave ends and last phase was BUILDING
- `lastBuildingSignalMs`: never resets; always tracks when last BUILDING was pushed

---

## Data Architecture — Two Separate Stores

**Do not mix operational state with signal history.** They have different lifetimes,
different failure modes, and different consumers.

```
scanner_state.json      — transient operational state (overwritten every hour)
signal_log.db           — permanent audit trail (append-only, grows forever)
```

### scanner_state.json — operational state only

Stores only what the scanner needs to function correctly between hourly runs:
wave tracking, fired flags, last building timestamp. This file:

- Is overwritten every run
- Can be deleted safely — scanner self-heals on next run (loses only current wave context)
- Should NEVER contain historical signals or outcomes
- Will stay small forever (~500 bytes per coin)

```typescript
interface CoinState {
  squeezeWaveStartMs:     number | null;
  squeezeWaveHighPrice:   number;
  lastBuildingSignalMs:   number | null;
  lastBuildingMinFunding: number;          // persists across wave resets (needed for TREND_BREAK)
  lastSqueezePhase:       "BUILDING" | "EXHAUSTION" | "TREND_BREAK" | null;
  waveAlertedBuilding:    boolean;         // fired BUILDING in current wave
  waveAlertedTrendBreak:  boolean;         // fired TREND_BREAK in current trending episode
  lastExhaustionMs:       number | null;   // last exhaustion alert timestamp (6h re-fire gap)
  lastFundingAlertMs:     number | null;   // funding can re-qualify after resetting
  wasTrending:            boolean;          // detects uptrend exit to reset waveAlertedTrendBreak
}
```

Reset `waveAlerted*` flags when the wave ends so a new squeeze wave fires fresh alerts.
Do NOT add signal timestamps, prices, or outcomes to this schema.

### signal_log.db — permanent history (add later, not in MVP)

Add this when you want signal history, performance tracking, or a dashboard.
Requires no changes to `scanner_state.json` or `CoinState` — purely additive.

```sql
-- Every signal ever fired by the live scanner
CREATE TABLE signals (
  id            INTEGER PRIMARY KEY,
  coin          TEXT    NOT NULL,
  type          TEXT    NOT NULL,  -- BUILDING | EXHAUSTION | TREND_BREAK | FUNDING | PUMP_TOP
  firedAt       INTEGER NOT NULL,  -- Unix ms timestamp
  entryPrice    REAL    NOT NULL,  -- price at signal time
  fundingApr    REAL    NOT NULL,  -- merged funding APR at signal time
  confidence    TEXT    NOT NULL,  -- HIGH | MEDIUM | LOW
  msSinceBuilding INTEGER,         -- null = no prior building in session
  cumulativePct REAL,              -- squeeze cumulative % (squeeze signals only)
  createdAt     INTEGER DEFAULT (unixepoch() * 1000)
);

-- Resolved 48h after signal fires (a scheduled job checks price and writes outcome)
CREATE TABLE outcomes (
  signalId      INTEGER PRIMARY KEY REFERENCES signals(id),
  resolvedAt    INTEGER NOT NULL,
  maxAdversePct REAL    NOT NULL,  -- worst move against the short
  finalPct      REAL    NOT NULL,  -- price change at 48h
  verdict       TEXT    NOT NULL   -- DROPPED | PUMP+DUMP | SQUEEZED | NEUTRAL
);
```

### Live scanner write path (when signal_log.db is added)

```
Each hourly run:
  1. Load scanner_state.json          ← operational state
  2. Detect signals for each coin
  3. Send Telegram alerts
  4. INSERT INTO signals (...)        ← permanent history
  5. Save scanner_state.json          ← updated operational state

Separate daily job:
  6. SELECT * FROM signals WHERE firedAt < now - 48h AND id NOT IN outcomes
  7. Fetch current price for each coin
  8. INSERT INTO outcomes (...)       ← resolve pending signals
```

### What this enables later

- Win rate by signal type, coin, confidence level
- P&L simulation with real entries
- "Show me all HIGH confidence EXHAUSTION signals in the last 30 days"
- Dashboard with live signal feed + historical performance
- Backtesting the live scanner's actual performance (not synthetic)


---

## Stage 3 — Data Fetching

Fetch the minimum data required for each signal type.

### 3a. Price candles — Bybit
```
GET https://api.bybit.com/v5/market/kline
  category: linear
  symbol:   {COIN}USDT
  interval: 60        ← 60 minutes = 1h candles
  limit:    500       ← 500 hours = ~20 days; trend filter needs 336h + RSI warmup
```
Returns `{ result: { list: [[openTime, open, high, low, close, volume, ...]] } }`.
**List is newest-first — reverse before use.**
Parse to `Candle[]`: `{ t, o, h, l, c, v }`.

If coin is not listed on Bybit (404/empty), skip silently.
If fewer than 50 candles returned, skip (insufficient data).

### 3b. Funding history — Bybit
```
GET https://api.bybit.com/v5/market/funding/history
  category: linear
  symbol:   {COIN}USDT
  limit:    200
```
Returns `{ result: { list: [{ fundingRateTimestamp, fundingRate }] } }`.
List is newest-first — reverse to chronological order.

**Do NOT hardcode `/8`.** Bybit settlement intervals vary by coin (4h or 8h).
Fetch the actual interval from instrument info and normalise:
```typescript
// GET /v5/market/instruments-info?category=linear&symbol={COIN}USDT
// → result.list[0].fundingInterval (in minutes)
const intervalHours = (inst?.fundingInterval ?? 480) / 60;
const ratePerHour   = parseFloat(r.fundingRate) / intervalHours;
```
Copy `fetchBybitFundingHistory()` from `backtest_signals.ts` verbatim.

### 3c. OI history — Bybit
```
GET https://api.bybit.com/v5/market/open-interest
  category:     linear
  symbol:       {COIN}USDT
  intervalTime: 1h
  limit:        20
```
Returns `{ result: { list: [{ timestamp, openInterest }] } }`.

**Bybit `openInterest` is in contracts (base currency), NOT USD.**
Multiply by per-timestamp price from candles for USD comparison:
```typescript
const priceByHour: Record<number, number> = {};
for (const c of candles) priceByHour[floorH(c.t)] = c.c;
oiHistory = rawOI.reverse().map(r => {
  const price = priceByHour[floorH(parseInt(r.timestamp))] ?? candles.at(-1)!.c;
  return { timeMs: parseInt(r.timestamp), oiUsd: parseFloat(r.openInterest) * price };
});
```

### 3d. Fetch order for each coin
```
1. fetchCandles(coin, 500)       → Bybit kline
2. fetchFundingBybit(coin)       → Bybit funding history (includes interval fetch)
3. buildFundingByHour(funding)   → forward-fill to per-hour lookup (Stage 4)
4. fetchOIHistory(coin, candles) → Bybit OI with price conversion
```
Add 150ms delay between coins. Fetch candles and funding in parallel:
```typescript
const [candles, bbFunding] = await Promise.all([
  fetchCandles(coin, 500),
  fetchFundingBybit(coin),
]);
```

### 3e. Startup delay for funding settlement
Run cron at :05 past the hour (not :02) to allow exchanges 5 minutes to publish
the new settlement data after the top-of-hour settle:
```cron
5 * * * * cd /path/to/altshortbot && npx tsx live_scanner.ts >> logs/scanner.log 2>&1
```

### Retry logic
Wrap all fetch calls: retry up to 3 times with exponential backoff (1s, 2s, 4s).
On 403: log warning and return empty array (coin may be delisted).
On 429: wait 2s before retry.

---

## Stage 4 — Funding by Hour

Forward-fill Bybit funding records into a per-hour lookup. Single source — no merge needed.

```typescript
function buildFundingByHour(records: FundingRecord[]): Record<number, number> {
  const sorted = [...records].sort((a, b) => a.timeMs - b.timeMs);
  if (!sorted.length) return {};

  // Forward-fill between Bybit settlement timestamps (every 4h or 8h).
  // Without forward-fill, non-settlement hours return 0 via ?? 0, making
  // squeeze detection fail for 7 of every 8 hours on 8h-settlement coins.
  const byHour: Record<number, number> = {};
  let last  = 0;
  let rIdx  = 0;
  const startTs = floorH(sorted[0].timeMs);
  const endTs   = floorH(Date.now()) + HOUR;  // include current hour

  for (let ts = startTs; ts <= endTs; ts += HOUR) {
    // Advance index for any records that fall on or before this hour
    while (rIdx < sorted.length && floorH(sorted[rIdx].timeMs) <= ts) {
      last = sorted[rIdx].ratePerHour;
      rIdx++;
    }
    byHour[ts] = last;  // forward-fill: carry last settlement rate forward
  }
  return byHour;
}
```

Result: `Record<number, number>` mapping every `hourTimestamp → ratePerHour`.
To convert to APR for display: `fundingApr = ratePerHour * 8760 * 100`.

Note: The backtest (`backtest_signals.ts`) uses `mergeToHighestFunding` across
Binance + Bybit. The live scanner is Bybit-only so the merge is unnecessary.
Signal quality is equivalent — Bybit dominated 87-96% of hours during backtest validation.

---

## Stage 5 — Signal Detection Functions

Copy these four functions verbatim from `backtest_signals.ts`. Do not modify logic.

### 5a. RSI calculation
```typescript
function calcRSI(candles: Candle[], period = 14): number
```
Standard Wilder RSI over last `period` candles.
Returns 50 if insufficient data.

### 5b. Pump top detection
```typescript
function detectPumpTop(
  candles:    Candle[],
  fundingNow: number,  // per-hour rate (NOT APR) — function converts internally
): { triggered: boolean; candlePct: number; volMult: number; rsi: number }
```
Fires when ALL conditions met on the most recent candle:
- `|close - prevClose| / prevClose * 100 >= pumpMinPct (25%)`
- `currentVolume / avg48hVolume >= pumpMinVolMult (5×)`
- `RSI >= pumpMinRsi (88)`
- `fundingNow * 8760 * 100 >= pumpMinFundingApr (0%)` — converts to APR internally

### 5c. Trend filter
```typescript
function isTrendingFull(
  priceNow: number,
  price7dAgo: number,
  price14dAgo: number
): boolean
```
Returns true when coin is in parabolic uptrend:
- `(priceNow - price7dAgo) / price7dAgo * 100 >= trendDays7Pct (30%)`
- AND `(priceNow - price14dAgo) / price14dAgo * 100 >= trendDays14Pct (50%)`

When trending: block BUILDING and EXHAUSTION signals. Allow TREND_BREAK only.

### 5d. Short squeeze detection
```typescript
function detectShortSqueeze(
  candleWindow: Candle[],  // last squeezeHours+2 candles
  oiSeries:     number[],  // OI values (USD), oldest first
  fundingNow:   number,    // current per-hour rate (not APR)
): { triggered: boolean; phase: "BUILDING" | "EXHAUSTION" | null;
     cumulativePct: number; oiDropPct: number; fundingApr: number }
```
Adapt from `backtest_signals.ts`: remove the `exhaustMaxFunding` parameter
and use `PARAMS.exhaustMaxFundingApr` directly inside the function body.
The backtest takes it as a parameter for flexibility; the scanner hardcodes it.

**Building conditions** (returns `phase: "BUILDING"`):
```
isSqueeze = (
  cumulativePct >= squeezeMinPct (20%)    // price rose significantly
  AND fundingApr <= squeezeMaxFundingApr (-100%)  // shorts paying heavily
  AND oiDropPct >= squeezeMinOiDrop (0%)  // OI not growing (short covering)
)
```
Where `cumulativePct = (windowHigh - startClose) / startClose * 100`.
`windowHigh` = max HIGH across last `squeezeHours` candles (catches grinding moves).

**Exhaustion conditions** (returns `phase: "EXHAUSTION"` when `!isSqueeze`):
```
isExhausting = (
  cumulativePct >= squeezeMinPct * 0.8 (16%)  // still elevated from start
  AND fundingApr > exhaustMaxFundingApr (-20%)  // funding genuinely normalised
  AND fundingApr < 5%                           // not yet strongly positive
  AND recentAvg < avgCandleMove * 0.5           // momentum fading (last 2 candles slow)
  AND lowerHigh                                 // price making lower highs (c[-1].h < c[-3].h)
)
```

Returns `triggered: false` when neither condition is met (wave inactive).

---

## Stage 5b — Scanner Regression Tests (write before Stage 6)

Create `scanner_test.ts` that feeds fixture data through `scanCoin()` hour by hour
and asserts the same signals fire as the validated backtest results.

### Why before Stage 6
Writing tests first forces `scanCoin()` to be a pure, testable function with a
clean interface. Without tests driving the design, signal detection logic tends
to get tangled with HTTP calls and Telegram sending, making it impossible to test.

### File: `scanner_test.ts`

```typescript
/**
 * AltShortBot Live Scanner — Regression Tests
 * ============================================
 * Feeds fixture data through scanCoin() hour by hour and asserts
 * that known-good signals fire with correct types and confidence.
 *
 * Uses the same fixtures/ directory as backtest_test.ts.
 * Fixtures must be captured first:
 *   npx tsx backtest_test.ts  (auto-captures on first run)
 *
 * Run:
 *   npx tsx scanner_test.ts
 *   npx tsx scanner_test.ts KNC   ← single coin
 */
```

### Test data flow
```
fixtures/KNC.json
  ↓ load candles, fundingBybit, oi (from fixture file)
  ↓ buildFundingByHour(fundingBybit) → per-hour lookup (Bybit-only, matches live scanner)
  ↓ iterate candles hour by hour, carrying CoinState forward
  ↓ call scanCoin(coin, state, candleWindow, fundingByHour, oiWindow)
  ↓ collect all alerts fired
  ↓ assert expected signals present
```

### Key difference from backtest_test.ts
The backtest test spawns a subprocess and checks the final output.
The scanner test calls `scanCoin()` directly per hour, carrying state
forward — this is what the live scanner does in production.

```typescript
const MIN_WINDOW = PARAMS.squeezeHours + 15;  // enough candles for RSI warmup

// Simulate the live scanner running hourly over fixture data
const allAlerts: Alert[] = [];
const finalStates: Record<string, CoinState> = {};  // for state transition assertions
let state = defaultState();

for (let i = MIN_WINDOW; i < candles.length; i++) {
  const candleWindow = candles.slice(0, i + 1);
  const currentHour  = candles[i].t;
  const oiWindow     = oiHistory.filter(r => r.timeMs <= currentHour).slice(-10);

  const { alerts, newState } = scanCoin(
    coin, state, candleWindow, fundingByHour, oiWindow
  );

  allAlerts.push(...alerts);
  state = newState;
}
finalStates[coin] = state;  // save for state transition assertions
```

### Test cases

```typescript
interface ScannerTestCase {
  coin:   string;
  expect: {
    minAlerts?:        number;
    minWins?:          number;    // alerts with confidence HIGH or MEDIUM
    mustInclude?:      Array<{
      type:       "FUNDING" | "PUMP_TOP" | "BUILDING" | "EXHAUSTION" | "TREND_BREAK";
      confidence?: "HIGH" | "MEDIUM" | "LOW";
      approxHour?: string;  // "2026-05-02" — date prefix is enough (exact hour may shift ±1h)
    }>;
    mustNotInclude?:   Array<{ type: string; approxHour: string }>;
    stateAfter?: {
      lastSqueezePhase?: string | null;
    };
  };
}

const TESTS: ScannerTestCase[] = [
  {
    coin: "KNC",
    expect: {
      minAlerts: 2,  // minimum: 1 BUILDING + 1 EXHAUSTION
      mustInclude: [
        { type: "BUILDING",   confidence: "MEDIUM", approxHour: "2026-05-02" },
        { type: "EXHAUSTION", confidence: "HIGH",   approxHour: "2026-05-02" },
        // Subsequent exhaustions fire if 6h+ apart — KNC had 4 exhaustions 4-13h apart
        // so minAlerts may be higher in practice; assert minimum only
      ],
    },
  },
  {
    coin: "HIVE",
    expect: {
      mustInclude: [
        { type: "PUMP_TOP",   approxHour: "2026-05-05" },
        { type: "BUILDING",   approxHour: "2026-05-05" },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-05-05" },
      ],
    },
  },
  {
    coin: "ORDI",
    expect: {
      mustInclude: [
        { type: "BUILDING",   approxHour: "2026-04-16" },
        // Apr 16 10:00: EXHAUSTION fires (2h after building → MEDIUM confidence, bad outcome)
        // Apr 16 18:00: EXHAUSTION re-fires (8h after previous → 6h gap passed → HIGH confidence)
        // Both should fire with lastExhaustionMs timestamp-based suppression:
        { type: "EXHAUSTION", confidence: "MEDIUM", approxHour: "2026-04-16 10" },
        { type: "EXHAUSTION", confidence: "HIGH",   approxHour: "2026-04-16 18" },
        { type: "EXHAUSTION", confidence: "HIGH",   approxHour: "2026-04-17" },
      ],
    },
  },
  {
    coin: "SPK",
    expect: {
      mustInclude: [
        { type: "BUILDING",    approxHour: "2026-04-20" },
        { type: "TREND_BREAK", confidence: "HIGH", approxHour: "2026-04-23" },
        // Only 1 TREND_BREAK per trending episode (waveAlertedTrendBreak blocks the second).
        // The backtest fired 2 (Apr 23 14:00 and 18:00), but the scanner fires only the first.
      ],
    },
  },
  {
    coin: "ENJ",
    expect: {
      minAlerts: 20,  // 23 building + 2 exhaustion
      mustInclude: [
        { type: "BUILDING",   approxHour: "2026-04-08" },   // first wave
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-04-19" },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-04-24" },
      ],
    },
  },
  {
    coin: "HYPER",
    expect: {
      mustInclude: [
        { type: "FUNDING",      approxHour: "2026-05-04" },
        { type: "PUMP_TOP",     approxHour: "2026-04-25" },
        { type: "TREND_BREAK",  confidence: "HIGH", approxHour: "2026-04-25" },
      ],
    },
  },
];
```

### Assertion helpers

```typescript
function assertMustInclude(
  alerts: Alert[],
  expected: { type: string; confidence?: string; approxHour?: string }
): string | null {
  const match = alerts.find(a =>
    a.type === expected.type &&
    (!expected.confidence || a.confidence === expected.confidence) &&
    (!expected.approxHour  || a.firedAtStr.startsWith(expected.approxHour))
  );
  if (!match) {
    return `Missing: ${expected.type}${expected.confidence ? ` [${expected.confidence}]` : ""} around ${expected.approxHour ?? "any time"}`;
  }
  return null;
}
```

### State transition assertions
After replaying all fixture hours, assert the final `CoinState` is correct:
```typescript
// ENJ: last squeeze phase should be null (wave ended after Apr 24)
// KNC: wave should be fully reset (exhaustion completed)
// SPK: lastBuildingMinFunding should be <= -500 (needed for trend break detection)
if (tc.expect.stateAfter?.lastSqueezePhase !== undefined) {
  if (state.lastSqueezePhase !== tc.expect.stateAfter.lastSqueezePhase) {
    failures.push(`State: lastSqueezePhase expected ${tc.expect.stateAfter.lastSqueezePhase}, got ${state.lastSqueezePhase}`);
  }
}
```

### Critical: test that lastBuildingMinFunding persists across wave resets
```typescript
// For SPK: building fired at -135% APR, then wave reset,
// then TREND_BREAK fired. lastBuildingMinFunding must have persisted.
// If it reset to 0, the trend break would never have fired.
const spkState = finalStates["SPK"];
if (spkState.lastBuildingMinFunding > -500) {
  failures.push(`SPK: lastBuildingMinFunding should be <= -500 for TREND_BREAK to fire, got ${spkState.lastBuildingMinFunding}`);
}
```

### Run command
```bash
npx tsx scanner_test.ts        # all coins
npx tsx scanner_test.ts KNC    # single coin
```

### Expected output
```
AltShortBot Scanner Regression Tests
══════════════════════════════════════
Using fixtures from fixtures/ (deterministic)
Running 6 test(s)...

  KNC  ✅ 5 alerts — BUILDING + 4×EXHAUSTION [HIGH]
  HIVE ✅ 3 alerts — PUMP_TOP + BUILDING + EXHAUSTION [HIGH]
  ORDI ✅ 9 alerts — 2×BUILDING + 7×EXHAUSTION
  SPK  ✅ 4 alerts — 2×BUILDING + EXHAUSTION + 1×TREND_BREAK [HIGH]
  ENJ  ✅ 25 alerts — 23×BUILDING + 2×EXHAUSTION [HIGH]
  HYPER✅ 3 alerts — FUNDING + PUMP_TOP + 1×TREND_BREAK [HIGH]

══════════════════════════════════════
Results: 6 passed, 0 failed (12s)
```

Note: scanner_test.ts runs faster than backtest_test.ts (~12s vs ~30s)
because it calls scanCoin() directly rather than spawning subprocesses.


---

## Stage 6 — Per-Coin Signal Loop

This is the core logic that runs each hour for each coin. It mirrors the backtest
simulation loop but operates on a single current-hour data point.

### 6a. Module-level helpers (define at top of file, before scanCoin)
These helpers are referenced throughout Stage 6. Define them at module scope.

Also define the sleep helper used in Stage 9:
```typescript
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
```

The `scanCoin` function body must open with and close with:
```typescript
// At the top of scanCoin body:
const alerts:   Alert[]   = [];
const newState: CoinState = { ...state };  // shallow copy — all fields are primitives

// At the bottom of scanCoin body:
return { alerts, newState };
```

Mutate `newState` (not `state`) throughout Stage 6b–6e. The shallow copy is safe
because all CoinState fields are primitives (numbers, booleans, null) — no nested
objects that could alias. The caller stores the returned `newState` with
`state[coin] = newState` and saves it to disk after all coins are scanned.

```typescript
// Format timestamp to readable string for Alert.firedAtStr
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');  // '2026-05-02 09:00'
}

// Get closing price N hours ago from candle array (null if insufficient history)
function getPriceHoursAgo(candles: Candle[], hoursAgo: number): number | null {
  return candles.length > hoursAgo ? candles[candles.length - 1 - hoursAgo].c : null;
}

// Get 8 most recent hourly Bybit funding rates (for Gate 1 positivity check)
function getLast8HourlyFundingReadings(
  merged: Record<number, number>,
  nowTs:  number
): number[] {
  const readings: number[] = [];
  for (let i = 7; i >= 0; i--) {
    const slotTs = Math.floor((nowTs - i * HOUR) / HOUR) * HOUR;
    readings.push(merged[slotTs] ?? 0);
  }
  return readings;  // 8 values as per-hour rates, oldest first
}
```

### 6b. scanCoin signature
```typescript
function scanCoin(
  coin: string,
  state: CoinState,
  candles: Candle[],
  fundingByHour: Record<number, number>,  // per-hour Bybit funding rates
  oiHistory: { timeMs: number; oiUsd: number }[]
): { alerts: Alert[]; newState: CoinState }
```

### 6c. Prepare data inside scanCoin
```typescript
const price    = candles[candles.length - 1].c;
const ts       = candles[candles.length - 1].t;
const hourSlot = Math.floor(ts / HOUR) * HOUR;

// Current Bybit funding rate (per hour, for squeeze detector)
const fRate      = fundingByHour[hourSlot] ?? 0;
const fundingApr = fRate * 8760 * 100;

// OI series for squeeze detection (USD values, oldest first)
const oiSeries = oiHistory.map(r => r.oiUsd);
```

### 6d. Gate 1 check (funding crowded longs)
```typescript
// Count positive readings in last 8 hourly slots
const last8 = getLast8HourlyFundingReadings(fundingByHour, ts);
const positiveCount = last8.filter(r => r * 8760 * 100 >= PARAMS.fundingAprThreshold).length;
const gate1Passes   = positiveCount >= PARAMS.minPositiveReadings;

// Suppress if building alert fired in last 48h
const recentBuilding = newState.lastBuildingSignalMs !== null
  && (ts - newState.lastBuildingSignalMs) < 48 * 3_600_000;

// Suppress during funding cooldown (fired recently)
const fundingCooledDown = newState.lastFundingAlertMs === null
  || (ts - newState.lastFundingAlertMs) >= FUNDING_COOLDOWN_MS;

// Reset funding cooldown when APR drops below threshold (setup expired)
if (fundingApr < PARAMS.fundingAprThreshold) {
  newState.lastFundingAlertMs = null;
}

if (gate1Passes && !recentBuilding && fundingCooledDown) {
  const gate2 = checkGate2(oiHistory, candles);
  if (gate2.passes) {
    alerts.push({
      coin, type: "FUNDING", firedAt: ts,
      firedAtStr: fmtDate(ts), entry: price, fundingApr,
      details: `Funding: ${fundingApr.toFixed(1)}% APR | OI: +${gate2.oiChangePct.toFixed(1)}% over 4h`,
      confidence: "MEDIUM", msSinceBuilding: null,
    });
    newState.lastFundingAlertMs = ts;
  }
}
```

### 6e. Pump top check
```typescript
const pump = detectPumpTop(candles, fRate);  // pass per-hour rate, not APR
if (pump.triggered) {
  alerts.push({
    coin, type: "PUMP_TOP", firedAt: ts, firedAtStr: fmtDate(ts),
    entry: price, fundingApr,
    details: `Candle: +${pump.candlePct.toFixed(1)}% | Volume: ×${pump.volMult.toFixed(0)} | RSI: ${pump.rsi.toFixed(0)}`,
    confidence: "HIGH",
    msSinceBuilding: null,
  });
}
```

### 6f. Trend check
```typescript
const price7d  = getPriceHoursAgo(candles, 7 * 24);   // 168 candles ago
const price14d = getPriceHoursAgo(candles, 14 * 24);  // 336 candles ago
// Guard: if insufficient candle history, treat as not trending (safe default)
const trending = price7d !== null && price14d !== null
  && isTrendingFull(price, price7d, price14d);

// Trend exit detection — runs EVERY hour, outside the squeeze check.
// When a coin exits a parabolic uptrend, reset waveAlertedTrendBreak so
// a future squeeze+trend episode can fire a fresh TREND_BREAK.
const wasTrending = newState.wasTrending ?? false;
if (wasTrending && !trending) newState.waveAlertedTrendBreak = false;
newState.wasTrending = trending;
```

### 6g. Squeeze detection and state update
```typescript
const candleWindow = candles.slice(-(PARAMS.squeezeHours + 2));
const sq = detectShortSqueeze(candleWindow, oiSeries, fRate);
// Note: exhaustMaxFundingApr used internally from PARAMS (not a parameter)

if (sq.triggered && sq.phase) {
  // Track wave state
  if (sq.phase === "BUILDING") {
    if (newState.squeezeWaveStartMs === null) newState.squeezeWaveStartMs = ts;
    if (sq.fundingApr < newState.lastBuildingMinFunding)
      newState.lastBuildingMinFunding = sq.fundingApr;
  }
  if (price > newState.squeezeWaveHighPrice) newState.squeezeWaveHighPrice = price;

  // Determine signal type
  const isTrendBreak = trending
    && sq.phase === "EXHAUSTION"
    && newState.lastBuildingMinFunding <= PARAMS.trendBreakFundingApr;

  const allowNormal = !trending && (
    sq.phase === "BUILDING" ||
    sq.phase === "EXHAUSTION"
  );

  if (isTrendBreak || allowNormal) {
    const phase = isTrendBreak ? "TREND_BREAK" : sq.phase!;  // non-null: checked by if(sq.phase) above

    const msSinceBuilding = newState.lastBuildingSignalMs !== null
      ? ts - newState.lastBuildingSignalMs : null;
    const confidence = getConfidence(phase, msSinceBuilding);

    // Suppression rules:
    // BUILDING / TREND_BREAK  — boolean flag, once per wave/episode
    // EXHAUSTION              — timestamp gap (6h minimum), allows re-fire

    const hoursSinceExhaustion = newState.lastExhaustionMs !== null
      ? (ts - newState.lastExhaustionMs) / 3_600_000 : Infinity;

    const alreadyFired =
      (phase === "BUILDING"    && newState.waveAlertedBuilding)  ||
      (phase === "EXHAUSTION"  && hoursSinceExhaustion < MIN_EXHAUSTION_GAP_H) ||
      (phase === "TREND_BREAK" && newState.waveAlertedTrendBreak);

    if (!alreadyFired) {
      const details =
        phase === "BUILDING"    ? `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Funding: ${fundingApr.toFixed(0)}% APR` :
        phase === "EXHAUSTION"  ? `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Funding: ${fundingApr.toFixed(1)}% APR` :
        /* TREND_BREAK */         `Squeeze: +${sq.cumulativePct.toFixed(1)}% over ${PARAMS.squeezeHours}h | Prior funding: ${newState.lastBuildingMinFunding.toFixed(0)}% APR`;

      alerts.push({
        coin, type: phase, firedAt: ts, firedAtStr: fmtDate(ts),
        entry: price, fundingApr, details, confidence, msSinceBuilding,
      });

      if (phase === "BUILDING")    { newState.waveAlertedBuilding  = true; newState.lastBuildingSignalMs = ts; }
      if (phase === "EXHAUSTION")  { newState.lastExhaustionMs      = ts; }
      if (phase === "TREND_BREAK") { newState.waveAlertedTrendBreak = true; }
    }

    newState.lastSqueezePhase = phase;
  }

} else if (!sq.triggered) {
  // Wave ended — reset wave tracking and per-wave fired flags
  newState.squeezeWaveStartMs   = null;
  newState.squeezeWaveHighPrice = 0;
  newState.waveAlertedBuilding  = false;  // next wave fires fresh BUILDING alert
  newState.lastExhaustionMs     = null;   // next wave allows exhaustion from the start
  // waveAlertedTrendBreak: reset when coin exits trending (handled above in 6d)
  // lastBuildingMinFunding: intentionally NOT reset (needed for TREND_BREAK across wave gaps)
  if (newState.lastSqueezePhase === "BUILDING") newState.lastSqueezePhase = null;
}
```

### 6h. Confidence scoring
```typescript
function getConfidence(
  phase: string,
  msSinceBuilding: number | null
): "HIGH" | "MEDIUM" | "LOW" {
  if (phase === "TREND_BREAK") return "HIGH";  // always strong
  if (phase === "BUILDING")    return "MEDIUM"; // informational
  if (phase === "EXHAUSTION") {
    if (msSinceBuilding === null) return "LOW";  // no prior building
    const hours = msSinceBuilding / 3_600_000;
    if (hours >= 6)  return "HIGH";
    if (hours >= 2)  return "MEDIUM";
    return "LOW";  // too soon after building — squeeze may continue
  }
  return "MEDIUM";
}
```

### 6i. Duplicate suppression summary
- **BUILDING**: `waveAlertedBuilding` boolean — fires once per wave, resets when wave ends
- **EXHAUSTION**: `lastExhaustionMs` timestamp — re-fires after 6h gap, resets when wave ends
- **TREND_BREAK**: `waveAlertedTrendBreak` boolean — fires once per trending episode, resets when coin exits uptrend
- **FUNDING**: `lastFundingAlertMs` timestamp — 8h cooldown, resets when APR drops below threshold (Stage 6d)
- **PUMP_TOP**: single-candle event by definition — can only trigger once per candle

---

## Stage 7 — Gate 2 Implementation

Gate 2 confirms crowded-long setups: OI must be rising while price stays flat.

```typescript
function checkGate2(
  oiHistory: { timeMs: number; oiUsd: number }[],
  candles: Candle[]
): { passes: boolean; oiChangePct: number; priceChangePct: number } {
  // Need at least 5 OI records (4h window)
  if (oiHistory.length < 5) return { passes: false, oiChangePct: 0, priceChangePct: 0 };

  const oiNow  = oiHistory[oiHistory.length - 1].oiUsd;
  const oi4hAgo = oiHistory[oiHistory.length - 5].oiUsd;
  const oiChangePct = oi4hAgo > 0 ? (oiNow - oi4hAgo) / oi4hAgo * 100 : 0;

  // Price change over same 4h window
  const priceNow  = candles[candles.length - 1].c;
  const price4hAgo = candles.length >= 5 ? candles[candles.length - 5].c : priceNow;
  const priceChangePct = Math.abs((priceNow - price4hAgo) / (price4hAgo || 1) * 100);

  const passes = oiChangePct >= PARAMS.minOiChangePct     // OI rising
              && priceChangePct <= PARAMS.maxPriceChangePct; // price flat

  return { passes, oiChangePct, priceChangePct };
}
```

---

## Stage 8 — Telegram Alerts

### Setup
```typescript
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const DRY_RUN          = process.argv.includes("--dry-run");
```

### Alert `details` field format (by signal type)
Populated in Stage 6 before pushing to the alerts array:
```
BUILDING:    "Squeeze: +32.3% over 10h | Funding: -1504% APR"
EXHAUSTION:  "Squeeze: +32.0% over 10h | Funding: 0.0% APR"
TREND_BREAK: "Squeeze: +35.8% over 10h | Prior funding: -1455% APR"
FUNDING:     "Funding: 10.9% APR | OI: +10.5% over 4h"
PUMP_TOP:    "Candle: +28.2% | Volume: ×113 | RSI: 94"
```

### Message formatting
Format each alert as a rich Telegram message:

```typescript
function formatAlert(alert: Alert): string {
  const coin  = alert.coin;  // coin is carried on the Alert object
  const icons = {
    FUNDING:     "💰",
    PUMP_TOP:    "🚀",
    BUILDING:    "⚠️",
    EXHAUSTION:  "🎯",
    TREND_BREAK: "🚨",
  };

  const confIcons = { HIGH: "🟢", MEDIUM: "🟡", LOW: "🔴" };

  const lines: string[] = [
    `${icons[alert.type]} *ALTSHORTBOT — ${coin}*`,
    `Signal: *${alert.type.replace("_", " ")}*`,
    `Entry: $${alert.entry.toFixed(4)}`,
    `Funding: ${alert.fundingApr.toFixed(1)}% APR`,
    `Confidence: ${confIcons[alert.confidence]} ${alert.confidence}`,
    "",
    alert.details,
  ];

  // Add building context for exhaustion signals
  if (alert.type === "EXHAUSTION" || alert.type === "TREND_BREAK") {
    if (alert.msSinceBuilding !== null) {
      const h = Math.round(alert.msSinceBuilding / 3_600_000);
      lines.push(`Building: ✅ ${h}h ago`);
      if (h < 4) lines.push(`⚠️ Recent building — squeeze may continue`);
    } else {
      lines.push(`Building: ⚠️ No prior building — lower confidence`);
    }
  }

  // Action guidance
  if (alert.type === "EXHAUSTION" && alert.confidence === "HIGH") {
    lines.push("", `📐 Short entry — stop at -12% | target -15% to -40%`);
  }
  if (alert.type === "BUILDING") {
    lines.push("", `⏳ Do NOT short yet — await exhaustion signal`);
  }
  if (alert.type === "TREND_BREAK") {
    lines.push("", `📐 Strong short — parabolic blow-off confirmed`);
  }

  return lines.join("\n");
}
```

### Sending
```typescript
async function sendTelegram(message: string): Promise<void> {
  if (DRY_RUN || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("\n[DRY RUN] Telegram message:\n" + message + "\n");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text:    message,
        parse_mode: "Markdown",
      }),
    });
    if (!res.ok) console.error(`Telegram error: ${res.status}`);
  } catch (err) {
    console.error(`Telegram send failed: ${(err as Error).message}`);
    // Do not rethrow — failure is logged, state still saves, scanner continues
  }
}
```

---

## Stage 9 — Main Loop

### Run once (default mode)
```typescript
async function main() {
  const coins = await getCoins();  // full Bybit universe or --coins override
  const state = loadState();

  console.log(`AltShortBot Scanner — ${new Date().toISOString()}`);
  console.log(`Scanning ${coins.length} coin(s)...`);

  const allAlerts: Alert[] = [];

  for (const coin of coins) {
    process.stdout.write(`  ${coin}... `);
    try {
      const [candles, bbFunding] = await Promise.all([
        fetchCandles(coin, 500),
        fetchFundingBybit(coin),
      ]);

      if (candles.length < 50) { console.log("insufficient data"); continue; }

      const oiHistory    = await fetchOIHistory(coin, candles);
      const fundingByHour = buildFundingByHour(bbFunding);
      const coinState    = state[coin] ?? defaultState();

      const { alerts, newState } = scanCoin(
        coin, coinState, candles, fundingByHour, oiHistory
      );

      state[coin] = newState;

      if (alerts.length) {
        console.log(`${alerts.length} signal(s): ${alerts.map(a => a.type).join(", ")}`);
        allAlerts.push(...alerts);
      } else {
        console.log("no signals");
      }

    } catch (err) {
      console.log(`error: ${(err as Error).message}`);
    }

    await sleep(150);
  }

  // Send alerts then save state.
  // sendTelegram() is wrapped in try/catch — individual failures are logged but
  // do not block state save. Accepting that rare network blips lose an alert is
  // preferable to not saving state (which would cause all alerts to re-fire next run,
  // including ones that already sent successfully).
  for (const alert of allAlerts) {
    const msg = formatAlert(alert);
    await sendTelegram(msg);  // sendTelegram() handles its own errors internally
    await sleep(500); // Telegram rate limit
  }

  // Save state after all sends attempted (regardless of individual send success)
  saveState(state);

  console.log(`\nDone. ${allAlerts.length} alert(s) sent.`);
}
```

### Watch mode (`--watch`)
```typescript
async function watchMode() {
  console.log("AltShortBot Scanner — watch mode (runs on the hour)");
  while (true) {
    await main();

    // Sleep until next hour boundary
    const now      = Date.now();
    const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
    const sleepMs  = nextHour - now + 5000; // +5s buffer past the hour
    console.log(`Next scan in ${Math.round(sleepMs / 60_000)}min`);
    await sleep(sleepMs);
  }
}
```

### Entry point
```typescript
const isWatch = process.argv.includes("--watch");
isWatch ? watchMode() : main();
```

---

## Stage 10 — Cron Setup (alternative to --watch)

Add to crontab to run every hour at :05 past (gives exchanges 5 minutes to publish
the new funding settlement after the top-of-hour settle):
```cron
5 * * * * cd /path/to/altshortbot && npx tsx live_scanner.ts >> logs/scanner.log 2>&1
```

Create log rotation:
```bash
mkdir -p logs
echo "5 * * * * cd /path/to/altshortbot && npx tsx live_scanner.ts >> logs/scanner.log 2>&1" | crontab -
```

---

## Stage 10b — PM2 Process Management

PM2 handles scheduling and process persistence. Use `cron_restart` so the scanner
runs once and exits cleanly each hour — no `--watch` mode needed.

### ecosystem.config.js
```javascript
module.exports = {
  apps: [
    {
      name: "altshortbot",

      // Run once and exit — PM2 restarts on cron schedule
      script: "npx",
      args:   "tsx live_scanner.ts",

      // Restart every hour at :05 past (gives exchanges 5 min after settlement)
      cron_restart: "5 * * * *",

      // Don't auto-restart on crash between scheduled runs
      // (next cron tick starts a fresh run anyway)
      autorestart: false,

      // Logs
      out_file:   "logs/scanner.log",
      error_file: "logs/scanner-error.log",
      time:       true,  // prepend timestamps to log lines

      env: {
        NODE_ENV:         "production",
        TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN    ?? "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
        // SCANNER_COINS: "ORDI,KNC,HIVE,HYPER,ENJ",  // optional override
      },
    },
  ],
};
```

### Setup
```bash
npm install -g pm2
mkdir -p logs

export TELEGRAM_TOKEN="your-token"
export TELEGRAM_CHAT_ID="your-chat-id"

pm2 start ecosystem.config.js
pm2 save       # persist process list across reboots
pm2 startup    # auto-start on server boot (follow the printed instruction)
```

### Daily commands
```bash
pm2 logs altshortbot      # live log tail
pm2 status                # process health
pm2 restart altshortbot   # force a run immediately
pm2 stop altshortbot      # pause scanning
pm2 delete altshortbot    # remove from PM2
```

### Why cron_restart over --watch
`cron_restart` runs the scanner once and lets it exit cleanly. `autorestart: false`
means a crash between scheduled runs does not cause a spin loop — the next cron
tick starts a fresh run anyway. A long-running `--watch` process could hang mid-sleep
on a network stall; `cron_restart` eliminates that failure mode entirely.


---

## Stage 11 — Testing

### Dry run (no Telegram)
```bash
npx tsx live_scanner.ts --dry-run
```
Should print data fetching status and any signals to terminal.

### Single coin test
```bash
npx tsx live_scanner.ts --coins KNC --dry-run
```

### Verify state persistence
```bash
# Run twice — second run should load state from first
npx tsx live_scanner.ts --coins ORDI --dry-run
cat scanner_state.json
```

### Verify Telegram works
```bash
TELEGRAM_TOKEN=xxx TELEGRAM_CHAT_ID=yyy npx tsx live_scanner.ts --coins HYPER
```

---

## Key Differences from Backtest

| Concern | Backtest | Live Scanner |
|---|---|---|
| Data window | Full historical (30-90 days) | Last 500 hours (Bybit kline) |
| State | Reset each run, loop over hours | Persisted in `scanner_state.json` |
| Signal timing | Every historical hour | Current hour only |
| Outcomes | Measured (48h lookahead) | Not measured |
| Output | Terminal + HTML chart | Telegram message |
| Cooldown | 4h bucket per signal type | Event-based flags + 6h exhaustion gap |
| Scheduling | On demand | Cron or `--watch` |

---

## Critical Implementation Rules

1. **`lastBuildingMinFunding` must NOT reset on wave end.** It persists until
   a new building updates it. This is required for TREND_BREAK detection across
   wave gaps. Only resets when a new building fires with a less extreme value
   (since we use `if (newVal < current) update`).

2. **Exhaustion threshold is -20% APR, not -100%.** The squeeze detection building
   threshold is -100% APR. The exhaustion threshold is tighter (-20%) to prevent
   false exhaustion when Bybit funding oscillates between e.g. -200% and -50%
   during an active squeeze. Good exhaustion signals fire near 0% APR.

3. **Funding is Bybit-only — no merge needed.** The scanner uses `buildFundingByHour()`
   to forward-fill Bybit settlement records into a per-hour lookup. Bybit dominated
   87-96% of hours during backtest validation; going single-source eliminates the
   merge complexity with no loss of signal quality.

4. **Gate 1 suppressed when building fired in last 48h.** A coin being squeezed
   should not simultaneously generate a "crowded longs" short signal.

5. **Exhaustion confidence based on time since building:**
   - No prior building → LOW confidence, flag clearly in alert
   - < 2h since building → LOW (too soon, squeeze may continue)
   - 2-6h since building → MEDIUM
   - 6h+ since building → HIGH
   - TREND_BREAK is always HIGH (parabolic confirmation)
   These thresholds match `getConfidence()` in Stage 6f exactly.

6. **Rate limits:** 150ms delay between coins. 500ms between Telegram messages.
   Retry API calls 3× with exponential backoff.

7. **Exhaustion uses a 6h timestamp gap, not a per-wave boolean.**
   `lastExhaustionMs` replaces `waveAlertedExhaustion`. A new exhaustion fires when
   `(now - lastExhaustionMs) >= 6h`. Reset to `null` when the wave ends (not when
   the coin exits trending). This matches backtest behaviour: multiple exhaustions
   fire on long squeezes (ORDI, ENJ), but never within 6h of each other.

---

## .env.example

```
# Telegram Bot Configuration
# Create bot: https://t.me/BotFather → /newbot
# Get chat ID: Send message to your bot, then:
# curl https://api.telegram.org/bot{TOKEN}/getUpdates

TELEGRAM_TOKEN=123456789:ABCDEFghijklmnop-qrstuvwxyz123456789
TELEGRAM_CHAT_ID=-1001234567890

# Optional: override watchlist (comma-separated)
# SCANNER_COINS=ORDI,KNC,HIVE,HYPER
```

---

## Expected Output (dry run)

```
AltShortBot Scanner — 2026-05-07T15:02:00.000Z
Scanning 287 coin(s)...
  1000PEPE... no signals
  AAVE...     no signals
  ...
  KNC...      1 signal(s): EXHAUSTION
  ...
  ORDI...     no signals
  ...

[DRY RUN] Telegram message:
🎯 *ALTSHORTBOT — KNC*
Signal: *EXHAUSTION*
Entry: $0.1661
Funding: 0.0% APR
Confidence: 🟢 HIGH

Squeeze: +32.0% over 10h
Building: ✅ 1h ago

📐 Short entry — stop at -12% | target -15% to -40%

Done. 1 alert(s) sent.
```
