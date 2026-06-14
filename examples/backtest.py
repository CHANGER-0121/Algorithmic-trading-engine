"""
Simple Momentum Backtester
==========================

A minimal Python backtesting framework that mirrors the TypeScript engine's
momentum strategy logic. Demonstrates multi-language proficiency and the
ability to validate trading strategies across different implementations.

Usage:
    python backtest.py --symbol AAPL --start 2024-01-01 --end 2024-12-31

Dependencies:
    pip install pandas numpy
"""

from __future__ import annotations

import argparse
import dataclasses
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
import numpy as np


# ─── Data Types ──────────────────────────────────────────────────────────────


@dataclass
class Bar:
    """OHLCV bar representation."""
    timestamp: int
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass
class Signal:
    """Trading signal with confidence score."""
    direction: str  # "BUY" | "SELL" | "HOLD"
    confidence: float  # 0-100
    strategy: str
    reasoning: str


@dataclass
class Trade:
    """Executed trade record."""
    symbol: str
    direction: str
    entry_price: float
    exit_price: float
    shares: int
    entry_time: int
    exit_time: int
    pnl: float
    pnl_pct: float
    strategy: str


@dataclass
class BacktestResult:
    """Complete backtest output."""
    trades: List[Trade] = field(default_factory=list)
    total_return_pct: float = 0.0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    max_drawdown_pct: float = 0.0
    sharpe_ratio: float = 0.0
    total_trades: int = 0
    avg_holding_days: float = 0.0


# ─── Technical Indicators ────────────────────────────────────────────────────


def calculate_ema(data: np.ndarray, period: int) -> np.ndarray:
    """
    Exponential Moving Average using the same algorithm as the TypeScript version.
    Seeds with SMA, then applies EMA formula.
    """
    if len(data) < period:
        return np.array([])

    multiplier = 2.0 / (period + 1)
    result = np.zeros(len(data) - period + 1)

    # Seed with SMA
    result[0] = np.mean(data[:period])

    # EMA calculation
    for i in range(1, len(result)):
        result[i] = (data[period + i - 1] - result[i - 1]) * multiplier + result[i - 1]

    return result


