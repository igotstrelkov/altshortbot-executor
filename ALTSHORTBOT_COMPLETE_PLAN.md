# AltShortBot — Complete App Implementation Plan

## What This Document Is

A stage-by-stage implementation guide for the complete AltShortBot application.
Each stage is self-contained and can be handed to an LLM individually.
Stages build on each other — implement in order.

---

## What Already Exists (Do Not Rebuild)

These files are complete and tested. Do NOT rebuild them from scratch.
Stage 1 adds queue functionality to `live_scanner.ts`.
Stage 2e adds exports to `live_scanner.ts`.
All other modifications to these files are forbidden unless explicitly listed in Stage 1.

```
backtest_signals.ts       ← signal detection engine + backtest CLI (1,834 lines)
backtest_test.ts          ← regression test harness with fixture support
live_scanner.ts           ← hourly scanner, detects signals, sends Telegram (668 lines)
ecosystem.config.js       ← PM2 process config
fixtures/                 ← captured API snapshots for deterministic tests
scanner_state.json        ← auto-created at runtime, persists wave tracking state
```

### Validated parameter set (already in live_scanner.ts PARAMS)

The scanner uses these validated constants — do not change them:

```typescript
const PARAMS = {
  // Gate 1 — crowded longs
  fundingAprThreshold: 10, // % APR
  minPositiveReadings: 2, // out of last 8 hourly readings
  // Gate 2 — OI divergence
  minOiChangePct: 2, // OI growth % over 4h
  maxPriceChangePct: 2, // price must be flat
  // Pump top
  pumpMinPct: 19,
  pumpMinVolMult: 5,
  pumpMinRsi: 88,
  pumpMinFundingApr: 0,
  // Short squeeze — building
  squeezeMinPct: 20,
  squeezeHours: 10,
  squeezeMaxFundingApr: -100,
  squeezeMinOiDrop: 0,
  // Short squeeze — exhaustion
  exhaustMaxFundingApr: -20, // funding must normalise above this
  exhaustMinOiDrop: 3, // OI must drop >= 3% (blocks flat-OI false positives)
  // Trend filter
  trendDays7Pct: 30,
  trendDays14Pct: 50,
  trendBreakFundingApr: -500,
} as const;
```

`exhaustMinOiDrop: 3` was added after backtesting NOT coin, which showed exhaustion signals
firing with flat OI (shorts not actually covering). Requiring >= 3% OI drop for exhaustion
blocks these false positives while preserving signals on validated coins where OI genuinely drops.

### Coin universe — minimum price filter

`live_scanner.ts` filters out sub-penny coins (`< $0.001`) during coin discovery.
Micro-cap tokens have longer squeeze cycles than the 10h detection window and generate
unreliable exhaustion signals. This is implemented as `MIN_PRICE_USDC = 0.001` in
`fetchAllCoins()`.

---

## Validated Backtest Command

The signal detection parameters were validated across 10 coins. Use this command
to re-run backtests when tuning:

```bash
npx tsx backtest_signals.ts --coin ORDI --days 60 \
  --threshold 10 --min-positive 2 --min-oi 2 --max-price 2 \
  --pump-pct 19 --pump-vol 5 --pump-rsi 88 --pump-funding 0 \
  --squeeze-pct 20 --squeeze-hours 10 --squeeze-funding -100 --squeeze-oi-drop 0 \
  --exhaust-funding -20 --exhaust-oi-drop 3 --lookahead 48
```

---

## Overall Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PM2 Process 1: live_scanner.ts (cron: every hour at :05)       │
│  • Scans all Hyperliquid perpetuals for signals                  │
│  • Sends Telegram alert for each signal                          │
│  • Appends HIGH/MEDIUM confidence signals to signal_queue.json   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ writes
                               ▼
                     signal_queue.json
                               │
                               │ reads
┌──────────────────────────────▼──────────────────────────────────┐
│  PM2 Process 2: hl_executor.ts (cron: every 5 minutes)          │
│  • Reads and clears signal_queue.json                            │
│  • In --paper mode: simulates trades, tracks P&L                 │
│  • In live mode: places real orders on Hyperliquid               │
│  • Manages open positions (stop-loss, trailing stop, time limit)  │
│  • Writes position state to hl_positions.json                    │
│  • Sends Telegram updates on fills, stops, closes               │
└─────────────────────────────────────────────────────────────────┘

Files created at runtime (all gitignored):
  signal_queue.json    ← signals awaiting execution (scanner → executor)
  hl_positions.json    ← open position state
  scanner_state.json   ← wave tracking (existing)
  logs/                ← PM2 logs
```

---

## Shared Types (used across scanner + executor)

Define in `shared_types.ts`. Both `live_scanner.ts` and `hl_executor.ts` import from here.

```typescript
// shared_types.ts

export interface Alert {
  coin: string;
  type: "FUNDING" | "PUMP_TOP" | "BUILDING" | "EXHAUSTION" | "TREND_BREAK";
  firedAt: number; // Unix ms
  firedAtStr: string; // "2026-05-02 09:00"
  entry: number; // price at signal time
  fundingApr: number; // merged funding APR
  details: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  msSinceBuilding: number | null;
}

export interface QueuedSignal extends Alert {
  queuedAt: number; // when written to queue
}

export interface PositionRecord {
  coin: string;
  openedAt: number;
  entryPx: number;
  sizeCoin: number;
  notionalUsdc: number;
  stopLossPx: number;
  targetPx: number;
  trailingActive: boolean;
  signalType: "EXHAUSTION" | "TREND_BREAK";
  signalConfidence: "HIGH" | "MEDIUM";
  stopOid?: number; // stop-loss order ID (undefined in paper mode)
  isPaper: boolean;
}

