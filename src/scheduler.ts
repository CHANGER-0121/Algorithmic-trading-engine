/**
 * Scan Scheduler & Position Lifecycle Manager.
 * 
 * Orchestrates the full trading pipeline:
 * 1. Market regime detection
 * 2. Multi-strategy signal generation across universe
 * 3. Conviction filtering & candidate ranking
 * 4. Pre-trade risk checks
 * 5. Position sizing & order execution
 * 6. Position management (trailing stops, partial profits, pyramiding)
 * 7. End-of-day exposure management
 * 
 * Scan Schedule (ET):
 * - 08:30 — Pre-market gap-up scanner
 * - 09:45 — Opening momentum scan
 * - 10:30, 11:15, 12:00, 12:45, 1:30, 2:15 — Intraday scans
 * - 3:15 — Late-day momentum scan
 * - 3:50 — EOD position management & overnight trim
 */

import type {
  OHLCVBar,
  Signal,
  MultiStrategyResult,
  Position,
  MarketRegime,
  TradingConfig,
  DEFAULT_CONFIG,
} from "./types";
import { generateSignal } from "./tradingEngine";
import { detectRegime, getRegimeParameters } from "./regimeDetector";
import {
  volatilityPositionSize,
  preTradeRiskCheck,
  correlationSizeMultiplier,
  shouldHaltTrading,
  calculateOvernightTrim,
  getDynamicOvernightLimit,
} from "./riskManager";

// ─── Configuration ──────────────────────────────────────────────────────────

const SCAN_TIMES_ET = [
  "08:30", "09:45", "10:30", "11:15",
  "12:00", "12:45", "13:30", "14:15",
  "15:15", "15:50",
];

const MAX_ENTRIES_PER_SCAN = 2;
const PYRAMID_MIN_PROFIT_PCT = 3.0;
const PYRAMID_MAX_ADDS = 2;
const PYRAMID_SIZE_PCT = 0.25;

// Stock universe — diversified across sectors
const UNIVERSE = [
  // Tech
  "AAPL", "MSFT", "NVDA", "AMD", "GOOGL", "META", "AMZN",
  // Semiconductors
  "AVGO", "QCOM", "INTC", "ARM",
  // Growth
  "TSLA", "NFLX", "CRM", "CRWD",
  // Leveraged ETFs
  "TQQQ", "SOXL",
  // Crypto-adjacent
  "MARA", "COIN",
  // Energy
  "XLE", "XOM",
  // Financials
  "JPM", "GS",
  // Defense
  "LMT", "RTX",
];

// ─── Scheduler State ────────────────────────────────────────────────────────

interface SchedulerState {
  isRunning: boolean;
  positions: Position[];
  dailyEntryCount: number;
  scansToday: number;
  lastScanTime: number | null;
  currentRegime: MarketRegime;
  dayStartEquity: number;
  haltNewBuys: boolean;
  gapUpSymbols: Set<string>;
  recentProfitTakes: Map<string, { time: number; exitPrice: number }>;
}

function createInitialState(): SchedulerState {
  return {
    isRunning: false,
    positions: [],
    dailyEntryCount: 0,
    scansToday: 0,
    lastScanTime: null,
    currentRegime: "sideways",
    dayStartEquity: 0,
    haltNewBuys: false,
    gapUpSymbols: new Set(),
    recentProfitTakes: new Map(),
  };
}

// ─── Core Scan Pipeline ─────────────────────────────────────────────────────

interface ScanResult {
  timestamp: number;
  regime: MarketRegime;
  candidates: RankedCandidate[];
  executed: ExecutedTrade[];
  skipped: { symbol: string; reason: string }[];
}

interface RankedCandidate {
  symbol: string;
  signal: Signal;
  adjustedConfidence: number;
  passesConviction: boolean;
}

interface ExecutedTrade {
  symbol: string;
  direction: "BUY" | "SELL";
  shares: number;
  price: number;
  strategy: string;
  confidence: number;
  reasoning: string;
}

/**
 * Runs the full scan pipeline for the current scan window.
 * 
 * Pipeline stages:
 * 1. Check circuit breaker
 * 2. Detect market regime
 * 3. Manage existing positions (trailing stops, partial profits, pyramiding)
 * 4. Generate signals for universe
 * 5. Filter by conviction
 * 6. Apply pullback timing, gap-up boost, sector rotation
 * 7. Rank candidates by adjusted confidence
 * 8. Execute top candidates (max 2 per scan)
 */
