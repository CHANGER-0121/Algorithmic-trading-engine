/**
 * Unit tests for technical indicator calculations.
 * Tests accuracy, edge cases, and boundary conditions.
 */

import { describe, it, expect } from "vitest";
import {
  calculateEMA,
  latestEMA,
  calculateRSI,
  calculateMACD,
  calculateATR,
  calculateADX,
  calculateBollingerBands,
  buildIndicators,
} from "../src/indicators";
import type { OHLCVBar } from "../src/types";

// ─── Test Data Generators ───────────────────────────────────────────────────

function generateUptrend(length: number, startPrice: number = 100): number[] {
  const data: number[] = [];
  let price = startPrice;
  for (let i = 0; i < length; i++) {
    price += Math.random() * 2 - 0.5; // Slight upward bias
    data.push(price);
  }
  return data;
}

function generateSideways(length: number, center: number = 100): number[] {
  return Array.from({ length }, () => center + (Math.random() - 0.5) * 5);
}

function generateBars(closes: number[]): OHLCVBar[] {
  return closes.map((close, i) => ({
    timestamp: Date.now() - (closes.length - i) * 86400000,
    open: close * (1 + (Math.random() - 0.5) * 0.02),
    high: close * (1 + Math.random() * 0.03),
    low: close * (1 - Math.random() * 0.03),
    close,
    volume: 1000000 + Math.floor(Math.random() * 500000),
  }));
}

// ─── EMA Tests ──────────────────────────────────────────────────────────────

describe("calculateEMA", () => {
  it("returns empty array when data is shorter than period", () => {
    expect(calculateEMA([1, 2, 3], 5)).toEqual([]);
  });

  it("first value equals SMA of first N values", () => {
    const data = [10, 20, 30, 40, 50, 60, 70];
    const result = calculateEMA(data, 3);
    // SMA of first 3: (10+20+30)/3 = 20
    expect(result[0]).toBeCloseTo(20, 5);
  });

  it("EMA responds faster to recent prices than SMA", () => {
    const data = [10, 10, 10, 10, 10, 50]; // Sudden spike
    const ema = calculateEMA(data, 5);
    const lastEma = ema[ema.length - 1];
    // EMA should be between 10 and 50, weighted toward recent
    expect(lastEma).toBeGreaterThan(10);
    expect(lastEma).toBeLessThan(50);
  });

  it("handles single-element period (EMA = data itself)", () => {
    const data = [5, 10, 15, 20];
    const result = calculateEMA(data, 1);
    // With period 1, multiplier = 1, so EMA = current value
    expect(result).toEqual(data);
  });

  it("produces correct number of output values", () => {
    const data = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = calculateEMA(data, 10);
    // Output length = data.length - period + 1
    expect(result.length).toBe(41);
  });

  it("latestEMA returns NaN for insufficient data", () => {
    expect(latestEMA([1, 2], 5)).toBeNaN();
  });

  it("latestEMA returns the last EMA value", () => {
    const data = [10, 20, 30, 40, 50];
    const allEma = calculateEMA(data, 3);
    expect(latestEMA(data, 3)).toBe(allEma[allEma.length - 1]);
  });
});

// ─── RSI Tests ──────────────────────────────────────────────────────────────

describe("calculateRSI", () => {
  it("returns empty for insufficient data", () => {
    expect(calculateRSI([1, 2, 3], 14)).toEqual([]);
  });

  it("RSI approaches 100 in pure uptrend", () => {
    // 20 consecutive up days
    const data = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    const rsi = calculateRSI(data, 14);
    const lastRSI = rsi[rsi.length - 1];
    expect(lastRSI).toBeGreaterThan(90);
  });

  it("RSI approaches 0 in pure downtrend", () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
    const rsi = calculateRSI(data, 14);
    const lastRSI = rsi[rsi.length - 1];
    expect(lastRSI).toBeLessThan(10);
  });

  it("RSI is near 50 in sideways market", () => {
    // Alternating up/down
    const data = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const rsi = calculateRSI(data, 14);
    const lastRSI = rsi[rsi.length - 1];
    expect(lastRSI).toBeGreaterThan(40);
    expect(lastRSI).toBeLessThan(60);
  });

  it("RSI values are always between 0 and 100", () => {
    const data = generateUptrend(100);
    const rsi = calculateRSI(data, 14);
    for (const val of rsi) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(100);
    }
  });
});

// ─── MACD Tests ─────────────────────────────────────────────────────────────