export type PositionStore = Record<string, PositionRecord>;

export interface PaperTrade {
  coin: string;
  openedAt: number;
  closedAt: number;
  entryPx: number;
  exitPx: number;
  sizeCoin: number;
  pnlUsdc: number;
  pnlPct: number;
  closeReason: "stop" | "target" | "trailing" | "timeout" | "manual";
  signalType: string;
  confidence: string;
}
```

---

## Stage 1 — Modify live_scanner.ts to Write Signal Queue

**Goal:** When a HIGH or MEDIUM confidence signal fires, append it to `signal_queue.json`
in addition to sending the Telegram alert. LOW confidence signals are NOT queued
(too risky to trade automatically), but still sent via Telegram for manual review.

### 1a. Import shared types

Replace the local `Alert` interface in `live_scanner.ts` with an import:

```typescript
import type { Alert, QueuedSignal } from "./shared_types.ts";
```

Remove the local `Alert` interface definition.

### 1b. Add queue write function

```typescript
const QUEUE_FILE = "signal_queue.json";

function appendToQueue(alert: Alert): void {
  let queue: QueuedSignal[] = [];
  try {
    if (existsSync(QUEUE_FILE))
      queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    queue = [];
  }

  queue.push({ ...alert, queuedAt: Date.now() });
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
}
```

### 1c. Call appendToQueue in main()

After sending Telegram, append tradeable signals to queue:

```typescript
for (const alert of allAlerts) {
  await sendTelegram(formatAlert(alert));
  await sleep(500);

  // Queue HIGH and MEDIUM signals for executor
  // LOW confidence signals are Telegram-only — too risky for auto-execution
  if (
    (alert.type === "EXHAUSTION" || alert.type === "TREND_BREAK") &&
    (alert.confidence === "HIGH" || alert.confidence === "MEDIUM")
  ) {
    appendToQueue(alert);
  }
}
```

### 1d. Add QUEUE_FILE to .gitignore

```bash
echo "signal_queue.json" >> .gitignore
echo "hl_positions.json" >> .gitignore
echo "paper_trades.jsonl" >> .gitignore
```

### 1e. Verify live_scanner.ts has correct PARAMS

Check that `live_scanner.ts` has `exhaustMinOiDrop: 3` in its PARAMS constant.
If missing, add it to the exhaustion phase section:

```typescript
// Short squeeze — exhaustion phase
exhaustMaxFundingApr:  -20,
exhaustMinOiDrop:       3,    // OI must drop >= 3% — blocks flat-OI false positives
```

Also verify `detectShortSqueeze` uses it. The exhaustion check must include:

```typescript
const exhaustOiOk =
  PARAMS.exhaustMinOiDrop <= 0 || oiDropPct >= PARAMS.exhaustMinOiDrop;
// OI drop is only computed when squeezeMinOiDrop OR exhaustMinOiDrop > 0:
// if ((config.squeezeMinOiDrop > 0 || config.exhaustMinOiDrop > 0) && ...)
```

And `fetchAllCoins()` must have the minimum price filter:

```typescript
const MIN_PRICE_USDC = 0.001;
// After fetching instruments, filter: (priceMap.get(c) ?? 0) >= MIN_PRICE_USDC
```

If these are already in the file, skip this step.

---

## Stage 2 — scanner_test.ts (Regression Tests for Live Scanner)

**Goal:** Feed fixture data through `scanCoin()` hour by hour and assert known-good
signals fire. Write this before Stage 3 — tests define the `scanCoin()` contract.

**File:** `scanner_test.ts`

### 2a. File header

```typescript
/**
 * AltShortBot Live Scanner — Regression Tests
 * ============================================
 * Feeds fixture data through scanCoin() hour by hour and asserts
 * known-good signals fire with correct type, confidence, and timing.
 *
 * Uses the same fixtures/ directory as backtest_test.ts.
 * Run backtest_test.ts first to capture fixtures.
 *
 * Usage:
 *   npx tsx scanner_test.ts          ← all coins
 *   npx tsx scanner_test.ts KNC      ← single coin
 */
```

### 2b. Imports and helpers

```typescript
import { readFileSync, existsSync } from "fs";
import { scanCoin, defaultState, buildFundingByHour } from "./live_scanner.ts";
import type { Alert } from "./shared_types.ts";

const FIXTURE_DIR = "fixtures";

interface ScannerTestCase {
  coin: string;
  expect: {
    minAlerts?: number;
    mustInclude?: Array<{
      type: string;
      confidence?: string;
      approxHour?: string; // e.g. "2026-04-16 10" — firedAtStr prefix match
    }>;
    stateAfter?: {
      lastBuildingMinFunding?: { lessThan: number };
    };
  };
}
```

### 2c. Test cases

```typescript
const TESTS: ScannerTestCase[] = [
  {
    coin: "KNC",
    expect: {
      minAlerts: 2,
      mustInclude: [
        { type: "BUILDING", confidence: "MEDIUM", approxHour: "2026-05-02" },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-05-02" },
      ],
    },
  },
  {
    coin: "HIVE",
    expect: {
      mustInclude: [
        { type: "BUILDING", approxHour: "2026-05-05" },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-05-05" },
      ],
    },
  },
  {
    coin: "ORDI",
    expect: {
      mustInclude: [
        { type: "BUILDING", approxHour: "2026-04-16" },
        {
          type: "EXHAUSTION",
          confidence: "MEDIUM",
          approxHour: "2026-04-16 10",
        },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-04-16 18" },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-04-17" },
      ],
    },
  },
  {
    coin: "SPK",
    expect: {
      mustInclude: [
        { type: "BUILDING", approxHour: "2026-04-20" },
        { type: "TREND_BREAK", confidence: "HIGH", approxHour: "2026-04-23" },
      ],
      stateAfter: { lastBuildingMinFunding: { lessThan: -500 } },
    },
  },
  {
    coin: "ENJ",
    expect: {
      minAlerts: 20,
      mustInclude: [
        { type: "BUILDING", approxHour: "2026-04-08" },
        { type: "EXHAUSTION", confidence: "HIGH", approxHour: "2026-04-19" },
      ],
    },
  },
  {
    coin: "HYPER",
    expect: {
      mustInclude: [
        { type: "TREND_BREAK", confidence: "HIGH", approxHour: "2026-04-25" },
      ],
    },
  },
];
```

### 2d. Test runner

```typescript
const MIN_WINDOW = 25; // squeezeHours (10) + RSI warmup (15) — update if PARAMS.squeezeHours changes