def calculate_rsi(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """
    Relative Strength Index using Wilder's smoothing.
    Handles division by zero (pure uptrend/downtrend).
    """
    if len(closes) < period + 1:
        return np.array([])

    changes = np.diff(closes)
    gains = np.where(changes > 0, changes, 0.0)
    losses = np.where(changes < 0, np.abs(changes), 0.0)

    result = []

    # Initial average
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    # First RSI
    rs = 100.0 if avg_loss == 0 else avg_gain / avg_loss
    result.append(100.0 - 100.0 / (1.0 + rs))

    # Subsequent values
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        rs = 100.0 if avg_loss == 0 else avg_gain / avg_loss
        result.append(100.0 - 100.0 / (1.0 + rs))

    return np.array(result)


def calculate_atr(bars: List[Bar], period: int = 14) -> np.ndarray:
    """Average True Range calculation."""
    if len(bars) < period + 1:
        return np.array([])

    true_ranges = []
    for i in range(1, len(bars)):
        tr = max(
            bars[i].high - bars[i].low,
            abs(bars[i].high - bars[i - 1].close),
            abs(bars[i].low - bars[i - 1].close),
        )
        true_ranges.append(tr)

    tr_array = np.array(true_ranges)
    result = [np.mean(tr_array[:period])]

    for i in range(period, len(tr_array)):
        atr = (result[-1] * (period - 1) + tr_array[i]) / period
        result.append(atr)

    return np.array(result)


# ─── Momentum Strategy ───────────────────────────────────────────────────────


def evaluate_momentum(closes: np.ndarray, volumes: np.ndarray) -> Signal:
    """
    Momentum strategy signal generation.
    Mirrors the TypeScript evaluateMomentum() logic.
    """
    if len(closes) < 50:
        return Signal("HOLD", 0, "momentum", "Insufficient data")

    ema8 = calculate_ema(closes, 8)
    ema21 = calculate_ema(closes, 21)
    ema50 = calculate_ema(closes, 50)
    rsi_values = calculate_rsi(closes, 14)

    if len(ema8) == 0 or len(ema21) == 0 or len(ema50) == 0 or len(rsi_values) == 0:
        return Signal("HOLD", 0, "momentum", "Insufficient indicator data")

    # Latest values
    latest_ema8 = ema8[-1]
    latest_ema21 = ema21[-1]
    latest_ema50 = ema50[-1]
    latest_rsi = rsi_values[-1]
    latest_price = closes[-1]
    avg_volume = np.mean(volumes[-20:])
    latest_volume = volumes[-1]

    confidence = 0.0
    reasons = []

    # EMA alignment
    if latest_ema8 > latest_ema21 > latest_ema50:
        confidence += 20
        reasons.append("Bullish EMA alignment")
    elif latest_ema8 < latest_ema21 < latest_ema50:
        confidence -= 20
        reasons.append("Bearish EMA alignment")

    # RSI momentum zone
    if 40 <= latest_rsi <= 70:
        confidence += 10
        reasons.append(f"RSI in momentum zone ({latest_rsi:.1f})")
    elif latest_rsi > 80:
        confidence -= 15
        reasons.append(f"RSI overbought ({latest_rsi:.1f})")

    # Volume confirmation
    if latest_volume > avg_volume * 1.5:
        confidence += 10
        reasons.append("Volume surge")

    # Price above EMAs
    if latest_price > latest_ema8 and latest_price > latest_ema21:
        confidence += 10
        reasons.append("Price above EMAs")

    # Direction determination
    if confidence >= 40:
        direction = "BUY"
        confidence = min(95, 50 + confidence)
    elif confidence <= -30:
        direction = "SELL"
        confidence = min(95, 50 + abs(confidence))
    else:
        direction = "HOLD"
        confidence = max(0, 30 + confidence)

    return Signal(direction, round(confidence), "momentum", "; ".join(reasons))


# ─── Position Sizing ─────────────────────────────────────────────────────────


def volatility_position_size(
    equity: float,
    price: float,
    atr: float,
    confidence: float,
    risk_per_trade: float = 0.02,
    max_position_pct: float = 0.25,
    stop_atr_mult: float = 2.5,
) -> int:
    """
    ATR-based position sizing.
    Returns number of shares to buy.
    """
    if equity <= 0 or price <= 0 or atr <= 0:
        return 0

    risk_per_share = atr * stop_atr_mult
    confidence_scale = 0.4 + (confidence / 100) * 1.0
    dollar_risk = equity * risk_per_trade * confidence_scale

    shares = int(dollar_risk / risk_per_share)

    # Cap at max position
    max_shares = int((equity * max_position_pct) / price)
    shares = min(shares, max_shares)

    return max(1, shares)


# ─── Backtester Engine ───────────────────────────────────────────────────────


def run_backtest(
    bars: List[Bar],
    initial_equity: float = 100_000.0,
    confidence_threshold: float = 62.0,
) -> BacktestResult:
    """
    Run a simple momentum backtest over historical bars.

    Rules:
    - Enter when momentum signal confidence >= threshold
    - Exit on trailing stop (2.5 ATR) or signal reversal
    - Max 1 position at a time (simplified)
    """
    if len(bars) < 60:
        return BacktestResult()

    closes = np.array([b.close for b in bars])
    volumes = np.array([b.volume for b in bars])
    atr_values = calculate_atr(bars, 14)

    equity = initial_equity
    peak_equity = initial_equity
    max_drawdown = 0.0
    trades: List[Trade] = []
    daily_returns: List[float] = []

    # Position state
    in_position = False
    entry_price = 0.0
    entry_idx = 0
    shares = 0
    stop_loss = 0.0

    # Walk forward from bar 60 (need history for indicators)
    for i in range(60, len(bars)):
        window_closes = closes[: i + 1]
        window_volumes = volumes[: i + 1]
        current_price = bars[i].close
        current_atr = atr_values[i - 15] if i - 15 < len(atr_values) else closes[i] * 0.02

        if in_position:
            # Update trailing stop
            new_stop = current_price - current_atr * 2.5
            stop_loss = max(stop_loss, new_stop)

            # Check stop loss
            if current_price <= stop_loss:
                pnl = (current_price - entry_price) * shares
                pnl_pct = (current_price - entry_price) / entry_price * 100

                trades.append(Trade(
                    symbol="BACKTEST",
                    direction="LONG",
                    entry_price=entry_price,
                    exit_price=current_price,
                    shares=shares,
                    entry_time=bars[entry_idx].timestamp,
                    exit_time=bars[i].timestamp,
                    pnl=pnl,
                    pnl_pct=pnl_pct,
                    strategy="momentum",
                ))

                equity += pnl
                in_position = False

            # Track daily P&L
            daily_returns.append((current_price - bars[i - 1].close) / bars[i - 1].close * shares * entry_price / equity)
        else:
            daily_returns.append(0.0)

            # Generate signal
            signal = evaluate_momentum(window_closes, window_volumes)

            if signal.direction == "BUY" and signal.confidence >= confidence_threshold:
                shares = volatility_position_size(equity, current_price, current_atr, signal.confidence)
                entry_price = current_price
                entry_idx = i
                stop_loss = current_price - current_atr * 2.5
                in_position = True

        # Track drawdown
        peak_equity = max(peak_equity, equity)
        drawdown = (peak_equity - equity) / peak_equity * 100
        max_drawdown = max(max_drawdown, drawdown)

    # Close any open position at end
    if in_position:
        final_price = bars[-1].close
        pnl = (final_price - entry_price) * shares
        equity += pnl
        trades.append(Trade(
            symbol="BACKTEST",
            direction="LONG",
            entry_price=entry_price,
            exit_price=final_price,
            shares=shares,
            entry_time=bars[entry_idx].timestamp,
            exit_time=bars[-1].timestamp,
            pnl=pnl,
            pnl_pct=(final_price - entry_price) / entry_price * 100,
            strategy="momentum",
        ))

    # Calculate metrics
    result = BacktestResult()
    result.trades = trades
    result.total_trades = len(trades)
    result.total_return_pct = (equity - initial_equity) / initial_equity * 100

    if trades:
        winners = [t for t in trades if t.pnl > 0]
        losers = [t for t in trades if t.pnl <= 0]
        result.win_rate = len(winners) / len(trades) * 100

        gross_profit = sum(t.pnl for t in winners) if winners else 0
        gross_loss = abs(sum(t.pnl for t in losers)) if losers else 1
        result.profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

        # Average holding period (in bars, approximating days)
        holding_periods = [t.exit_time - t.entry_time for t in trades]
        result.avg_holding_days = np.mean(holding_periods) / 86_400_000 if holding_periods else 0

    result.max_drawdown_pct = max_drawdown

    # Sharpe ratio (annualized)
    if daily_returns:
        returns_array = np.array(daily_returns)
        if returns_array.std() > 0:
            result.sharpe_ratio = (returns_array.mean() / returns_array.std()) * np.sqrt(252)

    return result


# ─── Synthetic Data Generator ────────────────────────────────────────────────


def generate_synthetic_bars(
    n_bars: int = 252,
    start_price: float = 100.0,
    daily_drift: float = 0.0005,
    daily_vol: float = 0.02,
    seed: int = 42,
) -> List[Bar]:
    """
    Generate synthetic OHLCV bars with configurable drift and volatility.
    Useful for strategy validation without requiring market data API.
    """
    rng = np.random.default_rng(seed)
    bars = []
    price = start_price

    for i in range(n_bars):
        # Geometric Brownian Motion
        daily_return = daily_drift + daily_vol * rng.standard_normal()
        close = price * (1 + daily_return)

        # Generate OHLV from close
        intraday_vol = abs(daily_return) + daily_vol * 0.5
        high = close * (1 + rng.uniform(0, intraday_vol))
        low = close * (1 - rng.uniform(0, intraday_vol))
        open_price = price * (1 + rng.uniform(-0.005, 0.005))

        bars.append(Bar(
            timestamp=1704067200000 + i * 86_400_000,  # Start 2024-01-01
            open=round(open_price, 2),
            high=round(max(high, open_price, close), 2),
            low=round(min(low, open_price, close), 2),
            close=round(close, 2),
            volume=int(1_000_000 * (1 + rng.uniform(-0.3, 0.7))),
        ))

        price = close

    return bars


# ─── Main ────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Momentum Strategy Backtester")
    parser.add_argument("--bars", type=int, default=252, help="Number of bars to simulate")
    parser.add_argument("--equity", type=float, default=100_000, help="Starting equity")
    parser.add_argument("--threshold", type=float, default=62, help="Confidence threshold")
    parser.add_argument("--drift", type=float, default=0.0005, help="Daily drift (positive = uptrend)")
    parser.add_argument("--volatility", type=float, default=0.02, help="Daily volatility")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    args = parser.parse_args()

    print("=" * 60)
    print("  MOMENTUM STRATEGY BACKTEST")
    print("=" * 60)
    print(f"\n  Parameters:")
    print(f"    Bars:        {args.bars}")
    print(f"    Equity:      ${args.equity:,.0f}")
    print(f"    Threshold:   {args.threshold}")
    print(f"    Drift:       {args.drift:.4f}")
    print(f"    Volatility:  {args.volatility:.4f}")
    print(f"    Seed:        {args.seed}")

    # Generate synthetic data
    bars = generate_synthetic_bars(
        n_bars=args.bars,
        start_price=100.0,
        daily_drift=args.drift,
        daily_vol=args.volatility,
        seed=args.seed,
    )

    # Run backtest
    result = run_backtest(bars, initial_equity=args.equity, confidence_threshold=args.threshold)

    # Print results
    print(f"\n{'─' * 60}")
    print(f"  RESULTS")
    print(f"{'─' * 60}")
    print(f"    Total Return:     {result.total_return_pct:+.2f}%")
    print(f"    Total Trades:     {result.total_trades}")
    print(f"    Win Rate:         {result.win_rate:.1f}%")
    print(f"    Profit Factor:    {result.profit_factor:.2f}")
    print(f"    Max Drawdown:     {result.max_drawdown_pct:.2f}%")
    print(f"    Sharpe Ratio:     {result.sharpe_ratio:.2f}")
    print(f"    Avg Hold (days):  {result.avg_holding_days:.1f}")

    if result.trades:
        print(f"\n{'─' * 60}")
        print(f"  TRADE LOG (last 5)")
        print(f"{'─' * 60}")
        for trade in result.trades[-5:]:
            emoji = "+" if trade.pnl > 0 else "-"
            print(f"    {emoji} Entry: ${trade.entry_price:.2f} → Exit: ${trade.exit_price:.2f} "
                  f"| P&L: ${trade.pnl:+.2f} ({trade.pnl_pct:+.1f}%)")

    print(f"\n{'=' * 60}\n")


if __name__ == "__main__":
    main()
