/**
 * Unit tests for Risk Management & Position Sizing.
 * Tests position sizing accuracy, correlation scoring, and circuit breaker logic.
 */

import { describe, it, expect } from "vitest";
import {
  volatilityPositionSize,
  correlationSizeMultiplier,
  checkStrategyDiversity,
  getDynamicOvernightLimit,
  calculateOvernightTrim,
  shouldHaltTrading,
  preTradeRiskCheck,
  getCorrelationGroups,
} from "../src/riskManager";
import type { Position } from "../src/types";

// ─── Helper: Create test position ──────────────────────────────────────────

function createPosition(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "AAPL",
    entryPrice: 150,
    quantity: 10,
    side: "long",
    entryTime: Date.now(),
    strategy: "momentum",
    stopLoss: 145,
    takeProfit: 165,
    pyramidCount: 0,
    ...overrides,
  };
}

// ─── Volatility Position Sizing ─────────────────────────────────────────────

describe("volatilityPositionSize", () => {
  const config = { riskPerTrade: 0.02, maxPositionPct: 0.25, trailingStopAtr: 2.5 };

  it("returns 0 shares for invalid inputs", () => {
    expect(volatilityPositionSize(0, 100, 5, 70, config).shares).toBe(0);
    expect(volatilityPositionSize(100000, 0, 5, 70, config).shares).toBe(0);
    expect(volatilityPositionSize(100000, 100, 0, 70, config).shares).toBe(0);
  });

  it("higher ATR = fewer shares (more volatile = smaller position)", () => {
    const lowVol = volatilityPositionSize(100000, 100, 2, 70, config);
    const highVol = volatilityPositionSize(100000, 100, 8, 70, config);
    expect(lowVol.shares).toBeGreaterThan(highVol.shares);
  });

  it("higher confidence = more shares", () => {
    const lowConf = volatilityPositionSize(100000, 100, 5, 50, config);
    const highConf = volatilityPositionSize(100000, 100, 5, 90, config);
    expect(highConf.shares).toBeGreaterThan(lowConf.shares);
  });

  it("respects max position size cap", () => {
    // Very low ATR would normally give huge position
    const result = volatilityPositionSize(100000, 10, 0.01, 95, config);
    const maxDollar = 100000 * config.maxPositionPct;
    expect(result.dollarAmount).toBeLessThanOrEqual(maxDollar);
  });

  it("always returns at least 1 share", () => {
    // Very high price, low equity
    const result = volatilityPositionSize(1000, 500, 50, 50, config);
    expect(result.shares).toBeGreaterThanOrEqual(1);
  });

  it("confidence scale is proportional to confidence", () => {
    const r1 = volatilityPositionSize(100000, 100, 5, 60, config);
    const r2 = volatilityPositionSize(100000, 100, 5, 80, config);
    expect(r2.confidenceScale).toBeGreaterThan(r1.confidenceScale);
  });

  it("risk percent stays within reasonable bounds", () => {
    const result = volatilityPositionSize(100000, 150, 5, 70, config);
    expect(result.riskPercent).toBeGreaterThan(0);
    expect(result.riskPercent).toBeLessThan(0.10); // Never risk more than 10%
  });
});

// ─── Correlation Scoring ────────────────────────────────────────────────────

describe("correlationSizeMultiplier", () => {
  it("returns 1.0 for uncorrelated symbol", () => {
    const positions = [createPosition({ symbol: "XLE" })];
    expect(correlationSizeMultiplier("JPM", positions)).toBe(1.0);
  });

  it("returns 0.8 for 1 correlated position", () => {
    const positions = [createPosition({ symbol: "NVDA" })];
    expect(correlationSizeMultiplier("AMD", positions)).toBe(0.8);
  });

  it("returns 0.6 for 2 correlated positions", () => {
    const positions = [
      createPosition({ symbol: "NVDA" }),
      createPosition({ symbol: "INTC" }),
    ];
    expect(correlationSizeMultiplier("AMD", positions)).toBe(0.6);
  });

  it("returns 0.4 for 3+ correlated positions", () => {
    const positions = [
      createPosition({ symbol: "NVDA" }),
      createPosition({ symbol: "INTC" }),
      createPosition({ symbol: "AVGO" }),
    ];
    expect(correlationSizeMultiplier("AMD", positions)).toBe(0.4);
  });

  it("returns 1.0 for symbol not in any group", () => {
    const positions = [createPosition({ symbol: "NVDA" })];
    expect(correlationSizeMultiplier("UNKNOWN_TICKER", positions)).toBe(1.0);
  });
});

describe("getCorrelationGroups", () => {
  it("returns correct groups for NVDA (in multiple groups)", () => {
    const groups = getCorrelationGroups("NVDA");
    expect(groups).toContain("mega_tech");
    expect(groups).toContain("semiconductors");
  });

  it("returns empty array for unknown symbol", () => {
    expect(getCorrelationGroups("UNKNOWN")).toEqual([]);
  });
});

// ─── Strategy Diversity ─────────────────────────────────────────────────────

