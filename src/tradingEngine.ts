/**
 * Multi-Strategy Signal Generation Engine.
 * 
 * Runs three independent strategies in parallel:
 * 1. Momentum — trend-following using MACD, RSI, EMA alignment
 * 2. Mean Reversion — oversold/overbought bounces using Bollinger Bands + RSI
 * 3. Relative Strength — outperformance vs benchmark (SPY)
 * 
 * A Conviction Filter requires 2+ strategies to agree before execution.
 */

import type {
  OHLCVBar,
  Indicators,
  Signal,
  SignalDirection,
  MultiStrategyResult,
  MarketRegime,
} from "./types";
import { buildIndicators } from "./indicators";
import { detectRegime } from "./regimeDetector";

// ─── Momentum Strategy ──────────────────────────────────────────────────────

function evaluateMomentum(indicators: Indicators, symbol: string): Signal {
  const { emaShort, emaLong, ema50, rsi, macd, adx, volume, avgVolume, price } = indicators;
  let confidence = 0;
  let direction: SignalDirection = "HOLD";
  const reasons: string[] = [];

  // EMA alignment check (short > long > 50 = bullish)
  const bullishAlignment = emaShort > emaLong && emaLong > ema50;
  const bearishAlignment = emaShort < emaLong && emaLong < ema50;

  if (bullishAlignment) {
    confidence += 20;
    reasons.push("Bullish EMA alignment (8 > 21 > 50)");
  } else if (bearishAlignment) {
    confidence -= 20;
    reasons.push("Bearish EMA alignment");
  }

  // MACD crossover
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    confidence += 15;
    reasons.push(`MACD bullish (histogram: ${macd.histogram.toFixed(3)})`);
  } else if (macd.histogram < 0) {
    confidence -= 15;
    reasons.push("MACD bearish");
  }

  // RSI momentum zone (40-70 is healthy uptrend)
  if (rsi >= 40 && rsi <= 70) {
    confidence += 10;
    reasons.push(`RSI in momentum zone (${rsi.toFixed(1)})`);
  } else if (rsi > 80) {
    confidence -= 15;
    reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
  }

  // ADX trend strength
  if (adx > 25) {
    confidence += 15;
    reasons.push(`Strong trend (ADX: ${adx.toFixed(1)})`);
  } else if (adx < 15) {
    confidence -= 10;
    reasons.push("Weak/no trend");
  }

  // Volume confirmation
  if (volume > avgVolume * 1.5) {
    confidence += 10;
    reasons.push("Volume surge (1.5x avg)");
  }

  // Price above key EMAs
  if (price > emaShort && price > emaLong) {
    confidence += 10;
    reasons.push("Price above EMAs");
  }

  // Determine direction
  if (confidence >= 40) {
    direction = "BUY";
    confidence = Math.min(95, 50 + confidence);
  } else if (confidence <= -30) {
    direction = "SELL";
    confidence = Math.min(95, 50 + Math.abs(confidence));
  } else {
    direction = "HOLD";
    confidence = Math.max(0, 30 + confidence);
  }

  return {
    symbol,
    direction,
    confidence: Math.round(confidence),
    strategy: "momentum",
    reasoning: reasons.join("; "),
    timestamp: Date.now(),
  };
}

// ─── Mean Reversion Strategy ────────────────────────────────────────────────

