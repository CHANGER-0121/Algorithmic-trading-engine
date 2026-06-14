/**
 * Risk Management & Position Sizing Engine.
 * 
 * Implements:
 * - Volatility-based position sizing (ATR-scaled)
 * - Correlation-aware exposure limits
 * - Dynamic overnight exposure based on market regime
 * - Circuit breaker for daily loss limits
 * - Strategy diversity enforcement
 */

import type {
  Position,
  PositionSizeResult,
  RiskLimits,
  TradingConfig,
  Indicators,
  StrategyType,
  MarketRegime,
  DEFAULT_CONFIG,
} from "./types";
import { getRegimeParameters } from "./regimeDetector";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositions: 5,
  maxDailyEntries: 3,
  maxCorrelatedExposure: 0.4,  // Max 40% in correlated assets
  maxOvernightExposure: 0.70,  // Default; overridden by regime
  maxSameStrategy: 3,          // Max 3 positions from same strategy
  circuitBreakerThreshold: -0.02, // -2% daily P&L halts new buys
};

// Correlation groups — assets that tend to move together
const CORRELATION_GROUPS: Record<string, string[]> = {
  mega_tech: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA"],
  semiconductors: ["NVDA", "AMD", "INTC", "AVGO", "QCOM", "ARM", "SOXL"],
  leveraged_tech: ["TQQQ", "SOXL", "QQQ"],
  crypto_related: ["MARA", "COIN", "RIOT", "BITO"],
  energy: ["XLE", "XOM", "CVX", "COP"],
  financials: ["XLF", "JPM", "BAC", "GS"],
};

// ─── Volatility-Based Position Sizing ───────────────────────────────────────

/**
 * Calculates position size based on ATR (Average True Range).
 * 
 * The core formula:
 *   risk_per_share = ATR * stop_multiplier
 *   dollar_risk = equity * risk_per_trade
 *   shares = dollar_risk / risk_per_share
 * 
 * This ensures each position risks approximately the same dollar amount
 * regardless of the stock's price or volatility.
 * 
 * @param equity - Total account equity
 * @param price - Current stock price
 * @param atr - Average True Range (14-period)
 * @param confidence - Signal confidence (0-100)
 * @param config - Trading configuration
 * @returns Position size details
 */
export function volatilityPositionSize(
  equity: number,
  price: number,
  atr: number,
  confidence: number,
  config: { riskPerTrade: number; maxPositionPct: number; trailingStopAtr: number }
): PositionSizeResult {
  // Validate inputs
  if (equity <= 0 || price <= 0 || atr <= 0) {
    return { shares: 0, dollarAmount: 0, riskPerShare: 0, riskPercent: 0, confidenceScale: 0 };
  }

  // Risk per share = ATR * stop multiplier
  const riskPerShare = atr * config.trailingStopAtr;

  // Scale position size by confidence (higher confidence = larger position)
  // Confidence 60 = 0.8x, 70 = 1.0x, 80 = 1.2x, 90 = 1.4x
  const confidenceScale = 0.4 + (confidence / 100) * 1.0;

  // Dollar risk = equity * risk_per_trade * confidence_scale
  const dollarRisk = equity * config.riskPerTrade * confidenceScale;

  // Calculate shares from risk budget
  let shares = Math.floor(dollarRisk / riskPerShare);

  // Cap at max position size (% of equity)
  const maxDollar = equity * config.maxPositionPct;
  const maxShares = Math.floor(maxDollar / price);
  shares = Math.min(shares, maxShares);

  // Minimum 1 share
  shares = Math.max(1, shares);

  const dollarAmount = shares * price;
  const riskPercent = (shares * riskPerShare) / equity;

  return {
    shares,
    dollarAmount,
    riskPerShare,
    riskPercent,
    confidenceScale: Math.round(confidenceScale * 100) / 100,
  };
}

// ─── Correlation Scoring ────────────────────────────────────────────────────

/**
 * Returns the correlation group(s) a symbol belongs to.
 */
