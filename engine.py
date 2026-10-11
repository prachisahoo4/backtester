# engine.py
# ─────────────────────────────────────────────────────────────
# Bar-by-bar backtest engine.
#
# Key design decisions:
#   • Signal generated on bar N is executed at bar N+1's OPEN
#     price — strict no-look-ahead bias.
#   • Long-only: we can hold (long) or be flat (cash). No shorts.
#   • Position sizing: fraction of current portfolio value.
#   • Slippage applied to execution price (buy: +slippage%, sell: -slippage%).
#   • Commission applied as a % of the total trade value (both legs).
#   • Fractional shares are allowed (simulates ETF / FX / crypto).
# ─────────────────────────────────────────────────────────────
from __future__ import annotations
import numpy as np
import pandas as pd
from dataclasses import dataclass, field
from config import (
    DEFAULT_INITIAL_CAPITAL,
    DEFAULT_POSITION_SIZE,
    DEFAULT_COMMISSION_PCT,
    DEFAULT_SLIPPAGE_PCT,
)


# ── Data classes ──────────────────────────────────────────────
@dataclass
class Trade:
    entry_date:  str
    exit_date:   str
    entry_price: float
    exit_price:  float
    shares:      float
    pnl:         float          # gross P&L in dollars
    pnl_pct:     float          # return on invested capital
    commission:  float          # total commission paid (both legs)
    is_open:     bool = False   # True if position was still open at end


@dataclass
class EngineResult:
    equity:      pd.DataFrame   # date-indexed: value, cash, holdings, drawdown
    trades:      list[Trade]
    signals_df:  pd.DataFrame   # original signal DataFrame for plotting
    ticker:      str
    strategy_name: str
    initial_capital: float


# ── Engine ────────────────────────────────────────────────────
def run_backtest(
    signals_df:      pd.DataFrame,
    ticker:          str           = "ASSET",
    strategy_name:   str           = "Strategy",
    initial_capital: float         = DEFAULT_INITIAL_CAPITAL,
    position_size:   float         = DEFAULT_POSITION_SIZE,
    commission_pct:  float         = DEFAULT_COMMISSION_PCT,
    slippage_pct:    float         = DEFAULT_SLIPPAGE_PCT,
) -> EngineResult:
    """
    Simulate the strategy bar by bar.

    Parameters
    ----------
    signals_df    : Output of strategy.generate_signals() — must have
                    columns [open, close, signal] plus any indicator cols.
    initial_capital : Starting portfolio value in USD.
    position_size   : Fraction of portfolio to invest per trade (0.0–1.0).
    commission_pct  : Commission as % of trade value per leg.
    slippage_pct    : Slippage as % of execution price per leg.
    """
    df = signals_df.dropna(subset=["close"]).copy()
    n  = len(df)

    cash     = initial_capital
    shares   = 0.0
    in_trade = False
    entry_price = 0.0
    entry_date  = ""
    entry_commission = 0.0

    equity_values = []
    peak          = initial_capital
    trades: list[Trade] = []

    for i in range(n):
        row  = df.iloc[i]
        date = str(df.index[i])[:10]

        # ── Execute yesterday's signal at today's open ──────
        if i > 0:
            prev_signal   = df.iloc[i - 1]["signal"]
            exec_open     = row["open"]

            if prev_signal == 1 and not in_trade:
                # ── BUY ──────────────────────────────────────
                slip_price  = exec_open * (1 + slippage_pct / 100)
                allocated   = cash * position_size
                comm        = allocated * (commission_pct / 100)
                cost        = allocated + comm
                if cost <= cash and slip_price > 0:
                    shares          = (allocated - comm) / slip_price
                    cash           -= cost
                    in_trade        = True
                    entry_price     = slip_price
                    entry_date      = date
                    entry_commission = comm

            elif prev_signal == -1 and in_trade:
                # ── SELL ─────────────────────────────────────
                slip_price  = exec_open * (1 - slippage_pct / 100)
                proceeds    = shares * slip_price
                comm        = proceeds * (commission_pct / 100)
                net_proceeds = proceeds - comm
                total_comm   = entry_commission + comm

                pnl     = net_proceeds - (shares * entry_price) - entry_commission
                pnl_pct = (slip_price - entry_price) / entry_price

                trades.append(Trade(
                    entry_date=entry_date, exit_date=date,
                    entry_price=entry_price, exit_price=slip_price,
                    shares=shares, pnl=pnl, pnl_pct=pnl_pct,
                    commission=total_comm,
                ))
                cash    += net_proceeds
                shares   = 0.0
                in_trade = False

        # ── Mark-to-market at today's close ─────────────────
        portfolio_value = cash + shares * row["close"]
        if portfolio_value > peak:
            peak = portfolio_value
        drawdown = (peak - portfolio_value) / peak if peak > 0 else 0.0

        equity_values.append({
            "date":      date,
            "value":     portfolio_value,
            "cash":      cash,
            "holdings":  shares * row["close"],
            "drawdown":  drawdown,
        })

    # ── Close any open position at final bar's close ─────────
    if in_trade and n > 0:
        last_row  = df.iloc[-1]
        last_date = str(df.index[-1])[:10]
        close_px  = last_row["close"] * (1 - slippage_pct / 100)
        proceeds  = shares * close_px
        comm      = proceeds * (commission_pct / 100)
        net       = proceeds - comm
        pnl       = net - (shares * entry_price) - entry_commission
        pnl_pct   = (close_px - entry_price) / entry_price
        trades.append(Trade(
            entry_date=entry_date, exit_date=last_date,
            entry_price=entry_price, exit_price=close_px,
            shares=shares, pnl=pnl, pnl_pct=pnl_pct,
            commission=entry_commission + comm,
            is_open=True,
        ))
        # Update final equity row
        equity_values[-1]["value"]    = cash + net
        equity_values[-1]["holdings"] = 0.0

    equity_df = pd.DataFrame(equity_values).set_index("date")
    equity_df.index = pd.to_datetime(equity_df.index)

    return EngineResult(
        equity=equity_df,
        trades=trades,
        signals_df=df,
        ticker=ticker,
        strategy_name=strategy_name,
        initial_capital=initial_capital,
    )
