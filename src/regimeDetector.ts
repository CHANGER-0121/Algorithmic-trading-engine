/**
 * Market Regime Detection.
 * 
 * Classifies the current market environment into one of five regimes:
 * - strong_uptrend: ADX > 30, bullish EMA alignment, positive slope
 * - uptrend: ADX > 20, price above 50 EMA, positive momentum
 * - sideways: ADX < 20, no clear direction
 * - downtrend: ADX > 20, price below 50 EMA, negative momentum
 * - strong_downtrend: ADX > 30, bearish EMA alignment, negative slope
 * 
 * The regime determines:
 * - Which strategies are prioritized
 * - Position sizing aggressiveness
 * - Overnight exposure limits
 * - Stop-loss tightness
 */

import type { OHLCVBar, MarketRegime, RegimeAnalysis } from "./types";
import { calculateEMA, calculateADX, latestEMA } from "./indicators";

/**
 * Calculates the slope of an EMA over the last N periods.
 * Positive slope = upward trend, negative = downward.
 */
function calculateSlope(values: number[], lookback: number = 5): number {
  if (values.length < lookback) return 0;

  const recent = values.slice(-lookback);
  const first = recent[0];
  const last = recent[recent.length - 1];

  return ((last - first) / first) * 100; // Percentage change
}

/**
 * Checks if EMAs are in bullish alignment (short > medium > long).
 */
function checkEMAAlignment(
  ema8: number,
  ema21: number,
  ema50: number
): { bullish: boolean; bearish: boolean } {
  return {
    bullish: ema8 > ema21 && ema21 > ema50,
    bearish: ema8 < ema21 && ema21 < ema50,
  };
}

/**
 * Calculates a breadth score based on how many bars closed above their 20 EMA
 * in the last N periods. Higher = more bullish breadth.
 */
function calculateBreadth(bars: OHLCVBar[], period: number = 20): number {
  if (bars.length < period + 20) return 50; // Default neutral

  const closes = bars.map(b => b.close);
  const ema20Values = calculateEMA(closes, 20);

  if (ema20Values.length < period) return 50;

  let aboveCount = 0;
  const startIdx = ema20Values.length - period;

  for (let i = startIdx; i < ema20Values.length; i++) {
    const closeIdx = closes.length - ema20Values.length + i;
    if (closes[closeIdx] > ema20Values[i]) {
      aboveCount++;
    }
  }

  return (aboveCount / period) * 100;
}

/**
 * Detects the current market regime from OHLCV data.
 * 
 * @param bars - At least 60 bars of OHLCV data
 * @returns RegimeAnalysis with classified regime and supporting metrics
 */
export function detectRegime(bars: OHLCVBar[]): RegimeAnalysis {
  if (bars.length < 60) {
    return {
      regime: "sideways",
      adx: 0,
      trendStrength: 0,
      emaAlignment: false,
      breadthScore: 50,
    };
  }

  const closes = bars.map(b => b.close);

  // Calculate indicators
  const adxValues = calculateADX(bars, 14);
  const adx = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 0;

  const ema8 = latestEMA(closes, 8);
  const ema21 = latestEMA(closes, 21);
  const ema50 = latestEMA(closes, 50);

  const ema50Values = calculateEMA(closes, 50);
  const ema50Slope = calculateSlope(ema50Values, 5);

  const alignment = checkEMAAlignment(ema8, ema21, ema50);
  const breadthScore = calculateBreadth(bars);

  // Classify regime
  let regime: MarketRegime;
  let trendStrength: number;

  if (adx > 30 && alignment.bullish && ema50Slope > 0.5) {
    regime = "strong_uptrend";
    trendStrength = Math.min(100, adx + breadthScore * 0.3);
  } else if (adx > 20 && closes[closes.length - 1] > ema50 && ema50Slope > 0) {
    regime = "uptrend";
    trendStrength = Math.min(80, adx + breadthScore * 0.2);
  } else if (adx > 30 && alignment.bearish && ema50Slope < -0.5) {
    regime = "strong_downtrend";
    trendStrength = Math.min(100, adx + (100 - breadthScore) * 0.3);
  } else if (adx > 20 && closes[closes.length - 1] < ema50 && ema50Slope < 0) {
    regime = "downtrend";
    trendStrength = Math.min(80, adx + (100 - breadthScore) * 0.2);
  } else {
    regime = "sideways";
    trendStrength = Math.max(0, 50 - adx);
  }

  return {
    regime,
    adx: Math.round(adx * 10) / 10,
    trendStrength: Math.round(trendStrength),
    emaAlignment: alignment.bullish,
    breadthScore: Math.round(breadthScore),
  };
}

/**
 * Returns recommended parameters based on the current regime.
 * Used by the position sizing and risk management modules.
 */
export function getRegimeParameters(regime: MarketRegime) {
  switch (regime) {
    case "strong_uptrend":
      return {
        confidenceBonus: 5,
        overnightExposure: 0.85,
        stopMultiplier: 1.2,    // Wider stops in strong trends
        positionSizeMultiplier: 1.1,
      };
    case "uptrend":
      return {
        confidenceBonus: 3,
        overnightExposure: 0.75,
        stopMultiplier: 1.0,
        positionSizeMultiplier: 1.0,
      };
    case "sideways":
      return {
        confidenceBonus: 0,
        overnightExposure: 0.70,
        stopMultiplier: 0.8,    // Tighter stops in choppy markets
        positionSizeMultiplier: 0.85,
      };
    case "downtrend":
      return {
        confidenceBonus: -5,
        overnightExposure: 0.55,
        stopMultiplier: 0.7,
        positionSizeMultiplier: 0.7,
      };
    case "strong_downtrend":
      return {
        confidenceBonus: -10,
        overnightExposure: 0.40,
        stopMultiplier: 0.6,
        positionSizeMultiplier: 0.5,
      };
  }
}