export function getCorrelationGroups(symbol: string): string[] {
  const groups: string[] = [];
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.includes(symbol)) {
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Calculates how much correlated exposure already exists in the portfolio.
 * Returns a multiplier (0.4 to 1.0) to reduce position size.
 * 
 * Progressive reduction:
 * - 1 correlated position: 80% size
 * - 2 correlated positions: 60% size
 * - 3+ correlated positions: 40% size (minimum)
 */
export function correlationSizeMultiplier(
  candidateSymbol: string,
  existingPositions: Position[]
): number {
  const candidateGroups = getCorrelationGroups(candidateSymbol);
  if (candidateGroups.length === 0) return 1.0; // No known correlations

  let maxCorrelated = 0;

  for (const group of candidateGroups) {
    const members = CORRELATION_GROUPS[group];
    const correlated = existingPositions.filter(p => members.includes(p.symbol)).length;
    maxCorrelated = Math.max(maxCorrelated, correlated);
  }

  // Progressive reduction
  if (maxCorrelated >= 3) return 0.4;
  if (maxCorrelated === 2) return 0.6;
  if (maxCorrelated === 1) return 0.8;
  return 1.0;
}

// ─── Strategy Diversity ─────────────────────────────────────────────────────

/**
 * Checks if adding a position with the given strategy would violate
 * the strategy diversity limit (max 3 from same strategy).
 */
export function checkStrategyDiversity(
  candidateStrategy: StrategyType,
  existingPositions: Position[],
  maxSameStrategy: number = DEFAULT_RISK_LIMITS.maxSameStrategy
): { allowed: boolean; currentCount: number } {
  const sameStrategyCount = existingPositions.filter(
    p => p.strategy === candidateStrategy
  ).length;

  return {
    allowed: sameStrategyCount < maxSameStrategy,
    currentCount: sameStrategyCount,
  };
}

// ─── Dynamic Overnight Exposure ─────────────────────────────────────────────

/**
 * Calculates the maximum overnight exposure based on market regime.
 * In strong uptrends, we hold more overnight (85%).
 * In downtrends, we reduce to 50% or less.
 */
export function getDynamicOvernightLimit(regime: MarketRegime): number {
  const params = getRegimeParameters(regime);
  return params.overnightExposure;
}

/**
 * Determines which positions to trim to meet overnight exposure limit.
 * Prioritizes trimming:
 * 1. Positions with lowest unrealized P&L
 * 2. Positions in the weakest strategy
 * 3. Most recently opened positions
 */
export function calculateOvernightTrim(
  positions: (Position & { unrealizedPnl: number; currentPrice: number })[],
  equity: number,
  maxExposure: number
): { symbol: string; sharesToSell: number }[] {
  const totalExposure = positions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice,
    0
  );
  const exposurePct = totalExposure / equity;

  if (exposurePct <= maxExposure) return []; // No trim needed

  const excessDollars = totalExposure - equity * maxExposure;

  // Sort by unrealized P&L (trim losers first)
  const sorted = [...positions].sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);

  const trims: { symbol: string; sharesToSell: number }[] = [];
  let remaining = excessDollars;

  for (const pos of sorted) {
    if (remaining <= 0) break;

    const posValue = pos.quantity * pos.currentPrice;
    const sharesToSell = Math.min(
      pos.quantity,
      Math.ceil(remaining / pos.currentPrice)
    );

    trims.push({ symbol: pos.symbol, sharesToSell });
    remaining -= sharesToSell * pos.currentPrice;
  }

  return trims;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

/**
 * Checks if the daily loss circuit breaker should be triggered.
 * Halts all new buys if daily P&L drops below threshold.
 */
export function shouldHaltTrading(
  currentEquity: number,
  dayStartEquity: number,
  threshold: number = DEFAULT_RISK_LIMITS.circuitBreakerThreshold
): { halt: boolean; dailyPnlPct: number; reason: string } {
  if (dayStartEquity <= 0) {
    return { halt: false, dailyPnlPct: 0, reason: "No start equity recorded" };
  }

  const dailyPnl = currentEquity - dayStartEquity;
  const dailyPnlPct = dailyPnl / dayStartEquity;

  if (dailyPnlPct <= threshold) {
    return {
      halt: true,
      dailyPnlPct: Math.round(dailyPnlPct * 10000) / 100,
      reason: `Daily P&L ${(dailyPnlPct * 100).toFixed(2)}% breached ${(threshold * 100).toFixed(1)}% threshold`,
    };
  }

  return {
    halt: false,
    dailyPnlPct: Math.round(dailyPnlPct * 10000) / 100,
    reason: "Within daily loss limits",
  };
}

// ─── Pre-Trade Risk Check ───────────────────────────────────────────────────

interface PreTradeCheck {
  approved: boolean;
  reasons: string[];
  adjustedSize?: number;
}

/**
 * Comprehensive pre-trade risk check.
 * Validates all risk limits before allowing a new position.
 */
export function preTradeRiskCheck(
  candidateSymbol: string,
  candidateStrategy: StrategyType,
  proposedShares: number,
  existingPositions: Position[],
  dailyEntryCount: number,
  regime: MarketRegime,
  limits: RiskLimits = DEFAULT_RISK_LIMITS
): PreTradeCheck {
  const reasons: string[] = [];
  let adjustedSize = proposedShares;

  // Check max positions
  if (existingPositions.length >= limits.maxPositions) {
    return { approved: false, reasons: ["Max positions reached"] };
  }

  // Check daily entry limit
  if (dailyEntryCount >= limits.maxDailyEntries) {
    return { approved: false, reasons: ["Daily entry limit reached"] };
  }

  // Check strategy diversity
  const diversity = checkStrategyDiversity(candidateStrategy, existingPositions, limits.maxSameStrategy);
  if (!diversity.allowed) {
    return {
      approved: false,
      reasons: [`Max ${limits.maxSameStrategy} positions from ${candidateStrategy} strategy (current: ${diversity.currentCount})`],
    };
  }

  // Apply correlation reduction
  const corrMultiplier = correlationSizeMultiplier(candidateSymbol, existingPositions);
  if (corrMultiplier < 1.0) {
    adjustedSize = Math.max(1, Math.floor(proposedShares * corrMultiplier));
    reasons.push(`Correlation reduction: ${(corrMultiplier * 100).toFixed(0)}% size (${adjustedSize} shares)`);
  }

  // Regime-based adjustment
  const regimeParams = getRegimeParameters(regime);
  if (regimeParams.positionSizeMultiplier < 1.0) {
    adjustedSize = Math.max(1, Math.floor(adjustedSize * regimeParams.positionSizeMultiplier));
    reasons.push(`Regime (${regime}) size adjustment: ${(regimeParams.positionSizeMultiplier * 100).toFixed(0)}%`);
  }

  return {
    approved: true,
    reasons: reasons.length > 0 ? reasons : ["All risk checks passed"],
    adjustedSize,
  };
}
