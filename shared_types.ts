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
  oiDropPct?: number; // +ve = OI dropped, -ve = OI rose (squeeze still building)
  recentPumpTop?: boolean; // PUMP_TOP fired within last 12h — squeeze still accelerating
  isRefire?: boolean; // funding became 2× more extreme — more permissive OI gate applies
  candleHighGapPct?: number; // % between current candle high and close — measures intra-hour latency
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
  signalType: "EXHAUSTION" | "TREND_BREAK" | "BUILDING";
  signalConfidence: "HIGH" | "MEDIUM";
  stopOid?: number;
  isPaper: boolean;
  highestPriceSeen?: number;
  lowestPriceSeen?: number; // lowest price seen since entry — drives trailing stop
  trailingStopPx?: number; // current trailing stop level (updated each scan)
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
