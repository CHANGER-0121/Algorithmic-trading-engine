# AI-Generated Code Quality Analysis

**Author:** Ignasi Santacana  
**Date:** June 2026  
**Context:** Evaluation of AI-generated algorithmic trading code — identifying bugs, anti-patterns, and quality improvements

---

## Executive Summary

This document demonstrates systematic evaluation of AI-generated TypeScript code in a quantitative trading context. It covers bug identification, correctness verification, edge-case analysis, and quality scoring — the core competencies required for evaluating AI code output in production environments.

The analysis examines six modules totaling approximately 1,200 lines of TypeScript, identifying **14 potential issues** across severity levels, with concrete fixes and test cases for each.

---

## Methodology

The review follows a structured four-pass approach:

| Pass | Focus | Tools Used |
|------|-------|-----------|
| 1. Correctness | Logic errors, off-by-one, boundary conditions | Unit tests, property-based testing |
| 2. Robustness | Edge cases, NaN propagation, division by zero | Fuzz inputs, stress tests |
| 3. Type Safety | Implicit `any`, unsafe casts, missing null checks | TypeScript strict mode, ESLint |
| 4. Performance | Unnecessary allocations, O(n²) loops, memory leaks | Profiling, benchmark tests |

---

## Issue Catalog

### Critical Issues (Would Cause Financial Loss)

#### Issue #1: RSI Division by Zero in Pure Uptrend

**File:** `src/indicators.ts` — `calculateRSI()`  
**Severity:** Critical  
**Category:** Correctness

**Problem:** When all price changes are positive (pure uptrend), `avgLoss` equals zero. The original AI-generated code computed `RS = avgGain / avgLoss` without guarding against division by zero, producing `Infinity` which then propagated as `NaN` through downstream calculations.

**Original AI output:**
```typescript
const rs = avgGain / avgLoss;
result.push(100 - 100 / (1 + rs));
```

**Fixed version:**
```typescript
const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
result.push(100 - 100 / (1 + rs));
```

**Test case that catches this:**
```typescript
it("RSI approaches 100 in pure uptrend", () => {
  const data = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
  const rsi = calculateRSI(data, 14);
  const lastRSI = rsi[rsi.length - 1];
  expect(lastRSI).toBeGreaterThan(90);
  expect(Number.isFinite(lastRSI)).toBe(true); // Catches NaN/Infinity
});
```

**Impact:** In a pure uptrend, the trading engine would receive `NaN` for RSI, causing all downstream signal generation to fail silently. Positions would not be entered during the most profitable market conditions.

---

#### Issue #2: Position Sizing Returns Negative Shares

**File:** `src/riskManager.ts` — `volatilityPositionSize()`  
**Severity:** Critical  
**Category:** Boundary condition

**Problem:** When ATR is extremely large relative to equity (e.g., a penny stock with high volatility), the formula `dollarRisk / riskPerShare` can produce a value less than 1. Without a floor, `Math.floor()` returns 0, and subsequent calculations multiply by 0 shares.

**Original AI output:**
```typescript
let shares = Math.floor(dollarRisk / riskPerShare);
// ... cap at max
return { shares, dollarAmount: shares * price, ... };
```

**Fixed version:**
```typescript
let shares = Math.floor(dollarRisk / riskPerShare);
shares = Math.min(shares, maxShares);
shares = Math.max(1, shares); // Always at least 1 share
```

**Test case:**
```typescript
it("always returns at least 1 share", () => {
  const result = volatilityPositionSize(1000, 500, 50, 50, config);
  expect(result.shares).toBeGreaterThanOrEqual(1);
});
```

---

#### Issue #3: Circuit Breaker Bypass on Day-Start Equity = 0

**File:** `src/riskManager.ts` — `shouldHaltTrading()`  
**Severity:** Critical  
**Category:** Initialization error

**Problem:** If the scheduler starts before recording `dayStartEquity` (e.g., after a crash/restart mid-day), the value defaults to 0. The P&L calculation `(current - 0) / 0` produces `NaN`, which fails the `<=` comparison, so the circuit breaker never triggers regardless of actual losses.

**Fixed version:**
```typescript
if (dayStartEquity <= 0) {
  return { halt: false, dailyPnlPct: 0, reason: "No start equity recorded" };
}
```

**Impact:** After a mid-day restart, the system would continue trading without loss protection, potentially compounding losses in a crash scenario.

---

### High-Severity Issues (Incorrect Behavior)

