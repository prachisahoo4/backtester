# metrics.py
# ─────────────────────────────────────────────────────────────
# Performance metrics computed from an EngineResult.
#
# All formulas documented with precise definitions.
# ─────────────────────────────────────────────────────────────
from __future__ import annotations
import numpy as np
import pandas as pd
from engine import EngineResult
from config import RISK_FREE_RATE_DAILY, TRADING_DAYS_PER_YEAR


def compute_metrics(result: EngineResult) -> dict:
    """
    Compute a full suite of performance metrics.

    Returns
    -------
    dict with the following keys (all floats unless noted):
        total_return, cagr, annualised_vol,
        sharpe, sortino, calmar,
        max_drawdown, max_drawdown_duration (int, bars),
        total_trades (int), win_rate, profit_factor,
        avg_win, avg_loss, expectancy,
        gross_profit, gross_loss,
        best_trade, worst_trade,
        final_value, initial_capital
    """
    eq     = result.equity["value"]
    trades = result.trades
    cap    = result.initial_capital

    if len(eq) < 2:
        return {}

    # ── Returns ───────────────────────────────────────────────
    final_value  = float(eq.iloc[-1])
    total_return = (final_value - cap) / cap

    # Daily log returns — more stable than arithmetic for compounding
    daily_ret = eq.pct_change().dropna()
    n_days    = len(daily_ret)

    # ── CAGR ──────────────────────────────────────────────────
    # CAGR = (FV / IV)^(252 / n_trading_days) − 1
    cagr = (final_value / cap) ** (TRADING_DAYS_PER_YEAR / max(n_days, 1)) - 1

    # ── Volatility (annualised) ───────────────────────────────
    # σ_annual = σ_daily × √252
    daily_std    = float(daily_ret.std(ddof=1))
    ann_vol      = daily_std * np.sqrt(TRADING_DAYS_PER_YEAR)

    # ── Sharpe Ratio ──────────────────────────────────────────
    # Sharpe = (μ_daily − Rf_daily) / σ_daily × √252
    # where Rf_daily = annual Rf / 252  (4.5% / 252)
    mean_ret = float(daily_ret.mean())
    excess   = mean_ret - RISK_FREE_RATE_DAILY
    sharpe   = (excess / daily_std * np.sqrt(TRADING_DAYS_PER_YEAR)
                if daily_std > 0 else 0.0)

    # ── Sortino Ratio ─────────────────────────────────────────
    # Uses only negative excess returns in the denominator (downside deviation).
    # Sortino = (μ_daily − Rf_daily) / σ_downside × √252
    neg_excess    = daily_ret[daily_ret < RISK_FREE_RATE_DAILY] - RISK_FREE_RATE_DAILY
    downside_std  = float(np.sqrt((neg_excess ** 2).mean())) if len(neg_excess) > 0 else 0.0
    sortino       = (excess / downside_std * np.sqrt(TRADING_DAYS_PER_YEAR)
                     if downside_std > 0 else 0.0)

    # ── Maximum Drawdown ──────────────────────────────────────
    # MDD = max((peak − trough) / peak)  over rolling window
    rolling_peak = eq.cummax()
    drawdown_ser = (rolling_peak - eq) / rolling_peak.replace(0, np.nan)
    max_dd       = float(drawdown_ser.max())

    # Drawdown duration: longest consecutive bars in drawdown
    in_dd = (drawdown_ser > 0).astype(int)
    max_dd_dur = 0
    cur_dur    = 0
    for v in in_dd:
        if v:
            cur_dur += 1
            max_dd_dur = max(max_dd_dur, cur_dur)
        else:
            cur_dur = 0

    # ── Calmar Ratio ──────────────────────────────────────────
    # Calmar = CAGR / |Max Drawdown|
    calmar = cagr / max_dd if max_dd > 0 else 0.0

    # ── Trade statistics ──────────────────────────────────────
    if trades:
        pnls    = np.array([t.pnl for t in trades])
        winners = pnls[pnls > 0]
        losers  = pnls[pnls <= 0]

        win_rate     = len(winners) / len(pnls)
        gross_profit = float(winners.sum()) if len(winners) > 0 else 0.0
        gross_loss   = float(abs(losers.sum())) if len(losers) > 0 else 0.0
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else np.inf

        avg_win   = float(winners.mean()) if len(winners) > 0 else 0.0
        avg_loss  = float(abs(losers.mean())) if len(losers) > 0 else 0.0

        # Expectancy = (win_rate × avg_win) − (loss_rate × avg_loss)
        expectancy = win_rate * avg_win - (1 - win_rate) * avg_loss

        best_trade  = float(pnls.max())
        worst_trade = float(pnls.min())
        n_trades    = len(trades)
    else:
        win_rate = gross_profit = gross_loss = 0.0
        profit_factor = avg_win = avg_loss = expectancy = 0.0
        best_trade = worst_trade = 0.0
        n_trades = 0

    return {
        # Returns
        "total_return":         total_return,
        "cagr":                 cagr,
        "final_value":          final_value,
        "initial_capital":      cap,
        # Risk
        "annualised_vol":       ann_vol,
        "max_drawdown":         max_dd,
        "max_drawdown_duration": max_dd_dur,
        # Risk-adjusted
        "sharpe":               sharpe,
        "sortino":              sortino,
        "calmar":               calmar,
        # Trades
        "total_trades":         n_trades,
        "win_rate":             win_rate,
        "profit_factor":        profit_factor,
        "gross_profit":         gross_profit,
        "gross_loss":           gross_loss,
        "avg_win":              avg_win,
        "avg_loss":             avg_loss,
        "expectancy":           expectancy,
        "best_trade":           best_trade,
        "worst_trade":          worst_trade,
    }


