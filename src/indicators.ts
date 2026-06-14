/**
 * Technical indicator calculations.
 * All functions are pure — no side effects, deterministic outputs.
 */

import type { OHLCVBar, MACDResult, BollingerBands, Indicators } from "./types";

// ─── Exponential Moving Average ─────────────────────────────────────────────

export function calculateEMA(data: number[], period: number): number[] {
  if (data.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result.push(sum / period);

  // Calculate EMA for remaining values
  for (let i = period; i < data.length; i++) {
    const ema = (data[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
    result.push(ema);
  }

  return result;
}

/**
 * Returns the latest EMA value for a given period.
 * Returns NaN if insufficient data.
 */
export function latestEMA(data: number[], period: number): number {
  const emaValues = calculateEMA(data, period);
  return emaValues.length > 0 ? emaValues[emaValues.length - 1] : NaN;
}

// ─── Relative Strength Index (RSI) ─────────────────────────────────────────

export function calculateRSI(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];

  const gains: number[] = [];
  const losses: number[] = [];

  // Calculate price changes
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  const result: number[] = [];

  // Initial average gain/loss (SMA)
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // First RSI value
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs));

  // Subsequent values using Wilder's smoothing
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    const currentRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + currentRS));
  }

  return result;
}

// ─── MACD (Moving Average Convergence Divergence) ───────────────────────────

export function calculateMACD(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult[] {
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);

  if (fastEMA.length === 0 || slowEMA.length === 0) return [];

  // Align arrays — slow EMA starts later
  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];

  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }

  // Signal line is EMA of MACD line
  const signalLine = calculateEMA(macdLine, signalPeriod);

  if (signalLine.length === 0) return [];

  // Align MACD with signal
  const signalOffset = macdLine.length - signalLine.length;
  const results: MACDResult[] = [];

  for (let i = 0; i < signalLine.length; i++) {
    const macd = macdLine[i + signalOffset];
    const signal = signalLine[i];
    results.push({
      macd,
      signal,
      histogram: macd - signal,
    });
  }

  return results;
}

// ─── Average True Range (ATR) ───────────────────────────────────────────────

export function calculateATR(bars: OHLCVBar[], period: number = 14): number[] {
  if (bars.length < period + 1) return [];

  // Calculate True Range for each bar
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // First ATR is simple average
  const result: number[] = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(atr);

  // Subsequent ATR values using Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    result.push(atr);
  }

  return result;
}

// ─── Average Directional Index (ADX) ────────────────────────────────────────

export function calculateADX(bars: OHLCVBar[], period: number = 14): number[] {
  if (bars.length < period * 2 + 1) return [];

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const highDiff = bars[i].high - bars[i - 1].high;
    const lowDiff = bars[i - 1].low - bars[i].low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trueRanges.push(tr);
  }

  // Wilder's smoothing for DM and TR
  const smooth = (arr: number[], p: number): number[] => {
    const result: number[] = [];
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    result.push(sum);
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      result.push(sum);
    }
    return result;
  };

  const smoothPlusDM = smooth(plusDM, period);
  const smoothMinusDM = smooth(minusDM, period);
  const smoothTR = smooth(trueRanges, period);

  // Calculate DI+ and DI-
  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) {
      dx.push(0);
      continue;
    }
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100;
    const diSum = plusDI + minusDI;
    dx.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  // ADX is smoothed DX
  if (dx.length < period) return [];
  const result: number[] = [];
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(adx);

  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    result.push(adx);
  }

  return result;
}

// ─── Bollinger Bands ────────────────────────────────────────────────────────

export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBands | null {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;

  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDev * stdDevMultiplier;
  const lower = middle - stdDev * stdDevMultiplier;

  return {
    upper,
    middle,
    lower,
    bandwidth: (upper - lower) / middle,
  };
}

// ─── Composite Indicator Builder ────────────────────────────────────────────

/**
 * Calculates all indicators for a given set of OHLCV bars.
 * Returns null if insufficient data for reliable calculations.
 */
export function buildIndicators(bars: OHLCVBar[]): Indicators | null {
  if (bars.length < 50) return null; // Need at least 50 bars for reliable indicators

  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);

  const emaShort = latestEMA(closes, 8);
  const emaLong = latestEMA(closes, 21);
  const ema50 = latestEMA(closes, 50);

  const rsiValues = calculateRSI(closes, 14);
  const rsi = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;

  const macdValues = calculateMACD(closes);
  const macd = macdValues.length > 0
    ? macdValues[macdValues.length - 1]
    : { macd: 0, signal: 0, histogram: 0 };

  const atrValues = calculateATR(bars, 14);
  const atr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

  const adxValues = calculateADX(bars, 14);
  const adx = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 0;

  const bollingerBands = calculateBollingerBands(closes, 20, 2);
  if (!bollingerBands) return null;

  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  if (isNaN(emaShort) || isNaN(emaLong) || isNaN(ema50)) return null;

  return {
    emaShort,
    emaLong,
    ema50,
    rsi,
    macd,
    atr,
    adx,
    bollingerBands,
    volume: currentVolume,
    avgVolume,
    price: closes[closes.length - 1],
  };
}
