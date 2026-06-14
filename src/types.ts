/**
 * Core type definitions for the algorithmic trading engine.
 * All types are strictly typed with no `any` usage.
 */

// ─── Market Data Types ──────────────────────────────────────────────────────

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
}

// ─── Signal Types ───────────────────────────────────────────────────────────

export type SignalDirection = "BUY" | "SELL" | "HOLD";
export type StrategyType = "momentum" | "mean_reversion" | "relative_strength";
export type MarketRegime = "strong_uptrend" | "uptrend" | "sideways" | "downtrend" | "strong_downtrend";

export interface Signal {
  symbol: string;
  direction: SignalDirection;
  confidence: number;        // 0-100 scale
  strategy: StrategyType;
  reasoning: string;
  timestamp: number;
}

export interface MultiStrategyResult {
  primary: Signal;
  alternatives: Signal[];
  regime: MarketRegime;
  passesConviction: boolean; // 2+ strategies agree
}

// ─── Technical Indicators ───────────────────────────────────────────────────

export interface Indicators {
  emaShort: number;          // 8-period EMA
  emaLong: number;           // 21-period EMA
  ema50: number;             // 50-period EMA
  rsi: number;               // 14-period RSI
  macd: MACDResult;
  atr: number;               // 14-period ATR
  adx: number;               // Average Directional Index
  bollingerBands: BollingerBands;
  volume: number;
  avgVolume: number;         // 20-period average volume
  price: number;
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

// ─── Position & Risk Types ──────────────────────────────────────────────────

export interface Position {
  symbol: string;
  entryPrice: number;
  quantity: number;
  side: "long" | "short";
  entryTime: number;
  strategy: StrategyType;
  stopLoss: number;
  takeProfit: number;
  pyramidCount: number;
}

export interface PositionSizeResult {
  shares: number;
  dollarAmount: number;
  riskPerShare: number;
  riskPercent: number;
  confidenceScale: number;
}

export interface RiskLimits {
  maxPositions: number;
  maxDailyEntries: number;
  maxCorrelatedExposure: number;
  maxOvernightExposure: number;
  maxSameStrategy: number;
  circuitBreakerThreshold: number;
}

// ─── Regime Detection ───────────────────────────────────────────────────────

export interface RegimeAnalysis {
  regime: MarketRegime;
  adx: number;
  trendStrength: number;     // 0-100
  emaAlignment: boolean;     // Short > Medium > Long = bullish alignment
  breadthScore: number;      // Market breadth indicator
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface TradingConfig {
  confidenceThreshold: number;
  riskPerTrade: number;      // As decimal (0.02 = 2%)
  maxPositionPct: number;    // Max % of portfolio per position
  pyramidMinProfit: number;  // Min profit % before pyramiding
  pyramidMaxAdds: number;
  partialProfitPct: number;  // % of target to take partial profit
  trailingStopAtr: number;   // ATR multiplier for trailing stop
}

export const DEFAULT_CONFIG: TradingConfig = {
  confidenceThreshold: 62,
  riskPerTrade: 0.02,
  maxPositionPct: 0.25,
  pyramidMinProfit: 3.0,
  pyramidMaxAdds: 2,
  partialProfitPct: 0.5,
  trailingStopAtr: 2.5,
};