async function runTest(tc: ScannerTestCase): Promise<string[]> {
  const fixturePath = `${FIXTURE_DIR}/${tc.coin}.json`;
  if (!existsSync(fixturePath)) return [`SKIP: no fixture for ${tc.coin}`];

  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    candles: any[];
    fundingBybit: any[];
    oi: any[];
  };

  const fundingByHour = buildFundingByHour(fx.fundingBybit);
  const failures: string[] = [];
  const allAlerts: Alert[] = [];
  let state = defaultState();

  for (let i = MIN_WINDOW; i < fx.candles.length; i++) {
    const { alerts, newState } = scanCoin(
      tc.coin,
      state,
      fx.candles.slice(0, i + 1),
      fundingByHour,
      fx.oi.filter((r: any) => r.timeMs <= fx.candles[i].t).slice(-10),
    );
    allAlerts.push(...alerts);
    state = newState;
  }
  // state now holds the final CoinState after replaying all fixture hours

  // Assertions
  if (tc.expect.minAlerts && allAlerts.length < tc.expect.minAlerts)
    failures.push(
      `Expected >= ${tc.expect.minAlerts} alerts, got ${allAlerts.length}`,
    );

  for (const expected of tc.expect.mustInclude ?? []) {
    const match = allAlerts.find(
      (a) =>
        a.type === expected.type &&
        (!expected.confidence || a.confidence === expected.confidence) &&
        (!expected.approxHour || a.firedAtStr.startsWith(expected.approxHour)),
    );
    if (!match)
      failures.push(
        `Missing: ${expected.type} [${expected.confidence ?? "any"}] ~${expected.approxHour ?? "anytime"}`,
      );
  }

  if (tc.expect.stateAfter?.lastBuildingMinFunding?.lessThan !== undefined) {
    const threshold = tc.expect.stateAfter.lastBuildingMinFunding.lessThan;
    if (state.lastBuildingMinFunding >= threshold)
      failures.push(
        `lastBuildingMinFunding ${state.lastBuildingMinFunding} should be < ${threshold}`,
      );
  }

  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith("--"));
  const tests = filter
    ? TESTS.filter((t) => t.coin === filter.toUpperCase())
    : TESTS;

  console.log("\nAltShortBot Scanner Regression Tests");
  console.log("══════════════════════════════════════");
  console.log(`Running ${tests.length} test(s)...\n`);

  let passed = 0,
    failed = 0;
  for (const tc of tests) {
    const failures = await runTest(tc);
    if (failures[0]?.startsWith("SKIP")) {
      console.log(`  ${tc.coin.padEnd(8)} ⏭  ${failures[0]}`);
    } else if (failures.length === 0) {
      console.log(`  ${tc.coin.padEnd(8)} ✅`);
      passed++;
    } else {
      console.log(`  ${tc.coin.padEnd(8)} ❌`);
      failures.forEach((f) => console.log(`             ${f}`));
      failed++;
    }
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

### 2e. Exports and isMain guard required from live_scanner.ts

`live_scanner.ts` has top-level code (`main()` / `watchMode()`) that fires on import.
When `scanner_test.ts` imports `scanCoin`, it would trigger the full scanner to run.

**Fix:** Wrap the entry point in an ESM isMain guard. Add this at the bottom of
`live_scanner.ts`, replacing the bare call:

```typescript
// Step 1: Add to the TOP-LEVEL imports at the top of live_scanner.ts:
import { fileURLToPath } from "url";

// Step 2: Replace the bare call at the BOTTOM of the file:
// BEFORE:
process.argv.includes("--watch") ? watchMode() : main();

// AFTER (only runs when file is the entry point, not when imported):
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  process.argv.includes("--watch") ? watchMode() : main();
}
```

Then add these exports (after the isMain block):

```typescript
export { scanCoin, defaultState, buildFundingByHour };
export type { CoinState };
```

Do not change any logic — only add the guard and the exports.

---

## Stage 3 — hl_executor.ts: Core Structure

**File:** `hl_executor.ts`

**Goal:** Scaffold the executor with config, types, state persistence, and helpers.
No trading logic yet — just the skeleton.

### 3a. File header and imports

```typescript
/**
 * AltShortBot Hyperliquid Executor
 * =================================
 * Reads signal_queue.json written by live_scanner.ts.
 * In --paper mode: simulates trades and tracks P&L.
 * In live mode: places real short orders on Hyperliquid.
 *
 * Run every 5 minutes via PM2 cron_restart.
 *
 * Usage:
 *   npx tsx hl_executor.ts --paper    ← simulate trades (safe, start here)
 *   npx tsx hl_executor.ts            ← live trading (real money)
 *   npx tsx hl_executor.ts --status   ← print open positions and P&L
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import type {
  QueuedSignal,
  PositionRecord,
  PositionStore,
  PaperTrade,
} from "./shared_types.ts";
```

### 3b. Mode and config

```typescript
const IS_PAPER = process.argv.includes("--paper");
const IS_STATUS = process.argv.includes("--status");
const IS_TESTNET = process.env.HL_TESTNET === "1";

const API_URL = IS_TESTNET
  ? "https://api.hyperliquid-testnet.xyz"
  : "https://api.hyperliquid.xyz";

const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS ?? "";
const AGENT_KEY = process.env.HL_AGENT_KEY ?? "";

const QUEUE_FILE = "signal_queue.json";
const POSITIONS_FILE = "hl_positions.json";
const PAPER_LOG_FILE = "paper_trades.jsonl"; // one JSON object per line

// Risk parameters — tune before going live
const RISK = {
  riskPerTrade: 0.02, // 2% account per trade
  stopLossPct: 0.12, // stop at +12% adverse (price rises 12%)
  initialTargetPct: 0.2, // initial take-profit at -20%
  trailingStopPct: 0.05, // trail stop by 5% once in profit
  breakevenAtPct: 0.1, // move stop to breakeven after -10% move
  maxHoldHours: 72, // force-close after 3 days
  maxLeverage: 3,
  maxPositions: 3, // never hold >3 simultaneous shorts
  minNotionalUsdc: 10, // minimum $10 per trade
} as const;

// These signals are traded. Others are Telegram-only.
const TRADEABLE = new Set(["EXHAUSTION", "TREND_BREAK"]);
```

### 3c. State persistence

```typescript
function loadQueue(): QueuedSignal[] {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function clearQueue(): void {
  writeFileSync(QUEUE_FILE, "[]", "utf8");
}

function loadPositions(): PositionStore {
  if (!existsSync(POSITIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePositions(store: PositionStore): void {
  writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2), "utf8");
}

function logPaperTrade(trade: PaperTrade): void {
  appendFileSync(PAPER_LOG_FILE, JSON.stringify(trade) + "\n", "utf8");
}
```

### 3d. Telegram (reuse from scanner)

```typescript
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[No Telegram]\n" + message);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error(`Telegram failed: ${(err as Error).message}`);
  }
}
```

---

## Stage 4 — hl_executor.ts: Hyperliquid Data Fetching

Add these functions to `hl_executor.ts`.

### 4a. HTTP helper

```typescript
async function hlPost(body: object): Promise<unknown> {
  const res = await fetch(`${API_URL}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}`);
  return res.json();
}
```

