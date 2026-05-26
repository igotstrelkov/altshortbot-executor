/**
 * kucoin_probe.ts — throwaway diagnostic, NOT part of the bot
 * ============================================================
 * Calls three READ-ONLY KuCoin futures endpoints and dumps their response
 * shapes, so the exact field names can be confirmed before kucoin_executor.ts
 * is written. Places no orders, changes nothing.
 *
 *   getSymbol   — contract specs (multiplier, lotSize, maxLeverage, tickSize)
 *   getBalance  — account equity (for risk-based sizing)
 *   getPosition — open-position shape (for stop-loss detection)
 *
 * Setup:
 *   npm install kucoin-api
 *
 * Run:
 *   npx tsx kucoin_probe.ts                 # probes XBTUSDTM
 *   npx tsx kucoin_probe.ts BONK            # also probes BONKUSDTM (an alt)
 *
 * Env vars (getSymbol is PUBLIC and works without them; the other two need them):
 *   KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE
 *
 * What to send back: copy the WHOLE output. Account numbers can be redacted —
 * only field NAMES and TYPES are needed, so a balance of 0 or 1.23 is fine.
 */

let FuturesClient: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ FuturesClient } = require("kucoin-api"));
} catch {
  console.error(
    "\n  kucoin-api is not installed.\n" +
      "  Run:  npm install kucoin-api\n" +
      "  then: npx tsx kucoin_probe.ts\n",
  );
  process.exit(1);
}

const API_KEY = process.env.KUCOIN_API_KEY ?? "";
const API_SECRET = process.env.KUCOIN_API_SECRET ?? "";
const API_PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE ?? "";

// Optional alt symbol to cross-check sizing fields on a cheap coin.
const altArg = process.argv[2]?.trim().toUpperCase();
const ALT_SYMBOL = altArg ? `${altArg}USDTM` : null;

const line = (c = "─") => console.log(c.repeat(72));

// Print a value's full JSON plus a flat field-map (key → type/sample) so the
// field names are obvious even at a glance.
function dump(label: string, value: unknown): void {
  line("═");
  console.log(`  ${label}`);
  line("═");
  console.log("RAW:");
  console.log(JSON.stringify(value, null, 2));

  // If there's a `data` envelope, map its fields explicitly — that's the part
  // the executor reads.
  const obj = value as Record<string, any> | null;
  const data = obj && typeof obj === "object" && "data" in obj ? obj.data : obj;
  const target = Array.isArray(data) ? data[0] : data;

  if (target && typeof target === "object") {
    console.log("\nFIELD MAP" + (Array.isArray(data) ? " (first array element)" : "") + ":");
    for (const [k, v] of Object.entries(target)) {
      const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      const sample =
        t === "object" || t === "array" ? "" : `  = ${JSON.stringify(v)}`;
      console.log(`  ${k.padEnd(28)} ${t.padEnd(8)}${sample}`);
    }
  }
  console.log("");
}

async function probe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    dump(label, await fn());
  } catch (e: any) {
    line("═");
    console.log(`  ${label}`);
    line("═");
    console.log("ERROR:", e?.message ?? e);
    // KuCoin errors often carry a body with code/msg — surface it.
    if (e?.response?.data) console.log("body:", JSON.stringify(e.response.data, null, 2));
    if (e?.body) console.log("body:", JSON.stringify(e.body, null, 2));
    console.log("");
  }
}

async function main() {
  console.log("\nKuCoin futures API probe — read-only, places no orders\n");
  const hasKeys = API_KEY && API_SECRET && API_PASSPHRASE;
  console.log(
    hasKeys
      ? "  API credentials: present — all three endpoints will be probed."
      : "  API credentials: MISSING — only getSymbol (public) will work.\n" +
        "  Set KUCOIN_API_KEY / _SECRET / _PASSPHRASE for getBalance + getPosition.",
  );
  console.log("");

  // FuturesClient with no args still allows public endpoints (see SDK example
  // rest-futures-public.ts). Pass creds when available.
  const client = hasKeys
    ? new FuturesClient({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        apiPassphrase: API_PASSPHRASE,
      })
    : new FuturesClient();

  // 1) getSymbol — PUBLIC. Contract specs that drive sizing + the listing filter.
  await probe("getSymbol({ symbol: 'XBTUSDTM' })  — BTC contract", () =>
    client.getSymbol({ symbol: "XBTUSDTM" }),
  );
  if (ALT_SYMBOL) {
    await probe(
      `getSymbol({ symbol: '${ALT_SYMBOL}' })  — alt cross-check`,
      () => client.getSymbol({ symbol: ALT_SYMBOL }),
    );
  }

  if (!hasKeys) {
    console.log("  Skipping getBalance + getPosition (no credentials).\n");
    return;
  }

  // 2) getBalance — equity for risk sizing. Looking for the equity field name.
  await probe("getBalance({ currency: 'USDT' })  — account equity", () =>
    client.getBalance({ currency: "USDT" }),
  );

  // 3) getPosition — open-position shape for stop detection.
  //    A FLAT (no-position) response is just as useful — it shows what
  //    "no open position" looks like, which managePositions checks against.
  await probe(
    "getPosition({ symbol: 'XBTUSDTM' })  — position shape (flat is fine)",
    () => client.getPosition({ symbol: "XBTUSDTM" }),
  );

  line("═");
  console.log("  Done. Copy everything above. Numbers may be redacted —");
  console.log("  only field NAMES and TYPES are needed.");
  line("═");
}

main();