def print_metrics(metrics: dict, result: EngineResult) -> None:
    """Pretty-print metrics to the terminal."""
    m   = metrics
    sep = "─" * 52

    def pct(v):  return f"{v * 100:+.2f}%"
    def usd(v):  return f"${v:,.2f}"
    def num(v):  return f"{v:.3f}"

    print(f"\n{'═' * 52}")
    print(f"  BACKTEST RESULTS: {result.ticker} — {result.strategy_name}")
    print(f"{'═' * 52}")
    print(f"  {'Initial Capital':<28} {usd(m['initial_capital'])}")
    print(f"  {'Final Value':<28} {usd(m['final_value'])}")
    print(f"{sep}")
    print(f"  {'Total Return':<28} {pct(m['total_return'])}")
    print(f"  {'CAGR':<28} {pct(m['cagr'])}")
    print(f"  {'Annualised Volatility':<28} {pct(m['annualised_vol'])}")
    print(f"{sep}")
    print(f"  {'Sharpe Ratio':<28} {num(m['sharpe'])}")
    print(f"  {'Sortino Ratio':<28} {num(m['sortino'])}")
    print(f"  {'Calmar Ratio':<28} {num(m['calmar'])}")
    print(f"{sep}")
    print(f"  {'Max Drawdown':<28} {pct(m['max_drawdown'])}")
    print(f"  {'Max Drawdown Duration':<28} {m['max_drawdown_duration']} bars")
    print(f"{sep}")
    print(f"  {'Total Trades':<28} {m['total_trades']}")
    print(f"  {'Win Rate':<28} {pct(m['win_rate'])}")
    print(f"  {'Profit Factor':<28} {num(m['profit_factor']) if m['profit_factor'] != float('inf') else '∞'}")
    print(f"  {'Avg Win':<28} {usd(m['avg_win'])}")
    print(f"  {'Avg Loss':<28} {usd(m['avg_loss'])}")
    print(f"  {'Expectancy (per trade)':<28} {usd(m['expectancy'])}")
    print(f"  {'Best Trade':<28} {usd(m['best_trade'])}")
    print(f"  {'Worst Trade':<28} {usd(m['worst_trade'])}")
    print(f"{'═' * 52}\n")