### 4b. Asset index map (coin name → numeric index for orders)

```typescript
interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

async function fetchAssetIndex(): Promise<
  Map<string, { idx: number; szDecimals: number }>
> {
  const { universe } = (await hlPost({ type: "meta" })) as {
    universe: AssetMeta[];
  };
  const map = new Map<string, { idx: number; szDecimals: number }>();
  universe.forEach((a, idx) => {
    if (!a.isDelisted) map.set(a.name, { idx, szDecimals: a.szDecimals });
  });
  return map;
}
```

### 4c. Account state

```typescript
interface HLPosition {
  position: {
    coin: string;
    szi: string; // negative = short
    entryPx: string;
    liquidationPx: string;
    unrealizedPnl: string;
    marginUsed: string;
  };
}

interface AccountState {
  assetPositions: HLPosition[];
  marginSummary: { accountValue: string; totalMarginUsed: string };
  withdrawable: string;
}

async function fetchAccountState(): Promise<AccountState> {
  if (!WALLET_ADDRESS) throw new Error("HL_WALLET_ADDRESS not set");
  return (await hlPost({
    type: "clearinghouseState",
    user: WALLET_ADDRESS,
  })) as AccountState;
}
```

### 4d. Current mark prices

```typescript
async function fetchMarkPrices(): Promise<Map<string, number>> {
  const [meta, ctxs] = (await hlPost({ type: "metaAndAssetCtxs" })) as [
    { universe: { name: string }[] },
    { markPx: string }[],
  ];
  const map = new Map<string, number>();
  meta.universe.forEach((a, i) =>
    map.set(a.name, parseFloat(ctxs[i]?.markPx ?? "0")),
  );
  return map;
}
```

---

## Stage 5 — hl_executor.ts: Order Execution

Add these functions to `hl_executor.ts`.

### 5a. SDK setup (handles all signing internally)

Do NOT implement EIP-712 signing manually — Hyperliquid's action hashing uses
msgpack serialisation with strict key ordering. Use the @nktkas/hyperliquid SDK
which handles this correctly.

```bash
npm install @nktkas/hyperliquid viem
```

```typescript
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

function getExchangeClient(): ExchangeClient {
  if (!AGENT_KEY) throw new Error("HL_AGENT_KEY not set");
  const wallet = privateKeyToAccount(AGENT_KEY as `0x${string}`);
  // When using an agent wallet approved via app.hyperliquid.xyz → Settings → API,
  // the exchange resolves which account the agent acts for on-chain automatically.
  // No vaultAddress needed — Hyperliquid maps agent → approver internally.
  return new ExchangeClient({
    transport: new HttpTransport({ url: API_URL }),
    wallet,
  });
}
```

### 5d. Place short order

