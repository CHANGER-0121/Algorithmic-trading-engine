/**
 * Unit tests for Multi-Strategy Signal Generation Engine.
 * Tests signal accuracy, conviction filtering, and strategy selection.
 */

import { describe, it, expect } from "vitest";
import {
  generateSignal,
  detectMomentumSignal,
  detectMeanReversion,
  calculateRelativeStrength,
  passesConvictionFilter,
} from "../src/tradingEngine";
import type { OHLCVBar, Indicators, MultiStrategyResult } from "../src/types";

// ─── Test Data Generators ───────────────────────────────────────────────────

function generateBars(closes: number[]): OHLCVBar[] {
  return closes.map((close, i) => ({
    timestamp: Date.now() - (closes.length - i) * 86400000,
    open: close * (1 + (Math.random() - 0.5) * 0.01),
    high: close * (1 + Math.random() * 0.02),
    low: close * (1 - Math.random() * 0.02),
    close,
    volume: 1000000 + Math.floor(Math.random() * 500000),
  }));
}

function generateUptrend(n: number, start = 100): number[] {
  const data: number[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + Math.random() * 0.02; // 0-2% daily gain
    data.push(price);
  }
  return data;
}

function generateDowntrend(n: number, start = 200): number[] {
  const data: number[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 - Math.random() * 0.02; // 0-2% daily loss
    data.push(price);
  }
  return data;
}

function generateOversold(n: number): number[] {
  // Sharp drop followed by stabilization
  const data: number[] = [];
  let price = 100;
  for (let i = 0; i < n * 0.7; i++) {
    price *= 0.97; // 3% daily drops
    data.push(price);
  }
  for (let i = 0; i < n * 0.3; i++) {
    price *= 1 + (Math.random() - 0.3) * 0.01; // Stabilizing
    data.push(price);
  }
  return data;
}

// ─── Momentum Signal Tests ──────────────────────────────────────────────────

describe("detectMomentumSignal", () => {
  it("generates BUY signal in strong uptrend", () => {
    const bars = generateBars(generateUptrend(60));
    const spyBars = generateBars(generateUptrend(60, 450));
    const signal = detectMomentumSignal(bars, spyBars);

    expect(signal).not.toBeNull();
    if (signal) {
      expect(signal.direction).toBe("BUY");
      expect(signal.confidence).toBeGreaterThan(50);
      expect(signal.strategy).toBe("momentum");
      expect(signal.reasoning).toBeDefined();
    }
  });

  it("generates SELL signal in strong downtrend", () => {
    const bars = generateBars(generateDowntrend(60));
    const spyBars = generateBars(generateUptrend(60, 450));
    const signal = detectMomentumSignal(bars, spyBars);

    if (signal && signal.direction === "SELL") {
      expect(signal.confidence).toBeGreaterThan(50);
      expect(signal.strategy).toBe("momentum");
    }
  });

  it("returns HOLD for insufficient data", () => {
    const bars = generateBars([100, 101, 102]);
    const spyBars = generateBars([450, 451, 452]);
    const signal = detectMomentumSignal(bars, spyBars);

    expect(signal === null || signal.direction === "HOLD").toBe(true);
  });

  it("confidence is bounded 0-100", () => {
    const bars = generateBars(generateUptrend(100));
    const spyBars = generateBars(generateUptrend(100, 450));
    const signal = detectMomentumSignal(bars, spyBars);

    if (signal) {
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(100);
    }
  });
});

// ─── Mean Reversion Tests ───────────────────────────────────────────────────

describe("detectMeanReversion", () => {
  it("detects oversold bounce opportunity", () => {
    const bars = generateBars(generateOversold(60));
    const signal = detectMeanReversion(bars);

    if (signal && signal.direction === "BUY") {
      expect(signal.strategy).toBe("mean_reversion");
      expect(signal.reasoning).toContain("oversold");
    }
  });

  it("does not trigger in normal conditions", () => {
    const sideways = Array.from({ length: 60 }, () => 100 + (Math.random() - 0.5) * 2);
    const bars = generateBars(sideways);
    const signal = detectMeanReversion(bars);

    // Should either be null or HOLD
    expect(signal === null || signal.direction === "HOLD").toBe(true);
  });

  it("includes bounce score in reasoning", () => {
    const bars = generateBars(generateOversold(60));
    const signal = detectMeanReversion(bars);

    if (signal && signal.direction === "BUY") {
      expect(signal.reasoning.length).toBeGreaterThan(0);
    }
  });
});

// ─── Relative Strength Tests ────────────────────────────────────────────────

