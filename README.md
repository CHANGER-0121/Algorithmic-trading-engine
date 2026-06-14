# Algorithmic Trading Engine

A personal project I built to explore systematic trading — specifically how to combine multiple technical strategies and only act when they agree. The core idea is that any single indicator is noisy, but if momentum, mean reversion, and relative strength all point the same direction at once, that's worth paying attention to.

Written in TypeScript with strict types throughout. There's also a Python backtester in `examples/` for running simulations against synthetic price data.

---

## How it works

Three strategies run independently on each scan:

- **Momentum** — looks at EMA alignment, MACD crossovers, RSI zone, and ADX trend strength
- **Mean Reversion** — catches oversold bounces using Bollinger Band extremes and RSI extremes
- **Relative Strength** — compares the stock's 20-day return against SPY to find outperformers

A **conviction filter** then checks whether at least 2 of the 3 strategies agree on direction. If they don't, it stays flat. This was the biggest improvement to signal quality — cutting the number of trades but improving the ones that do fire.

Position sizing is ATR-based (scales down automatically in volatile conditions) and there's a circuit breaker that stops new buys if the day is down more than 2%.

---
## Project structure

```
src/
├── types.ts              # All shared types — Signal, Position, Regime, Config
├── indicators.ts         # EMA, RSI, MACD, ATR, ADX, Bollinger Bands
├── tradingEngine.ts      # The three strategies + conviction filter
├── regimeDetector.ts     # Classifies market as uptrend/sideways/downtrend/etc.
├── riskManager.ts        # Position sizing, correlation checks, circuit breaker
└── scheduler.ts          # Orchestrates scans and manages open positions

tests/
├── indicators.test.ts    # 26 tests
├── riskManager.test.ts   # 35 tests
└── tradingEngine.test.ts # 17 tests

docs/
└── CODE_REVIEW.md        # Notes on bugs found and fixed during development

examples/
└── backtest.py           # Python backtester with configurable synthetic data
```
---

## Running it

```bash
npm install
npm test