```typescript
async function openShort(
  assetIdx: number,
  szDecimals: number,
  sizeCoin: number,
  markPrice: number,
): Promise<number | null> {
  // returns oid or null if failed
  if (IS_PAPER) return -1; // paper mode — no real order

  const client = getExchangeClient();
  const limitPx = (markPrice * 0.995).toFixed(4); // prices always 4dp — szDecimals controls SIZE not price
  const sizeStr = sizeCoin.toFixed(szDecimals > 4 ? 4 : szDecimals);

  try {
    const result = await client.order({
      orders: [
        {
          a: assetIdx,
          b: false, // false = sell (short)
          p: limitPx,
          s: sizeStr,
          r: false, // not reduce-only — opening new position
          t: { limit: { tif: "Ioc" } }, // IOC = fill immediately or cancel
        },
      ],
      grouping: "na",
    });
    const status = result.response.data.statuses[0];
    if ("filled" in status) {
      // Note: IOC may partially fill. status.filled.totalSz is the actual filled size.
      // For simplicity we proceed with full requested size — the stop-loss will be
      // slightly oversized on a partial fill, erring on the side of protection.
      return status.filled.oid;
    }
    if ("resting" in status) return status.resting.oid;
    console.error(`Order status: ${JSON.stringify(status)}`);
    return null;
  } catch (err) {
    console.error(`openShort failed: ${(err as Error).message}`);
    return null;
  }
}
```

### 5e. Set stop-loss order

```typescript
async function placeStopLoss(
  assetIdx: number,
  szDecimals: number,
  sizeCoin: number,
  stopPx: number,
): Promise<number | null> {
  if (IS_PAPER) return -1;

  const client = getExchangeClient();
  const stopStr = stopPx.toFixed(4); // prices always 4dp
  const sizeStr = sizeCoin.toFixed(szDecimals > 4 ? 4 : szDecimals);

  try {
    const result = await client.order({
      orders: [
        {
          a: assetIdx,
          b: true, // buy to close short
          p: stopStr,
          s: sizeStr,
          r: true, // reduce-only
          t: {
            trigger: {
              triggerPx: stopStr,
              isMarket: true,
              tpsl: "sl",
            },
          },
        },
      ],
      grouping: "na",
    });
    const status = result.response.data.statuses[0];
    if ("resting" in status) return status.resting.oid;
    return null;
  } catch (err) {
    console.error(`placeStopLoss failed: ${(err as Error).message}`);
    return null;
  }
}
```

### 5f. Cancel order

```typescript
async function cancelOrder(assetIdx: number, oid: number): Promise<void> {
  if (IS_PAPER || oid === -1) return;
  const client = getExchangeClient();
  try {
    await client.cancel({ cancels: [{ a: assetIdx, o: oid }] });
  } catch (err) {
    console.error(`cancelOrder failed: ${(err as Error).message}`);
  }
}
```

### 5g. Close position (market)

```typescript
async function closePosition(
  assetIdx: number,
  szDecimals: number,
  sizeCoin: number,
  markPx: number,
): Promise<void> {
  if (IS_PAPER) return;

  const client = getExchangeClient();
  const limitPx = (markPx * 1.005).toFixed(4); // prices always 4dp
  const sizeStr = sizeCoin.toFixed(szDecimals > 4 ? 4 : szDecimals);

  try {
    await client.order({
      orders: [
        {
          a: assetIdx,
          b: true, // buy to close short
          p: limitPx,
          s: sizeStr,
          r: true, // reduce-only
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
  } catch (err) {
    console.error(`closePosition failed: ${(err as Error).message}`);
  }
}
```

---

## Stage 6 — hl_executor.ts: Position Sizing

```typescript
function calcPositionSize(
  accountValueUsdc: number,
  markPrice: number,
  szDecimals: number,
): number {
  const riskUsd = accountValueUsdc * RISK.riskPerTrade;
  const marginUsed = riskUsd / RISK.stopLossPct;
  const notional = marginUsed * RISK.maxLeverage;
  const rawSize = notional / markPrice;
  // Round down to szDecimals precision
  const factor = Math.pow(10, Math.min(szDecimals, 4));
  return Math.floor(rawSize * factor) / factor;
}
```

---

## Stage 7 — hl_executor.ts: Signal Execution

Called when a new signal is dequeued.

```typescript
async function executeSignal(
  signal: QueuedSignal,
  assetIndex: Map<string, { idx: number; szDecimals: number }>,
  markPrices: Map<string, number>,
  positions: PositionStore,
  accountValue: number,
): Promise<void> {
  const { coin, type, confidence, entry } = signal;

  // Validation guards
  if (!TRADEABLE.has(type)) {
    console.log(`${coin}: not tradeable (${type})`);
    return;
  }
  if (confidence === "LOW") {
    console.log(`${coin}: LOW confidence — skip`);
    return;
  }
  if (positions[coin]) {
    console.log(`${coin}: already in position`);
    return;
  }
  if (Object.keys(positions).length >= RISK.maxPositions) {
    console.log(`Max positions (${RISK.maxPositions}) reached`);
    return;
  }

  const asset = assetIndex.get(coin);
  if (!asset) {
    console.log(`${coin}: not listed on Hyperliquid`);
    return;
  }

  const markPx = markPrices.get(coin) ?? entry;

  // Use mark price for sizing (more accurate than signal entry for delayed execution)
  const size = calcPositionSize(accountValue, markPx, asset.szDecimals);
  const notional = size * markPx;

  if (notional < RISK.minNotionalUsdc) {
    console.log(`${coin}: notional $${notional.toFixed(2)} below minimum`);
    return;
  }

  const stopLossPx = markPx * (1 + RISK.stopLossPct);
  const targetPx = markPx * (1 - RISK.initialTargetPct);

  // Hoist stopOid so it's accessible when building the position record
  let stopOid: number | undefined = undefined;

  if (IS_PAPER) {
    // Paper mode — record simulated position
    console.log(
      `📝 [PAPER] Short ${coin} @ $${markPx.toFixed(4)} | size: ${size} | stop: $${stopLossPx.toFixed(4)}`,
    );
  } else {
    // Live mode — place real order
    const oid = await openShort(asset.idx, asset.szDecimals, size, markPx);
    if (oid === null) {
      console.log(`${coin}: order failed`);
      return;
    }
    stopOid =
      (await placeStopLoss(asset.idx, asset.szDecimals, size, stopLossPx)) ??
      undefined;
    if (stopOid === undefined) {
      // Stop-loss failed — close the order immediately to avoid unprotected position
      await closePosition(asset.idx, asset.szDecimals, size, markPx);
      await sendTelegram(
        `⚠️ *${coin}* — stop-loss placement failed. Position closed for safety.`,
      );
      return;
    }
    console.log(
      `✅ Short ${coin} @ $${markPx.toFixed(4)} | oid: ${oid} | stop oid: ${stopOid}`,
    );
  }

  // Record position — stopOid stored so managePositions can cancel/update it
  positions[coin] = {
    coin,
    openedAt: Date.now(),
    entryPx: markPx,
    sizeCoin: size,
    notionalUsdc: notional,
    stopLossPx,
    targetPx,
    trailingActive: false,
    signalType: type as "EXHAUSTION" | "TREND_BREAK",
    signalConfidence: confidence as "HIGH" | "MEDIUM",
    stopOid, // undefined in paper mode, set in live mode
    isPaper: IS_PAPER,
  };

  await sendTelegram(
    `${IS_PAPER ? "📝 [PAPER]" : "✅"} *SHORT OPENED — ${coin}*\n` +
      `Entry: $${markPx.toFixed(4)}\n` +
      `Size: ${size} ${coin} ($${notional.toFixed(0)})\n` +
      `Stop: $${stopLossPx.toFixed(4)} (+${(RISK.stopLossPct * 100).toFixed(0)}%)\n` +
      `Target: $${targetPx.toFixed(4)} (-${(RISK.initialTargetPct * 100).toFixed(0)}%)\n` +
      `Signal: ${type} [${confidence}]`,
  );
}
```