describe("checkStrategyDiversity", () => {
  it("allows first position of any strategy", () => {
    const result = checkStrategyDiversity("momentum", []);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
  });

  it("allows up to maxSameStrategy positions", () => {
    const positions = [
      createPosition({ strategy: "momentum" }),
      createPosition({ strategy: "momentum" }),
    ];
    const result = checkStrategyDiversity("momentum", positions, 3);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(2);
  });

  it("blocks when maxSameStrategy reached", () => {
    const positions = [
      createPosition({ strategy: "momentum" }),
      createPosition({ strategy: "momentum" }),
      createPosition({ strategy: "momentum" }),
    ];
    const result = checkStrategyDiversity("momentum", positions, 3);
    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(3);
  });

  it("different strategies don't count against each other", () => {
    const positions = [
      createPosition({ strategy: "momentum" }),
      createPosition({ strategy: "momentum" }),
      createPosition({ strategy: "momentum" }),
    ];
    const result = checkStrategyDiversity("mean_reversion", positions, 3);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
  });
});

// ─── Dynamic Overnight Exposure ─────────────────────────────────────────────

describe("getDynamicOvernightLimit", () => {
  it("strong uptrend allows highest exposure (85%)", () => {
    expect(getDynamicOvernightLimit("strong_uptrend")).toBe(0.85);
  });

  it("downtrend restricts to 55%", () => {
    expect(getDynamicOvernightLimit("downtrend")).toBe(0.55);
  });

  it("strong downtrend restricts to 40%", () => {
    expect(getDynamicOvernightLimit("strong_downtrend")).toBe(0.40);
  });

  it("sideways allows moderate 70%", () => {
    expect(getDynamicOvernightLimit("sideways")).toBe(0.70);
  });
});

// ─── Overnight Trim ─────────────────────────────────────────────────────────

describe("calculateOvernightTrim", () => {
  it("returns empty when exposure is within limit", () => {
    const positions = [{
      ...createPosition({ quantity: 10 }),
      unrealizedPnl: 50,
      currentPrice: 150,
    }];
    // 10 * 150 = 1500, equity = 10000, exposure = 15% < 70%
    const trims = calculateOvernightTrim(positions, 10000, 0.70);
    expect(trims).toEqual([]);
  });

  it("trims losers first", () => {
    const positions = [
      { ...createPosition({ symbol: "AAPL", quantity: 50 }), unrealizedPnl: 200, currentPrice: 150 },
      { ...createPosition({ symbol: "NVDA", quantity: 50 }), unrealizedPnl: -100, currentPrice: 150 },
    ];
    // Total exposure: 100 * 150 = 15000, equity = 10000, 150% > 70%
    const trims = calculateOvernightTrim(positions, 10000, 0.70);
    // Should trim NVDA first (negative P&L)
    expect(trims[0].symbol).toBe("NVDA");
  });
});

// ─── Circuit Breaker ────────────────────────────────────────────────────────

describe("shouldHaltTrading", () => {
  it("does not halt when P&L is positive", () => {
    const result = shouldHaltTrading(102000, 100000);
    expect(result.halt).toBe(false);
    expect(result.dailyPnlPct).toBeGreaterThan(0);
  });

  it("does not halt for small losses", () => {
    const result = shouldHaltTrading(99500, 100000); // -0.5%
    expect(result.halt).toBe(false);
  });

  it("halts at -2% threshold", () => {
    const result = shouldHaltTrading(97900, 100000); // -2.1%
    expect(result.halt).toBe(true);
    expect(result.reason).toContain("breached");
  });

  it("handles zero start equity gracefully", () => {
    const result = shouldHaltTrading(100000, 0);
    expect(result.halt).toBe(false);
  });

  it("custom threshold works", () => {
    const result = shouldHaltTrading(99000, 100000, -0.005); // -1% vs -0.5% threshold
    expect(result.halt).toBe(true);
  });
});

// ─── Pre-Trade Risk Check (Integration) ─────────────────────────────────────

describe("preTradeRiskCheck", () => {
  it("approves valid trade with no existing positions", () => {
    const result = preTradeRiskCheck("AAPL", "momentum", 10, [], 0, "uptrend");
    expect(result.approved).toBe(true);
  });

  it("rejects when max positions reached", () => {
    const positions = Array.from({ length: 5 }, (_, i) =>
      createPosition({ symbol: `SYM${i}` })
    );
    const result = preTradeRiskCheck("NEW", "momentum", 10, positions, 0, "uptrend");
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("Max positions reached");
  });

  it("rejects when daily entry limit reached", () => {
    const result = preTradeRiskCheck("AAPL", "momentum", 10, [], 3, "uptrend");
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("Daily entry limit reached");
  });

  it("rejects when strategy diversity violated", () => {
    const positions = [
      createPosition({ symbol: "A", strategy: "relative_strength" }),
      createPosition({ symbol: "B", strategy: "relative_strength" }),
      createPosition({ symbol: "C", strategy: "relative_strength" }),
    ];
    const result = preTradeRiskCheck("D", "relative_strength", 10, positions, 0, "uptrend");
    expect(result.approved).toBe(false);
  });

  it("reduces size for correlated positions", () => {
    const positions = [createPosition({ symbol: "NVDA" })];
    const result = preTradeRiskCheck("AMD", "momentum", 100, positions, 0, "uptrend");
    expect(result.approved).toBe(true);
    expect(result.adjustedSize).toBeLessThan(100); // Correlation reduction applied
  });

  it("reduces size in downtrend regime", () => {
    const result = preTradeRiskCheck("AAPL", "momentum", 100, [], 0, "downtrend");
    expect(result.approved).toBe(true);
    expect(result.adjustedSize).toBeLessThan(100);
  });
});