#### Issue #4: EMA Calculation Off-By-One in Array Length

**File:** `src/indicators.ts` — `calculateEMA()`  
**Severity:** High  
**Category:** Off-by-one error

**Problem:** The AI initially generated code that returned `data.length - period` elements instead of `data.length - period + 1`. The first EMA value (seeded from SMA) was being excluded from the output array.

**Correct behavior:** For input of length N and period P, output should have `N - P + 1` elements (the SMA seed plus all subsequent EMA values).

**Test case:**
```typescript
it("produces correct number of output values", () => {
  const data = Array.from({ length: 50 }, (_, i) => i + 1);
  const result = calculateEMA(data, 10);
  expect(result.length).toBe(41); // 50 - 10 + 1
});
```

---

#### Issue #5: Correlation Groups Overlap Creates Double-Counting

**File:** `src/riskManager.ts` — `correlationSizeMultiplier()`  
**Severity:** High  
**Category:** Logic error

**Problem:** NVDA appears in both `mega_tech` and `semiconductors` groups. Without taking the maximum across groups (rather than summing), a portfolio with AAPL (mega_tech) and AMD (semiconductors) would incorrectly double-penalize NVDA.

**Fixed approach:** Use `Math.max(maxCorrelated, correlated)` across groups rather than accumulating.

```typescript
for (const group of candidateGroups) {
  const members = CORRELATION_GROUPS[group];
  const correlated = existingPositions.filter(p => members.includes(p.symbol)).length;
  maxCorrelated = Math.max(maxCorrelated, correlated); // Not +=
}
```

---

#### Issue #6: Mean Reversion Signal Missing "oversold" in Reasoning

**File:** `src/tradingEngine.ts` — `evaluateMeanReversion()`  
**Severity:** Medium  
**Category:** Contract violation

**Problem:** The AI generated reasoning strings like "Mean reversion BUY setup" without including the word "oversold", which downstream logging and the conviction filter documentation explicitly expected. This is a soft contract violation — the code works but violates documented behavior.

**Fixed:** Changed the BUY reasoning prefix to include the keyword:
```typescript
reasons.unshift("Mean reversion BUY setup — oversold bounce detected");
```

---

### Medium-Severity Issues (Suboptimal Behavior)

#### Issue #7: Bollinger Bands Use Population Variance Instead of Sample

**File:** `src/indicators.ts` — `calculateBollingerBands()`  
**Severity:** Medium  
**Category:** Statistical accuracy

**Problem:** The standard deviation calculation divides by `N` (population variance) rather than `N-1` (sample variance). For a 20-period window, this underestimates volatility by approximately 2.5%, causing slightly tighter bands than industry-standard implementations.

```typescript
// AI generated (population variance):
const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;

// Industry standard (sample variance):
const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / (period - 1);
```

**Decision:** Kept population variance for consistency with TradingView and most retail platforms, but documented the deviation from academic standard.

---

#### Issue #8: ADX Smoothing Uses Incorrect Wilder's Method

**File:** `src/indicators.ts` — `calculateADX()`  
**Severity:** Medium  
**Category:** Algorithm fidelity

**Problem:** The AI implemented a simplified smoothing (`sum - sum/p + newValue`) which approximates but does not exactly match Wilder's original smoothing formula (`prev * (p-1)/p + current`). The difference is small (< 0.5 ADX points) but accumulates over long periods.

**Impact:** Minor discrepancy vs professional charting platforms. Acceptable for signal generation but would fail exact-match validation against Bloomberg/Reuters data.

---

#### Issue #9: Overnight Trim Sells More Than Available Quantity

**File:** `src/riskManager.ts` — `calculateOvernightTrim()`  
**Severity:** Medium  
**Category:** Boundary condition

**Problem:** The `Math.ceil(remaining / pos.currentPrice)` calculation can exceed `pos.quantity` when the remaining amount is close to the full position value. Fixed with `Math.min(pos.quantity, ...)`.

---

### Low-Severity Issues (Code Quality)

#### Issue #10: Unused `bbPosition` Variable

**File:** `src/tradingEngine.ts` — `evaluateMeanReversion()`  
**Severity:** Low  
**Category:** Dead code

```typescript
const bbPosition = (price - bollingerBands.lower) / (bollingerBands.upper - bollingerBands.lower);
// Never used — the logic uses direct price comparisons instead
```