function evaluateMeanReversion(indicators: Indicators, symbol: string): Signal {
  const { rsi, bollingerBands, volume, avgVolume, price } = indicators;
  let bounceScore = 0;
  const reasons: string[] = [];

  // RSI extremes
  if (rsi < 25) {
    bounceScore += 30;
    reasons.push(`Deeply oversold RSI (${rsi.toFixed(1)})`);
  } else if (rsi < 30) {
    bounceScore += 20;
    reasons.push(`Oversold RSI (${rsi.toFixed(1)})`);
  } else if (rsi > 75) {
    bounceScore -= 25;
    reasons.push(`Overbought RSI (${rsi.toFixed(1)})`);
  }

  // Bollinger Band position
  const bbPosition = (price - bollingerBands.lower) / (bollingerBands.upper - bollingerBands.lower);

  if (price < bollingerBands.lower * 0.98) {
    bounceScore += 25;
    reasons.push("Price below lower BB (extreme)");
  } else if (price < bollingerBands.lower) {
    bounceScore += 15;
    reasons.push("Price at lower Bollinger Band");
  } else if (price > bollingerBands.upper * 1.02) {
    bounceScore -= 20;
    reasons.push("Price above upper BB (extreme)");
  }

  // Volume spike on oversold = capitulation (bullish reversal signal)
  if (bounceScore > 0 && volume > avgVolume * 2.0) {
    bounceScore += 20;
    reasons.push("Capitulation volume (2x avg)");
  }

  // Bandwidth expansion = volatility increasing (better mean reversion setups)
  if (bollingerBands.bandwidth > 0.08) {
    bounceScore += 10;
    reasons.push("High BB bandwidth (volatile)");
  }

  // Determine signal
  let direction: SignalDirection = "HOLD";
  let confidence = 30;

  if (bounceScore >= 40) {
    direction = "BUY";
    confidence = Math.min(90, 50 + bounceScore);
    reasons.unshift("Mean reversion BUY setup — oversold bounce detected");
  } else if (bounceScore <= -30) {
    direction = "SELL";
    confidence = Math.min(90, 50 + Math.abs(bounceScore));
    reasons.unshift("Mean reversion SELL setup");
  }

  return {
    symbol,
    direction,
    confidence: Math.round(confidence),
    strategy: "mean_reversion",
    reasoning: reasons.join("; "),
    timestamp: Date.now(),
  };
}

// ─── Relative Strength Strategy ─────────────────────────────────────────────

export interface RelativeStrengthResult {
  symbolReturn: number;
  benchmarkReturn: number;
  rsScore: number;
  percentile: number;
  outperforming: boolean;
}

/**
 * Calculates relative strength of a symbol vs benchmark.
 * Returns percentile ranking and outperformance flag.
 */
export function calculateRelativeStrength(
  symbolBars: OHLCVBar[],
  benchmarkBars: OHLCVBar[],
  lookback: number = 20
): RelativeStrengthResult {
  if (symbolBars.length < lookback || benchmarkBars.length < lookback) {
    return { symbolReturn: 0, benchmarkReturn: 0, rsScore: 0, percentile: 50, outperforming: false };
  }

  const symbolReturn =
    (symbolBars[symbolBars.length - 1].close - symbolBars[symbolBars.length - lookback].close) /
    symbolBars[symbolBars.length - lookback].close * 100;

  const benchmarkReturn =
    (benchmarkBars[benchmarkBars.length - 1].close - benchmarkBars[benchmarkBars.length - lookback].close) /
    benchmarkBars[benchmarkBars.length - lookback].close * 100;

  const rsScore = symbolReturn - benchmarkReturn;

  // Percentile ranking (simplified — in production, compare against universe)
  const percentile = Math.min(99, Math.max(1, 50 + rsScore * 5));

  return {
    symbolReturn,
    benchmarkReturn,
    rsScore,
    percentile,
    outperforming: rsScore > 0,
  };
}

function evaluateRelativeStrength(
  symbolBars: OHLCVBar[],
  benchmarkBars: OHLCVBar[],
  symbol: string
): Signal {
  const rsData = calculateRelativeStrength(symbolBars, benchmarkBars);
  const reasons: string[] = [];
  let direction: SignalDirection = "HOLD";
  let confidence = 30;

  reasons.push(`RS Score: ${rsData.rsScore.toFixed(2)}, Percentile: ${rsData.percentile.toFixed(0)}`);

  if (rsData.percentile >= 80 && rsData.rsScore > 5) {
    direction = "BUY";
    confidence = Math.round(50 + rsData.percentile * 0.3);
    reasons.push("Top 20% relative strength — buy the leader");
  } else if (rsData.percentile >= 65 && rsData.rsScore > 2) {
    direction = "BUY";
    confidence = Math.round(45 + rsData.percentile * 0.2);
    reasons.push("Strong relative outperformance");
  } else if (rsData.percentile <= 20) {
    direction = "SELL";
    confidence = Math.round(50 + (100 - rsData.percentile) * 0.2);
    reasons.push("Bottom 20% — relative weakness");
  }

  return {
    symbol,
    direction,
    confidence: Math.min(95, confidence),
    strategy: "relative_strength",
    reasoning: reasons.join("; "),
    timestamp: Date.now(),
  };
}