async function runScan(
  state: SchedulerState,
  equity: number,
  fetchBars: (symbol: string) => Promise<OHLCVBar[]>,
  config: TradingConfig
): Promise<ScanResult> {
  const result: ScanResult = {
    timestamp: Date.now(),
    regime: state.currentRegime,
    candidates: [],
    executed: [],
    skipped: [],
  };

  // ── Stage 1: Circuit Breaker ──────────────────────────────────────────
  const circuitCheck = shouldHaltTrading(equity, state.dayStartEquity);
  if (circuitCheck.halt) {
    state.haltNewBuys = true;
    console.log(`[CIRCUIT BREAKER] ${circuitCheck.reason}`);
    return result;
  }

  // ── Stage 2: Market Regime Detection ──────────────────────────────────
  const spyBars = await fetchBars("SPY");
  const regimeAnalysis = detectRegime(spyBars);
  state.currentRegime = regimeAnalysis.regime;
  result.regime = regimeAnalysis.regime;

  const regimeParams = getRegimeParameters(regimeAnalysis.regime);

  // ── Stage 3: Position Management ──────────────────────────────────────
  for (const position of state.positions) {
    const bars = await fetchBars(position.symbol);
    if (bars.length === 0) continue;

    const currentPrice = bars[bars.length - 1].close;
    const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // Check trailing stop
    const stopDistance = position.stopLoss;
    if (currentPrice <= stopDistance) {
      result.executed.push({
        symbol: position.symbol,
        direction: "SELL",
        shares: position.quantity,
        price: currentPrice,
        strategy: position.strategy,
        confidence: 100,
        reasoning: `Stop loss hit at ${currentPrice.toFixed(2)} (P&L: ${pnlPct.toFixed(1)}%)`,
      });
      continue;
    }

    // Check partial profit (50% of position at intermediate target)
    if (pnlPct >= config.pyramidMinProfit && position.quantity > 1) {
      // Exit quality: delay partial profit in strong uptrends
      if (regimeAnalysis.regime === "strong_uptrend" && pnlPct < config.pyramidMinProfit * 1.5) {
        console.log(`[EXIT QUALITY] Delaying partial profit for ${position.symbol} — strong uptrend`);
      } else {
        const sellQty = Math.floor(position.quantity * config.partialProfitPct);
        result.executed.push({
          symbol: position.symbol,
          direction: "SELL",
          shares: sellQty,
          price: currentPrice,
          strategy: position.strategy,
          confidence: 85,
          reasoning: `Partial profit: ${pnlPct.toFixed(1)}% gain, selling ${sellQty} shares`,
        });
      }
    }

    // Check pyramiding opportunity
    if (
      pnlPct >= PYRAMID_MIN_PROFIT_PCT &&
      position.pyramidCount < PYRAMID_MAX_ADDS
    ) {
      const signal = generateSignal(bars, spyBars, position.symbol);
      if (signal && signal.primary.direction === "BUY" && signal.primary.confidence >= 60) {
        const pyramidShares = Math.floor(position.quantity * PYRAMID_SIZE_PCT);
        result.executed.push({
          symbol: position.symbol,
          direction: "BUY",
          shares: pyramidShares,
          price: currentPrice,
          strategy: position.strategy,
          confidence: signal.primary.confidence,
          reasoning: `Pyramid add #${position.pyramidCount + 1}: +${pnlPct.toFixed(1)}% with confirmed momentum`,
        });
      }
    }
  }

  // ── Stage 4: Signal Generation ────────────────────────────────────────
  if (state.haltNewBuys) {
    result.skipped.push({ symbol: "*", reason: "Circuit breaker active" });
    return result;
  }

  const candidates: RankedCandidate[] = [];

  for (const symbol of UNIVERSE) {
    // Skip if already holding
    if (state.positions.some(p => p.symbol === symbol)) continue;

    const bars = await fetchBars(symbol);
    if (bars.length < 50) continue;

    const signal = generateSignal(bars, spyBars, symbol);
    if (!signal || signal.primary.direction !== "BUY") continue;

    let adjustedConfidence = signal.primary.confidence;

    // ── Stage 5: Conviction Filter ──────────────────────────────────────
    if (!signal.passesConviction) {
      result.skipped.push({ symbol, reason: "Failed conviction filter (< 2 strategies agree)" });
      continue;
    }

    // ── Stage 6: Confidence Adjustments ─────────────────────────────────

    // Gap-up boost
    if (state.gapUpSymbols.has(symbol)) {
      adjustedConfidence += 6;
    }

    // Pullback entry timing (near EMA support = better entry)
    const currentPrice = bars[bars.length - 1].close;
    const ema21 = bars.slice(-21).reduce((s, b) => s + b.close, 0) / 21;
    const distFromEMA = ((currentPrice - ema21) / ema21) * 100;

    if (distFromEMA <= 1.5 && distFromEMA >= -0.5) {
      adjustedConfidence += 4; // Near EMA support — ideal entry
    } else if (distFromEMA > 5) {
      adjustedConfidence -= 3; // Extended from EMA — chasing
    }

    // Regime bonus/penalty
    adjustedConfidence += regimeParams.confidenceBonus;

    // Re-entry bonus (previously profitable symbol pulling back)
    const reentry = state.recentProfitTakes.get(symbol);
    if (reentry) {
      const timeSinceExit = Date.now() - reentry.time;
      const pullbackPct = (reentry.exitPrice - currentPrice) / reentry.exitPrice;
      if (timeSinceExit > 2 * 60 * 60 * 1000 && pullbackPct >= 0.02) {
        adjustedConfidence += 3;
      }
    }

    // Threshold check
    if (adjustedConfidence < config.confidenceThreshold) {
      result.skipped.push({
        symbol,
        reason: `Confidence ${adjustedConfidence} below threshold ${config.confidenceThreshold}`,
      });
      continue;
    }

    candidates.push({
      symbol,
      signal: signal.primary,
      adjustedConfidence,
      passesConviction: true,
    });
  }

  // ── Stage 7: Rank & Select ────────────────────────────────────────────
  candidates.sort((a, b) => b.adjustedConfidence - a.adjustedConfidence);
  const topCandidates = candidates.slice(0, MAX_ENTRIES_PER_SCAN);

  result.candidates = candidates;

  // ── Stage 8: Execute ──────────────────────────────────────────────────
  for (const candidate of topCandidates) {
    // Pre-trade risk check
    const riskCheck = preTradeRiskCheck(
      candidate.symbol,
      candidate.signal.strategy,
      100, // Placeholder — actual shares calculated below
      state.positions,
      state.dailyEntryCount,
      state.currentRegime
    );

    if (!riskCheck.approved) {
      result.skipped.push({ symbol: candidate.symbol, reason: riskCheck.reasons.join("; ") });
      continue;
    }

    // Position sizing
    const bars = await fetchBars(candidate.symbol);
    const atr = bars.length > 14
      ? bars.slice(-15).reduce((max, b, i, arr) => {
          if (i === 0) return 0;
          return Math.max(max, b.high - b.low, Math.abs(b.high - arr[i-1].close), Math.abs(b.low - arr[i-1].close));
        }, 0)
      : bars[bars.length - 1].close * 0.02;

    const sizing = volatilityPositionSize(
      equity,
      bars[bars.length - 1].close,
      atr,
      candidate.adjustedConfidence,
      config
    );

    // Apply correlation reduction
    const corrMultiplier = correlationSizeMultiplier(candidate.symbol, state.positions);
    const finalShares = Math.max(1, Math.floor(sizing.shares * corrMultiplier));

    result.executed.push({
      symbol: candidate.symbol,
      direction: "BUY",
      shares: finalShares,
      price: bars[bars.length - 1].close,
      strategy: candidate.signal.strategy,
      confidence: candidate.adjustedConfidence,
      reasoning: candidate.signal.reasoning,
    });

    state.dailyEntryCount++;
  }

  state.scansToday++;
  state.lastScanTime = Date.now();

  return result;
}