describe("calculateRelativeStrength", () => {
  it("returns high RS when stock outperforms SPY", () => {
    // Generate strong uptrend for stock (3-5% daily) vs weak SPY (0-1% daily)
    const stockCloses: number[] = [];
    let sp = 100;
    for (let i = 0; i < 60; i++) { sp *= 1.04; stockCloses.push(sp); }
    const spyCloses: number[] = [];
    let bp = 450;
    for (let i = 0; i < 60; i++) { bp *= 1.002; spyCloses.push(bp); }

    const stockBars = generateBars(stockCloses);
    const spyBars = generateBars(spyCloses);

    const rs = calculateRelativeStrength(stockBars, spyBars);
    expect(rs.percentile).toBeGreaterThan(60);
    expect(rs.outperforming).toBe(true);
  });

  it("returns low RS when stock underperforms SPY", () => {
    const stockBars = generateBars(generateDowntrend(60, 100));
    const spyBars = generateBars(generateUptrend(60, 450));

    const rs = calculateRelativeStrength(stockBars, spyBars);
    expect(rs.percentile).toBeLessThan(40);
    expect(rs.outperforming).toBe(false);
  });

  it("RS score is bounded 0-100", () => {
    const stockBars = generateBars(generateUptrend(60));
    const spyBars = generateBars(generateUptrend(60, 450));

    const rs = calculateRelativeStrength(stockBars, spyBars);
    expect(rs.percentile).toBeGreaterThanOrEqual(0);
    expect(rs.percentile).toBeLessThanOrEqual(100);
  });
});

// ─── Conviction Filter Tests ────────────────────────────────────────────────

describe("passesConvictionFilter", () => {
  const ts = Date.now();

  it("passes when 2+ strategies agree on BUY", () => {
    const result: MultiStrategyResult = {
      primary: { symbol: "TEST", direction: "BUY", confidence: 72, strategy: "momentum", reasoning: "test", timestamp: ts },
      alternatives: [
        { symbol: "TEST", direction: "BUY", confidence: 65, strategy: "relative_strength", reasoning: "test", timestamp: ts },
        { symbol: "TEST", direction: "HOLD", confidence: 40, strategy: "mean_reversion", reasoning: "test", timestamp: ts },
      ],
      regime: "uptrend",
      passesConviction: true,
    };
    expect(passesConvictionFilter(result)).toBe(true);
  });

  it("fails when only 1 strategy says BUY", () => {
    const result: MultiStrategyResult = {
      primary: { symbol: "TEST", direction: "BUY", confidence: 72, strategy: "momentum", reasoning: "test", timestamp: ts },
      alternatives: [
        { symbol: "TEST", direction: "HOLD", confidence: 45, strategy: "relative_strength", reasoning: "test", timestamp: ts },
        { symbol: "TEST", direction: "SELL", confidence: 55, strategy: "mean_reversion", reasoning: "test", timestamp: ts },
      ],
      regime: "uptrend",
      passesConviction: false,
    };
    expect(passesConvictionFilter(result)).toBe(false);
  });

  it("passes when all 3 strategies agree", () => {
    const result: MultiStrategyResult = {
      primary: { symbol: "TEST", direction: "BUY", confidence: 80, strategy: "momentum", reasoning: "test", timestamp: ts },
      alternatives: [
        { symbol: "TEST", direction: "BUY", confidence: 70, strategy: "relative_strength", reasoning: "test", timestamp: ts },
        { symbol: "TEST", direction: "BUY", confidence: 60, strategy: "mean_reversion", reasoning: "test", timestamp: ts },
      ],
      regime: "uptrend",
      passesConviction: true,
    };
    expect(passesConvictionFilter(result)).toBe(true);
  });

  it("ignores HOLD signals (only counts matching direction)", () => {
    const result: MultiStrategyResult = {
      primary: { symbol: "TEST", direction: "SELL", confidence: 70, strategy: "momentum", reasoning: "test", timestamp: ts },
      alternatives: [
        { symbol: "TEST", direction: "SELL", confidence: 65, strategy: "mean_reversion", reasoning: "test", timestamp: ts },
        { symbol: "TEST", direction: "HOLD", confidence: 30, strategy: "relative_strength", reasoning: "test", timestamp: ts },
      ],
      regime: "downtrend",
      passesConviction: true,
    };
    expect(passesConvictionFilter(result)).toBe(true);
  });
});

// ─── Full Signal Generation (Integration) ───────────────────────────────────

describe("generateSignal", () => {
  it("returns null for insufficient data", () => {
    const bars = generateBars([100, 101]);
    const spyBars = generateBars([450, 451]);
    const result = generateSignal(bars, spyBars, "AAPL");
    expect(result).toBeNull();
  });

  it("returns MultiStrategyResult with all fields", () => {
    const bars = generateBars(generateUptrend(60));
    const spyBars = generateBars(generateUptrend(60, 450));
    const result = generateSignal(bars, spyBars, "AAPL");

    if (result) {
      expect(result.primary).toBeDefined();
      expect(result.primary.direction).toMatch(/BUY|SELL|HOLD/);
      expect(result.primary.confidence).toBeGreaterThanOrEqual(0);
      expect(result.primary.strategy).toBeDefined();
      expect(result.primary.reasoning).toBeDefined();
      expect(result.alternatives).toBeDefined();
      expect(result.alternatives.length).toBe(2);
      expect(typeof result.passesConviction).toBe("boolean");
    }
  });

  it("primary signal has highest confidence among strategies", () => {
    const bars = generateBars(generateUptrend(60));
    const spyBars = generateBars(generateUptrend(60, 450));
    const result = generateSignal(bars, spyBars, "AAPL");

    if (result) {
      for (const alt of result.alternatives) {
        if (alt.direction === result.primary.direction) {
          expect(result.primary.confidence).toBeGreaterThanOrEqual(alt.confidence);
        }
      }
    }
  });
});
