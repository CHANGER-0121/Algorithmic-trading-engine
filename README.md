# Algorithmic Trading Engine

A multi-strategy autonomous trading system built in TypeScript that uses technical analysis, market regime detection, and adaptive risk management to identify and execute trades across equities and crypto markets.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SCHEDULER (Orchestrator)                   │
│  Manages scan timing, position lifecycle, and risk limits    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Signal       │  │  Position    │  │  Risk            │  │
│  │  Generator    │  │  Manager     │  │  Engine          │  │
│  │              │  │              │  │                  │  │
│  │ • Momentum   │  │ • Entry      │  │ • Position Size  │  │
│  │ • Mean Rev   │  │ • Pyramiding │  │ • Correlation    │  │
│  │ • Rel Str    │  │ • Trailing   │  │ • Circuit Break  │  │
│  │ • Regime     │  │ • Partial TP │  │ • Overnight Trim │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    BROKER INTERFACE                           │
│  Market data ingestion, order routing, account state         │
└─────────────────────────────────────────────────────────────┘
```

## Features

### Multi-Strategy Signal Generation

The engine runs three independent strategies in parallel and selects the highest-confidence signal:

- **Momentum Strategy** — MACD crossovers, RSI momentum zones, EMA trend alignment, ADX strength
- **Mean Reversion** — Bollinger Band extremes, RSI oversold/overbought bounces, capitulation volume
- **Relative Strength** — Outperformance vs SPY benchmark, percentile ranking

A **Conviction Filter** requires 2+ strategies to agree before executing, reducing false signals.

### Adaptive Risk Management

- **Volatility-based position sizing** — Uses ATR to scale position size inversely with volatility
- **Correlation scoring** — Reduces exposure when positions are correlated (80%/60%/40% progressive reduction)
- **Dynamic overnight exposure** — Adjusts limits based on market regime (85% uptrend → 40% strong downtrend)
- **Circuit breaker** — Halts all new buys if daily P&L drops below -2%
- **Strategy diversity** — Max 3 positions from the same strategy type

### Intelligent Position Management

- **Pyramiding** — Adds 25% to winners up 3%+ with confirmed momentum (max 2 adds)
- **Trailing stops** — Dynamic stop-loss that follows price using ATR multiples
- **Partial profit taking** — Sells 50% at intermediate targets, lets runners ride
- **Exit quality scoring** — Delays profit-taking in strong uptrends

### Market Regime Detection

```typescript
type MarketRegime = "strong_uptrend" | "uptrend" | "sideways" | "downtrend" | "strong_downtrend";
```

Uses ADX, moving average slopes, EMA alignment, and breadth indicators to classify the current market environment and adjust strategy parameters accordingly.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.6 (strict mode) |
| Runtime | Node.js 22 (ESM) |
| Testing | Vitest 2.1 |
| Type Checking | tsc --noEmit |
| Multi-language | Python 3.11 (backtesting examples) |

## Project Structure

```
src/
├── types.ts              # Core type definitions (Signal, Position, Regime, Config)
├── indicators.ts         # Technical indicators (EMA, RSI, MACD, ATR, ADX, Bollinger)
├── tradingEngine.ts      # Multi-strategy signal generation & conviction filter
├── regimeDetector.ts     # Market regime classification & parameter tuning
├── riskManager.ts        # Position sizing, correlation, circuit breaker, overnight trim
└── scheduler.ts          # Scan orchestration, gap-up scanner, position lifecycle

tests/
├── indicators.test.ts    # 26 tests — indicator accuracy, edge cases, boundaries
├── riskManager.test.ts   # 35 tests — position sizing, correlation, circuit breaker
└── tradingEngine.test.ts # 17 tests — signal generation, conviction filter, integration

docs/
└── CODE_REVIEW.md        # AI code quality analysis (bug identification, scoring)

examples/
└── backtest.py           # Python momentum backtester with synthetic data generator
```

## Running Tests

```bash
# Install dependencies
npm install

# Run all tests (78 tests across 3 files)
npm test

# Run with coverage report
npm run test:coverage

# Run specific test file
npx vitest run tests/indicators.test.ts

# Type check without emitting
npm run typecheck
```

## Running the Python Backtester

```bash
# Default parameters (252 bars, $100k equity)
python3 examples/backtest.py

# Custom parameters
python3 examples/backtest.py --bars 500 --equity 50000 --threshold 70 --drift 0.001

# Low volatility scenario
python3 examples/backtest.py --volatility 0.01 --drift 0.0008
```

## Key Design Decisions

1. **Strategy independence** — Each strategy generates signals independently, preventing cascade failures
2. **Confidence scoring** — Every signal includes a 0-100 confidence score, enabling threshold-based filtering
3. **Pure functions** — Indicator calculations and signal generation are pure (no side effects, deterministic)
4. **Fail-safe defaults** — All error paths default to HOLD (no action), never to BUY/SELL
5. **Progressive risk reduction** — Correlation, regime, and diversity checks compound to prevent over-concentration

## Code Quality Highlights

- **Zero `any` types** — Full strict TypeScript with explicit interfaces for all data structures
- **78 unit tests** — Property-based boundary testing, edge cases, integration tests
- **Documented edge cases** — Division by zero guards, NaN propagation prevention, empty input handling
- **AI code review** — See `docs/CODE_REVIEW.md` for systematic quality analysis methodology

## License

MIT