// ─── Gap-Up Scanner (Pre-Market) ────────────────────────────────────────────

/**
 * Detects stocks gapping up 3-8% in pre-market.
 * Called at 8:30 AM ET before market open.
 */
async function scanGapUps(
  fetchQuote: (symbol: string) => Promise<{ price: number; prevClose: number } | null>,
  state: SchedulerState
): Promise<string[]> {
  const gapUps: string[] = [];
  state.gapUpSymbols.clear();

  for (const symbol of UNIVERSE) {
    const quote = await fetchQuote(symbol);
    if (!quote || quote.prevClose === 0) continue;

    const gapPct = ((quote.price - quote.prevClose) / quote.prevClose) * 100;

    if (gapPct >= 3.0 && gapPct <= 8.0) {
      gapUps.push(symbol);
      state.gapUpSymbols.add(symbol);
      console.log(`[GAP-UP] ${symbol}: +${gapPct.toFixed(1)}%`);
    }
  }

  return gapUps;
}

// ─── EOD Overnight Trim ─────────────────────────────────────────────────────

/**
 * Reduces overnight exposure based on market regime.
 * Called at 3:50 PM ET before market close.
 */
function planOvernightTrim(
  state: SchedulerState,
  equity: number,
  currentPrices: Map<string, number>
): { symbol: string; sharesToSell: number }[] {
  const maxExposure = getDynamicOvernightLimit(state.currentRegime);

  const positionsWithPnl = state.positions.map(p => ({
    ...p,
    currentPrice: currentPrices.get(p.symbol) ?? p.entryPrice,
    unrealizedPnl: ((currentPrices.get(p.symbol) ?? p.entryPrice) - p.entryPrice) * p.quantity,
  }));

  return calculateOvernightTrim(positionsWithPnl, equity, maxExposure);
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  runScan,
  scanGapUps,
  planOvernightTrim,
  createInitialState,
  SCAN_TIMES_ET,
  UNIVERSE,
  MAX_ENTRIES_PER_SCAN,
};

export type { SchedulerState, ScanResult, RankedCandidate, ExecutedTrade };