**Note:** This is a common AI code generation artifact — the model "plans" to use a variable but then implements the logic differently. It indicates the AI considered a percentile-based approach before choosing absolute comparisons.

---

#### Issue #11: Magic Numbers Without Named Constants

**File:** `src/tradingEngine.ts`  
**Severity:** Low  
**Category:** Maintainability

Multiple threshold values (40, -30, 25, 80, 0.08) appear as inline literals without explanation. While functional, this makes the code harder to tune and audit.

**Recommendation:** Extract to named constants:
```typescript
const MOMENTUM_BUY_THRESHOLD = 40;
const MOMENTUM_SELL_THRESHOLD = -30;
const ADX_STRONG_TREND = 25;
const RSI_OVERBOUGHT = 80;
const BB_HIGH_BANDWIDTH = 0.08;
```

---

#### Issue #12: Type Assertion Gap in Scheduler State

**File:** `src/scheduler.ts`  
**Severity:** Low  
**Category:** Type safety

The `recentProfitTakes` Map uses `string` keys but doesn't validate that keys match the `UNIVERSE` array. A typo in a symbol name would silently create an orphaned entry.

---

#### Issue #13: No Input Sanitization on Bar Data

**File:** `src/indicators.ts`  
**Severity:** Low  
**Category:** Defensive programming

None of the indicator functions validate that OHLCV bars have sensible values (e.g., `high >= low`, `close > 0`, `volume >= 0`). Corrupt API data would propagate silently.

---

#### Issue #14: Console.log in Production Code

**File:** `src/scheduler.ts`  
**Severity:** Low  
**Category:** Observability

Direct `console.log` calls should be replaced with a structured logger that supports log levels, timestamps, and JSON output for production monitoring.

---

## Quality Scoring Matrix

| Module | Correctness | Robustness | Type Safety | Performance | Overall |
|--------|:-----------:|:----------:|:-----------:|:-----------:|:-------:|
| indicators.ts | 8/10 | 7/10 | 9/10 | 9/10 | **8.3** |
| tradingEngine.ts | 8/10 | 7/10 | 8/10 | 8/10 | **7.8** |
| regimeDetector.ts | 9/10 | 8/10 | 9/10 | 9/10 | **8.8** |
| riskManager.ts | 7/10 | 8/10 | 9/10 | 9/10 | **8.3** |
| scheduler.ts | 7/10 | 6/10 | 8/10 | 7/10 | **7.0** |
| types.ts | 10/10 | 10/10 | 10/10 | 10/10 | **10.0** |

**Aggregate Score: 8.4 / 10** — Production-ready with the identified fixes applied.

---

## Testing Strategy Assessment

The test suite demonstrates several best practices:

**Strengths:**
- Property-based boundary testing (RSI always 0-100, ATR always positive)
- Edge case coverage (empty inputs, insufficient data, division by zero)
- Integration tests that verify module interactions (generateSignal → buildIndicators → detectRegime)
- Deterministic test data generators that avoid flaky randomness in assertions

**Gaps identified:**
- No snapshot tests for regression detection
- No performance benchmarks (important for real-time trading)
- No mutation testing to verify test quality
- Missing tests for the scheduler orchestration pipeline

**Recommended additions:**
```typescript
// Property-based test example (with fast-check)
it.prop([fc.array(fc.float({ min: 1, max: 1000 }), { minLength: 50 })])(
  "buildIndicators never returns NaN fields",
  (closes) => {
    const bars = generateBars(closes);
    const result = buildIndicators(bars);
    if (result) {
      expect(Number.isFinite(result.rsi)).toBe(true);
      expect(Number.isFinite(result.atr)).toBe(true);
    }
  }
);
```

---

## Conclusions

This analysis demonstrates the systematic approach required to evaluate AI-generated code for production deployment:

1. **AI code generation produces functional but fragile code.** The core algorithms are correct in the common case, but edge cases (zero denominators, empty inputs, boundary values) are consistently under-handled.

2. **Type systems catch structural errors but not logical ones.** TypeScript's strict mode prevents many bugs, but financial logic errors (wrong smoothing formula, population vs sample variance) require domain expertise to identify.

3. **Testing is the primary quality gate.** Every critical issue identified above was discoverable through targeted unit tests. The test suite serves as both a regression safety net and a specification document.

4. **AI-generated code benefits from human review at the boundary layer.** The internal logic of each function is typically sound, but the interfaces between modules (data flow, null handling, type coercion) are where bugs concentrate.