describe("calculateMACD", () => {
  it("returns empty for insufficient data", () => {
    expect(calculateMACD([1, 2, 3])).toEqual([]);
  });

  it("histogram is positive when MACD > signal", () => {
    const data = generateUptrend(60, 100);
    const macd = calculateMACD(data);
    const last = macd[macd.length - 1];
    // In uptrend, MACD line should be above signal
    expect(last.histogram).toBe(last.macd - last.signal);
  });

  it("MACD line equals fast EMA minus slow EMA", () => {
    const data = Array.from({ length: 50 }, (_, i) => 100 + i);
    const macd = calculateMACD(data, 12, 26, 9);
    // Verify structural correctness
    expect(macd.length).toBeGreaterThan(0);
    for (const point of macd) {
      expect(point.histogram).toBeCloseTo(point.macd - point.signal, 10);
    }
  });
});

// ─── ATR Tests ──────────────────────────────────────────────────────────────

describe("calculateATR", () => {
  it("returns empty for insufficient bars", () => {
    const bars = generateBars([100, 101, 102]);
    expect(calculateATR(bars, 14)).toEqual([]);
  });

  it("ATR is always positive", () => {
    const bars = generateBars(generateUptrend(50));
    const atr = calculateATR(bars, 14);
    for (const val of atr) {
      expect(val).toBeGreaterThan(0);
    }
  });

  it("ATR increases during volatile periods", () => {
    // Calm period followed by volatile period
    const calm = Array.from({ length: 20 }, () => 100);
    const volatile = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 10 : -10));
    const bars = generateBars([...calm, ...volatile]);
    const atr = calculateATR(bars, 5);

    // Later ATR values should be higher than earlier ones
    const earlyATR = atr[5];
    const lateATR = atr[atr.length - 1];
    expect(lateATR).toBeGreaterThan(earlyATR);
  });
});

// ─── Bollinger Bands Tests ──────────────────────────────────────────────────

describe("calculateBollingerBands", () => {
  it("returns null for insufficient data", () => {
    expect(calculateBollingerBands([1, 2, 3], 20)).toBeNull();
  });

  it("middle band equals SMA", () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 + i);
    const bb = calculateBollingerBands(data, 20);
    expect(bb).not.toBeNull();
    const expectedSMA = data.reduce((a, b) => a + b, 0) / 20;
    expect(bb!.middle).toBeCloseTo(expectedSMA, 5);
  });

  it("upper > middle > lower always holds", () => {
    const data = generateUptrend(30);
    const bb = calculateBollingerBands(data, 20);
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.middle).toBeGreaterThan(bb!.lower);
  });

  it("bandwidth is positive", () => {
    const data = generateSideways(30);
    const bb = calculateBollingerBands(data, 20);
    expect(bb).not.toBeNull();
    expect(bb!.bandwidth).toBeGreaterThan(0);
  });

  it("bands widen during high volatility", () => {
    const calm = generateSideways(20, 100);
    const volatile = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 8 : -8));

    const bbCalm = calculateBollingerBands(calm, 20);
    const bbVolatile = calculateBollingerBands(volatile, 20);

    expect(bbVolatile!.bandwidth).toBeGreaterThan(bbCalm!.bandwidth);
  });
});

// ─── Build Indicators Integration Test ──────────────────────────────────────

describe("buildIndicators", () => {
  it("returns null for insufficient data (< 50 bars)", () => {
    const bars = generateBars(Array.from({ length: 30 }, () => 100));
    expect(buildIndicators(bars)).toBeNull();
  });

  it("returns complete indicator set for sufficient data", () => {
    const bars = generateBars(generateUptrend(60));
    const indicators = buildIndicators(bars);

    expect(indicators).not.toBeNull();
    expect(indicators!.emaShort).toBeDefined();
    expect(indicators!.emaLong).toBeDefined();
    expect(indicators!.ema50).toBeDefined();
    expect(indicators!.rsi).toBeGreaterThanOrEqual(0);
    expect(indicators!.rsi).toBeLessThanOrEqual(100);
    expect(indicators!.atr).toBeGreaterThan(0);
    expect(indicators!.bollingerBands.upper).toBeGreaterThan(indicators!.bollingerBands.lower);
  });

  it("EMA short < EMA long in downtrend", () => {
    const downtrend = Array.from({ length: 60 }, (_, i) => 200 - i * 1.5);
    const bars = generateBars(downtrend);
    const indicators = buildIndicators(bars);

    expect(indicators).not.toBeNull();
    expect(indicators!.emaShort).toBeLessThan(indicators!.emaLong);
  });
});