---

## Stage 8 — hl_executor.ts: Position Management

Called every run regardless of new signals. Checks all open positions.

```typescript
async function managePositions(
  positions: PositionStore,
  assetIndex: Map<string, { idx: number; szDecimals: number }>,
  markPrices: Map<string, number>,
): Promise<void> {
  // Live mode: reconcile with exchange — detect positions closed by stop-loss
  // Without this, a stop that fired on the exchange leaves a ghost in hl_positions.json
  if (!IS_PAPER && WALLET_ADDRESS) {
    try {
      const accountState = await fetchAccountState();
      const liveCoins = new Set(
        accountState.assetPositions
          .filter((p) => parseFloat(p.position.szi) !== 0)
          .map((p) => p.position.coin),
      );
      for (const coin of Object.keys(positions)) {
        if (!liveCoins.has(coin)) {
          // Position closed on exchange (stop triggered, liquidated, or manually closed)
          const pos = positions[coin];
          const markPx = markPrices.get(coin) ?? pos.entryPx;
          const pnlPct = ((pos.entryPx - markPx) / pos.entryPx) * 100;
          const pnlUsdc = (pos.entryPx - markPx) * pos.sizeCoin;
          console.log(
            `${coin}: closed on exchange (stop/liq) PnL: ${pnlPct.toFixed(1)}%`,
          );
          await sendTelegram(
            `🔔 *${coin} CLOSED ON EXCHANGE*
` +
              `Entry: $${pos.entryPx.toFixed(4)} → Mark: $${markPx.toFixed(4)}
` +
              `Est. P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% ($${pnlUsdc >= 0 ? "+" : ""}${pnlUsdc.toFixed(2)})
` +
              `Reason: stop-loss triggered or liquidated`,
          );
          delete positions[coin];
        }
      }
    } catch (err) {
      console.error(`Reconciliation failed: ${(err as Error).message}`);
      // Non-fatal — continue managing with stale state
    }
  }

  for (const [coin, pos] of Object.entries(positions)) {
    const markPx = markPrices.get(coin);
    if (markPx === undefined) continue;

    const pnlPct = ((pos.entryPx - markPx) / pos.entryPx) * 100; // positive = profit (short went down)
    const hoursHeld = (Date.now() - pos.openedAt) / 3_600_000;
    const asset = assetIndex.get(coin);
    if (!asset) continue;

    let closeReason: string | null = null;

    // Check stop-loss (paper mode — live mode uses exchange stop order)
    if (IS_PAPER && markPx >= pos.stopLossPx) {
      closeReason = "stop";
    }

    // Move stop to breakeven after breakevenAtPct profit
    if (!pos.trailingActive && pnlPct >= RISK.breakevenAtPct * 100) {
      const newStop = pos.entryPx * 1.005; // entry + 0.5% (breakeven with small buffer)
      if (!IS_PAPER && pos.stopOid) {
        await cancelOrder(asset.idx, pos.stopOid);
        const newOid = await placeStopLoss(
          asset.idx,
          asset.szDecimals,
          pos.sizeCoin,
          newStop,
        );
        pos.stopOid = newOid ?? undefined;
      }
      pos.stopLossPx = newStop;
      pos.trailingActive = true;
      console.log(`${coin}: stop moved to breakeven $${newStop.toFixed(4)}`);
      await sendTelegram(
        `🔄 *${coin}* stop moved to breakeven $${newStop.toFixed(4)} (${pnlPct.toFixed(1)}% profit)`,
      );
    }

    // Trail stop as price falls further
    if (pos.trailingActive) {
      const trailingStop = markPx * (1 + RISK.trailingStopPct);
      if (trailingStop < pos.stopLossPx) {
        if (!IS_PAPER && pos.stopOid) {
          await cancelOrder(asset.idx, pos.stopOid);
          const newOid = await placeStopLoss(
            asset.idx,
            asset.szDecimals,
            pos.sizeCoin,
            trailingStop,
          );
          pos.stopOid = newOid ?? undefined;
        }
        pos.stopLossPx = trailingStop;
      }
    }

    // Time limit: close after maxHoldHours (only if not already closing)
    if (!closeReason && hoursHeld >= RISK.maxHoldHours) {
      closeReason = "timeout";
    }

    // Target hit (paper mode — live mode would use a TP order)
    if (!closeReason && IS_PAPER && markPx <= pos.targetPx) {
      closeReason = "target";
    }

    // Close position
    if (closeReason) {
      if (!IS_PAPER) {
        if (pos.stopOid) await cancelOrder(asset.idx, pos.stopOid);
        await closePosition(asset.idx, asset.szDecimals, pos.sizeCoin, markPx);
      }

      const pnlUsdc = (pos.entryPx - markPx) * pos.sizeCoin;
      const emoji = pnlUsdc >= 0 ? "✅" : "❌";

      if (IS_PAPER) {
        logPaperTrade({
          coin,
          openedAt: pos.openedAt,
          closedAt: Date.now(),
          entryPx: pos.entryPx,
          exitPx: markPx,
          sizeCoin: pos.sizeCoin,
          pnlUsdc,
          pnlPct,
          closeReason: closeReason as any,
          signalType: pos.signalType,
          confidence: pos.signalConfidence,
        });
      }

      await sendTelegram(
        `${IS_PAPER ? "📝 [PAPER] " : ""}${emoji} *${coin} CLOSED (${closeReason})*\n` +
          `Entry: $${pos.entryPx.toFixed(4)} → Exit: $${markPx.toFixed(4)}\n` +
          `P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% ($${pnlUsdc >= 0 ? "+" : ""}${pnlUsdc.toFixed(2)})\n` +
          `Held: ${hoursHeld.toFixed(1)}h`,
      );

      delete positions[coin];
      console.log(
        `${coin}: closed (${closeReason}) PnL: ${pnlPct.toFixed(1)}%`,
      );
    }
  }
}
```