// ─── Conviction Filter ──────────────────────────────────────────────────────

/**
 * Requires at least 2 strategies to agree on direction before executing.
 * Accepts either a MultiStrategyResult or a raw Signal array.
 * This reduces false signals and improves win rate significantly.
 */
export function passesConvictionFilter(input: MultiStrategyResult | Signal[]): boolean {
  let signals: Signal[];

  if (Array.isArray(input)) {
    signals = input;
  } else {
    // MultiStrategyResult — combine primary + alternatives
    signals = [input.primary, ...input.alternatives];
  }

  if (signals.length === 0) return false;

  const primary = signals[0];
  if (primary.direction === "HOLD") return false;

  let agreeing = 1; // Primary always agrees with itself
  for (let i = 1; i < signals.length; i++) {
    if (signals[i].direction === primary.direction) {
      agreeing++;
    }
  }

  return agreeing >= 2;
}

// ─── Wrapper functions for testing ──────────────────────────────────────────

/**
 * Detects momentum signal from raw bars.
 * Wrapper that builds indicators internally for convenience.
 */
export function detectMomentumSignal(
  symbolBars: OHLCVBar[],
  benchmarkBars: OHLCVBar[]
): Signal | null {
  const indicators = buildIndicators(symbolBars);
  if (!indicators) return null;

  const symbol = "UNKNOWN";
  return evaluateMomentum(indicators, symbol);
}

/**
 * Detects mean reversion signal from raw bars.
 * Wrapper that builds indicators internally for convenience.
 */
export function detectMeanReversion(bars: OHLCVBar[]): Signal | null {
  const indicators = buildIndicators(bars);
  if (!indicators) return null;

  const symbol = "UNKNOWN";
  return evaluateMeanReversion(indicators, symbol);
}

// ─── Main Signal Generator ──────────────────────────────────────────────────

/**
 * Generates a multi-strategy signal for a given symbol.
 * 
 * @param symbolBars - OHLCV data for the target symbol
 * @param benchmarkBars - OHLCV data for benchmark (SPY)
 * @param symbol - Ticker symbol
 * @returns MultiStrategyResult with primary signal, alternatives, and conviction check
 */
export function generateSignal(
  symbolBars: OHLCVBar[],
  benchmarkBars: OHLCVBar[],
  symbol: string
): MultiStrategyResult | null {
  const indicators = buildIndicators(symbolBars);
  if (!indicators) return null;

  const regime = detectRegime(symbolBars);

  // Run all three strategies independently
  const momentumSignal = evaluateMomentum(indicators, symbol);
  const meanRevSignal = evaluateMeanReversion(indicators, symbol);
  const rsSignal = evaluateRelativeStrength(symbolBars, benchmarkBars, symbol);

  // Sort by confidence to find primary
  const allSignals = [momentumSignal, meanRevSignal, rsSignal]
    .filter(s => s.direction !== "HOLD")
    .sort((a, b) => b.confidence - a.confidence);

  // If no actionable signals, return HOLD
  if (allSignals.length === 0) {
    return {
      primary: {
        symbol,
        direction: "HOLD",
        confidence: 0,
        strategy: "momentum",
        reasoning: "No strategy generated actionable signal",
        timestamp: Date.now(),
      },
      alternatives: [momentumSignal, meanRevSignal, rsSignal],
      regime: regime.regime,
      passesConviction: false,
    };
  }

  const primary = allSignals[0];
  const alternatives = [momentumSignal, meanRevSignal, rsSignal].filter(s => s !== primary);
  const conviction = passesConvictionFilter([primary, ...alternatives]);

  return {
    primary,
    alternatives,
    regime: regime.regime,
    passesConviction: conviction,
  };
}

// ─── Exports for testing ────────────────────────────────────────────────────

export {
  evaluateMomentum,
  evaluateMeanReversion,
  evaluateRelativeStrength,
};
