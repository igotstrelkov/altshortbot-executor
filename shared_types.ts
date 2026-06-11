export interface Alert {
  coin: string;
  type: "FUNDING" | "PUMP_TOP" | "BUILDING" | "EXHAUSTION" | "TREND_BREAK";
  firedAt: number;
  firedAtStr: string;
  entry: number;
  fundingApr: number;
  details: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  msSinceBuilding: number | null;
}

export interface QueuedSignal extends Alert {
  queuedAt: number;
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
  // The four queueable signal types — every type that can reach an executor
  // and become a position. FUNDING is excluded (never queued). EXHAUSTION is
  // retained: queueing is currently suspended but the type stays valid (the
  // suspension is reversible). Executors narrow the 5-member Alert["type"] to
  // this with a cast — a safe narrowing, since FUNDING never reaches them.
  signalType: "PUMP_TOP" | "BUILDING" | "EXHAUSTION" | "TREND_BREAK";
  signalConfidence: "HIGH" | "MEDIUM";
  stopOid?: number;
  isPaper: boolean;
  // Excursion tracking for post-trade diagnostics, updated each manage cycle.
  // maxAdversePx = highest price seen (worst for a short → MAE); maxFavorablePx
  // = lowest price seen (best for a short → MFE). Optional for back-compat with
  // records written before this field.
  maxAdversePx?: number;
  maxFavorablePx?: number;
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
  // Exit reasons the executors actually produce. "stop" and "timeout" are the
  // two automated exits (no take-profit, no trailing stop); "manual" covers a
  // position closed by hand. The former "target" and "trailing" values were
  // removed — the executors have no take-profit or trailing-stop logic.
  closeReason: "stop" | "timeout" | "manual";
  signalType: string;
  confidence: string;
  // Realised funding over the hold (USDT; negative = paid). Shorts on negative
  // funding PAY — a cost the price-only `pnlUsdc` omits. Persisted so all-in R
  // (priceR + fundingR) is recomputable without re-fetching from the exchange,
  // which has limited funding-history retention. Optional: null when funding
  // could not be fetched (paper mode, API failure, or records written before
  // this field existed).
  fundingPaidUsdt?: number | null;
}