---

## Stage 9 — hl_executor.ts: Status Command and Main Loop

### 9a. Status command

```typescript
async function printStatus(
  positions: PositionStore,
  markPrices: Map<string, number>,
): Promise<void> {
  console.log(
    `\nAltShortBot Executor — ${IS_PAPER ? "[PAPER MODE]" : "[LIVE]"}`,
  );
  console.log(`Open positions: ${Object.keys(positions).length}`);

  for (const [coin, pos] of Object.entries(positions)) {
    const markPx = markPrices.get(coin) ?? pos.entryPx;
    const pnlPct = ((pos.entryPx - markPx) / pos.entryPx) * 100;
    const hrs = ((Date.now() - pos.openedAt) / 3_600_000).toFixed(1);
    console.log(
      `  ${coin.padEnd(10)} entry: $${pos.entryPx.toFixed(4)}  mark: $${markPx.toFixed(4)}  PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%  held: ${hrs}h  stop: $${pos.stopLossPx.toFixed(4)}`,
    );
  }

  // Paper P&L summary
  if (IS_PAPER && existsSync(PAPER_LOG_FILE)) {
    const trades: PaperTrade[] = readFileSync(PAPER_LOG_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const totalPnl = trades.reduce((s, t) => s + t.pnlUsdc, 0);
    const winRate = trades.length
      ? (trades.filter((t) => t.pnlUsdc > 0).length / trades.length) * 100
      : 0;
    console.log(
      `\nPaper trades: ${trades.length}  Win rate: ${winRate.toFixed(0)}%  Total PnL: $${totalPnl.toFixed(2)}`,
    );
  }
}
```

### 9b. Main loop

```typescript
async function main(): Promise<void> {
  console.log(
    `\nAltShortBot Executor — ${new Date().toISOString()} — ${IS_PAPER ? "PAPER" : "LIVE"}`,
  );

  const positions = loadPositions();
  const markPrices = await fetchMarkPrices();

  if (IS_STATUS) {
    await printStatus(positions, markPrices);
    return; // assetIndex not needed for status display
  }

  const assetIndex = await fetchAssetIndex();

  // 1. Manage existing positions first
  await managePositions(positions, assetIndex, markPrices);

  // 2. Process new signals from queue
  const queue = loadQueue();
  if (queue.length > 0) {
    // Fetch account value BEFORE clearing queue.
    // If this fails, we leave the queue intact so signals survive to next run.
    let accountValue = 0;
    if (!IS_PAPER) {
      try {
        const state = await fetchAccountState();
        accountValue = parseFloat(state.marginSummary.accountValue) || 0;
      } catch (err) {
        console.error(`fetchAccountState failed: ${(err as Error).message}`);
        console.error(
          `Signals NOT processed this run — queue preserved for retry`,
        );
        savePositions(positions);
        return; // exit WITHOUT clearing queue — signals will retry next run
      }
    } else {
      // Paper mode: use configured account size, default 10000, guard against NaN
      accountValue = parseFloat(process.env.HL_PAPER_ACCOUNT ?? "") || 10_000;
    }

    clearQueue(); // clear only after successful account fetch
    console.log(`Processing ${queue.length} queued signal(s)...`);

    for (const signal of queue) {
      // Skip stale signals (>2h old — price has moved too much)
      const ageH = (Date.now() - signal.queuedAt) / 3_600_000;
      if (ageH > 2) {
        console.log(
          `${signal.coin}: signal stale (${ageH.toFixed(1)}h old) — skip`,
        );
        continue;
      }
      await executeSignal(
        signal,
        assetIndex,
        markPrices,
        positions,
        accountValue,
      );
      await new Promise((r) => setTimeout(r, 200)); // rate limit buffer between orders
    }
  }

  savePositions(positions);
  console.log(`Done. Open positions: ${Object.keys(positions).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## Stage 10 — Update ecosystem.config.js

Add the executor as a second PM2 process:

```javascript
module.exports = {
  apps: [
    {
      name: "altshortbot-scanner",
      script: "npx",
      args: "tsx live_scanner.ts",
      cron_restart: "5 * * * *", // hourly at :05
      autorestart: false,
      out_file: "logs/scanner.log",
      error_file: "logs/scanner-error.log",
      time: true,
      env: {
        NODE_ENV: "production",
        TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN ?? "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
      },
    },
    {
      name: "altshortbot-executor",
      script: "npx",
      args: "tsx hl_executor.ts --paper", // remove --paper when going live
      cron_restart: "*/5 * * * *", // every 5 minutes
      autorestart: false,
      out_file: "logs/executor.log",
      error_file: "logs/executor-error.log",
      time: true,
      env: {
        NODE_ENV: "production",
        TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN ?? "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
        HL_WALLET_ADDRESS: process.env.HL_WALLET_ADDRESS ?? "",
        HL_AGENT_KEY: process.env.HL_AGENT_KEY ?? "",
        HL_PAPER_ACCOUNT: "10000", // simulated account size for paper mode
        // HL_TESTNET:       "1",       // uncomment to use testnet
      },
    },
  ],
};
```

---

## Stage 11 — Setup and Testing Sequence

### First-time setup

```bash
# 1. Install dependencies
npm install tsx typescript @nktkas/hyperliquid viem

# 2. Set environment variables
export TELEGRAM_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
export HL_WALLET_ADDRESS="0x..."   # your main Hyperliquid wallet
export HL_AGENT_KEY="0x..."        # separate agent wallet private key

# 3. Capture backtest fixtures (if not done)
npx tsx backtest_test.ts

# 4. Run scanner regression tests
npx tsx scanner_test.ts
# All 6 should pass

# 5. Dry run scanner (no Telegram)
npx tsx live_scanner.ts --coins ORDI,KNC --dry-run

# 6. Test executor in paper mode (no real trades)
# queuedAt must be within 2h of now — use node to generate current timestamp:
node -e "
const sig = [{
  coin:'ORDI', type:'EXHAUSTION', confidence:'HIGH',
  entry:5.82, firedAt:Date.now(), firedAtStr:'test signal',
  fundingApr:0, details:'test', msSinceBuilding:21600000,
  queuedAt:Date.now()
}];
require('fs').writeFileSync('signal_queue.json', JSON.stringify(sig));
console.log('Signal queued with current timestamp');
"
HL_PAPER_ACCOUNT=10000 npx tsx hl_executor.ts --paper

# 7. Check status
npx tsx hl_executor.ts --paper --status

# 8. Start both processes with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Validation period (2-4 weeks in paper mode)

```bash
# Monitor logs
pm2 logs altshortbot-scanner
pm2 logs altshortbot-executor

# Check positions and P&L
npx tsx hl_executor.ts --paper --status

# Review paper trade log
cat paper_trades.jsonl | python3 -c "
import sys, json
trades = [json.loads(l) for l in sys.stdin if l.strip()]
wins = [t for t in trades if t['pnlUsdc'] > 0]
print(f'Trades: {len(trades)}  Win rate: {len(wins)/len(trades)*100:.0f}%')
print(f'Total PnL: \${sum(t[\"pnlUsdc\"] for t in trades):.2f}')
"
```

### Going live (when ready)

```bash
# 1. Fund Hyperliquid account with USDC via Arbitrum bridge
# 2. Approve agent key on app.hyperliquid.xyz → Settings → API
# 3. Test on testnet first:
#    HL_TESTNET=1 npx tsx hl_executor.ts --paper  ← always --paper first, even on testnet

# 4. Remove --paper from ecosystem.config.js executor args
# 5. Restart PM2
pm2 restart altshortbot-executor

# 6. Verify first live order in HL app
```

---

## Critical Implementation Notes

1. **Queue is cleared after fetching account state** (Stage 9b). If `fetchAccountState`
   fails, the queue is preserved and signals retry on the next 5-minute run.
   If the executor crashes AFTER clearing the queue mid-processing, those signals
   are lost (prevents double-execution). Accept this tradeoff — signals come every hour.

2. **Crash between order placement and position recording** (Stage 7): if the executor
   crashes after `openShort()` succeeds but before `positions[coin] = {...}`, a live
   position exists on the exchange with a stop-loss but no local record. The next
   run's reconciliation will NOT detect this (it removes local records for positions
   NOT on exchange, not the reverse). Manual intervention required: check
   app.hyperliquid.xyz for any untracked open positions after a crash.
   Mitigation: the stop-loss is placed immediately after entry, so the position
   is protected even without local tracking.

3. **Agent key ≠ main key.** The agent key is on the VPS. The main private key
   (holding your USDC) never touches the VPS. Revoke the agent key at any time
   from app.hyperliquid.xyz if the VPS is compromised.

4. **Asset index can change.** Hyperliquid occasionally relists assets at a new
   index. Always call `fetchAssetIndex()` at the start of each executor run.
   Never hardcode numeric indices.

5. **Paper account size** (`HL_PAPER_ACCOUNT`) should match your intended live
   account size for realistic position sizing simulation.

6. **Stop-loss in live mode** is placed immediately after entry. If `placeStopLoss`
   fails, log the error and send a Telegram alert — do not proceed without a stop.

7. **Signal staleness check** (Stage 9b): reject signals older than 2h. The scanner
   runs hourly; if the executor was down for a cycle, old signals may be at very
   different prices.

8. **`szDecimals`** controls how many decimal places are valid for a coin's size.
   ORDI might be 1 decimal, ETH might be 4. Always use the value from `meta`,
   not a hardcoded assumption.
