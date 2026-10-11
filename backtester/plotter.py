# plotter.py
# ─────────────────────────────────────────────────────────────
# All matplotlib visualisations.
# Each function saves a PNG to results/ AND calls plt.show().
# ─────────────────────────────────────────────────────────────
from __future__ import annotations
import os
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import matplotlib.ticker as mticker
import matplotlib.dates as mdates
from matplotlib.patches import Patch

from engine import EngineResult
from config import (
    RESULTS_DIR, CHART_STYLE, CHART_DPI,
    CLR_PRICE, CLR_FAST_MA, CLR_SLOW_MA, CLR_BB_BAND, CLR_BB_MID,
    CLR_EQUITY, CLR_DRAWDOWN, CLR_BUY, CLR_SELL,
    CLR_POSITIVE, CLR_NEGATIVE, CLR_NEUTRAL,
)

os.makedirs(RESULTS_DIR, exist_ok=True)
plt.style.use(CHART_STYLE)
ACCENT = "#00d4ff"


def _save(fig: plt.Figure, filename: str) -> str:
    path = os.path.join(RESULTS_DIR, filename)
    fig.savefig(path, dpi=CHART_DPI, bbox_inches="tight", facecolor=fig.get_facecolor())
    print(f"  💾 Saved → {path}")
    return path


def _fmt_pct(x, _):  return f"{x:.1f}%"
def _fmt_usd(x, _):  return f"${x:,.0f}"


# ── 1. Price Chart with Signals + Indicators ─────────────────
def plot_price_signals(result: EngineResult, metrics: dict) -> str:
    df      = result.signals_df
    dates   = df.index
    strat   = result.strategy_name
    has_mac = "fast_ma"  in df.columns
    has_bb  = "bb_upper" in df.columns
    has_rsi = "rsi"      in df.columns

    n_rows = 2 if has_rsi else 1
    height = 10 if has_rsi else 7

    fig = plt.figure(figsize=(14, height), facecolor="#0a0e1a")
    gs  = gridspec.GridSpec(n_rows, 1, height_ratios=[3, 1] if has_rsi else [1],
                            hspace=0.06, figure=fig)

    ax_price = fig.add_subplot(gs[0])
    ax_price.set_facecolor("#0d1117")

    # Price line
    ax_price.plot(dates, df["close"], color=CLR_PRICE, linewidth=1.0, label="Close", zorder=2)

    # Indicators
    if has_mac:
        ax_price.plot(dates, df["fast_ma"], color=CLR_FAST_MA, linewidth=1.3,
                      linestyle="--", label=f"Fast MA", zorder=3)
        ax_price.plot(dates, df["slow_ma"], color=CLR_SLOW_MA, linewidth=1.3,
                      linestyle="--", label=f"Slow MA", zorder=3)
    if has_bb:
        ax_price.plot(dates, df["bb_upper"], color=CLR_BB_BAND, linewidth=0.8,
                      linestyle=":", label="BB Upper", zorder=3)
        ax_price.plot(dates, df["bb_mid"],   color=CLR_BB_MID,  linewidth=0.8,
                      linestyle=":", label="BB Mid", zorder=3)
        ax_price.plot(dates, df["bb_lower"], color=CLR_BB_BAND, linewidth=0.8,
                      linestyle=":", label="BB Lower", zorder=3)
        ax_price.fill_between(dates, df["bb_upper"], df["bb_lower"],
                               alpha=0.06, color=CLR_BB_BAND, zorder=1)

    # Buy / Sell markers
    buys  = df[df["signal"] ==  1]
    sells = df[df["signal"] == -1]
    ax_price.scatter(buys.index,  buys["close"],  marker="^", color=CLR_BUY,  s=60,
                     zorder=5, label="Buy signal",  linewidths=0)
    ax_price.scatter(sells.index, sells["close"], marker="v", color=CLR_SELL, s=60,
                     zorder=5, label="Sell signal", linewidths=0)

    ax_price.set_title(f"{result.ticker} — {strat}", color="#e2e8f0",
                       fontsize=13, fontweight="bold", pad=12)
    ax_price.legend(loc="upper left", fontsize=8, framealpha=0.2,
                    labelcolor="#e2e8f0", facecolor="#161d2e")
    ax_price.yaxis.set_major_formatter(mticker.FuncFormatter(_fmt_usd))
    ax_price.tick_params(colors="#64748b", labelsize=8)
    ax_price.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax_price.grid(True, alpha=0.1, color="#ffffff")
    if has_rsi:
        ax_price.tick_params(labelbottom=False)

    # RSI sub-panel
    if has_rsi:
        ax_rsi = fig.add_subplot(gs[1], sharex=ax_price)
        ax_rsi.set_facecolor("#0d1117")
        ax_rsi.plot(dates, df["rsi"], color=ACCENT, linewidth=1.0, label="RSI")
        rsi_params = {}
        for col in ["rsi"]:
            pass
        # Draw oversold / overbought lines dynamically
        for level, color in [(30, CLR_BUY), (70, CLR_SELL)]:
            ax_rsi.axhline(level, color=color, linewidth=0.8, linestyle="--", alpha=0.7)
        ax_rsi.fill_between(dates, df["rsi"], 30, where=(df["rsi"] < 30),
                             alpha=0.3, color=CLR_BUY)
        ax_rsi.fill_between(dates, df["rsi"], 70, where=(df["rsi"] > 70),
                             alpha=0.3, color=CLR_SELL)
        ax_rsi.set_ylabel("RSI", color="#64748b", fontsize=8)
        ax_rsi.set_ylim(0, 100)
        ax_rsi.tick_params(colors="#64748b", labelsize=8)
        ax_rsi.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
        ax_rsi.grid(True, alpha=0.1, color="#ffffff")

    fname = f"{result.ticker}_price_signals.png"
    _save(fig, fname)
    plt.show()
    return fname


# ── 2. Equity Curve ───────────────────────────────────────────
def plot_equity_curve(result: EngineResult, metrics: dict) -> str:
    eq    = result.equity
    dates = eq.index

    fig, ax = plt.subplots(figsize=(14, 6), facecolor="#0a0e1a")
    ax.set_facecolor("#0d1117")

    ax.plot(dates, eq["value"], color=CLR_EQUITY, linewidth=1.5, label="Portfolio Value", zorder=3)
    ax.fill_between(dates, result.initial_capital, eq["value"],
                    where=(eq["value"] >= result.initial_capital),
                    alpha=0.15, color=CLR_POSITIVE, zorder=2)
    ax.fill_between(dates, result.initial_capital, eq["value"],
                    where=(eq["value"] < result.initial_capital),
                    alpha=0.15, color=CLR_NEGATIVE, zorder=2)
    ax.axhline(result.initial_capital, color="#64748b", linewidth=0.8,
               linestyle="--", label="Initial Capital", zorder=1)

    # Annotate final value
    final = float(eq["value"].iloc[-1])
    ret   = metrics["total_return"]
    color = CLR_POSITIVE if ret >= 0 else CLR_NEGATIVE
    ax.annotate(f"  {'+' if ret >= 0 else ''}{ret * 100:.1f}%  (${final:,.0f})",
                xy=(dates[-1], final), fontsize=9, color=color, va="center")

    ax.set_title(f"{result.ticker} — Equity Curve", color="#e2e8f0",
                 fontsize=13, fontweight="bold", pad=12)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(_fmt_usd))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.tick_params(colors="#64748b", labelsize=8)
    ax.grid(True, alpha=0.1, color="#ffffff")
    ax.legend(fontsize=8, framealpha=0.2, labelcolor="#e2e8f0", facecolor="#161d2e")

    fname = f"{result.ticker}_equity_curve.png"
    _save(fig, fname)
    plt.show()
    return fname


# ── 3. Drawdown Chart ─────────────────────────────────────────
def plot_drawdown(result: EngineResult, metrics: dict) -> str:
    eq      = result.equity
    dd      = eq["drawdown"] * 100          # convert to %
    dates   = eq.index

    fig, ax = plt.subplots(figsize=(14, 5), facecolor="#0a0e1a")
    ax.set_facecolor("#0d1117")

    ax.fill_between(dates, 0, -dd, color=CLR_DRAWDOWN, alpha=0.5, zorder=2)
    ax.plot(dates, -dd, color=CLR_DRAWDOWN, linewidth=0.8, zorder=3)
    ax.axhline(0, color="#64748b", linewidth=0.6)

    max_dd = metrics["max_drawdown"] * 100
    ax.annotate(f"  Max Drawdown: −{max_dd:.2f}%",
                xy=(dates[int(np.argmax(eq["drawdown"].values))], -max_dd),
                fontsize=9, color=CLR_NEGATIVE, va="top")

    ax.set_title(f"{result.ticker} — Drawdown", color="#e2e8f0",
                 fontsize=13, fontweight="bold", pad=12)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"{x:.1f}%"))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.tick_params(colors="#64748b", labelsize=8)
    ax.grid(True, alpha=0.1, color="#ffffff")

    fname = f"{result.ticker}_drawdown.png"
    _save(fig, fname)
    plt.show()
    return fname


# ── 4. Monthly Returns Heatmap ────────────────────────────────
def plot_monthly_heatmap(result: EngineResult, metrics: dict) -> str:
    eq = result.equity["value"].copy()
    eq.index = pd.to_datetime(eq.index)

    # Resample to month-end returns
    monthly = eq.resample("ME").last().pct_change().dropna()
    if monthly.empty:
        print("  ⚠  Not enough data for monthly heatmap (need > 1 month)")
        return ""

    years  = sorted(monthly.index.year.unique())
    months = list(range(1, 13))
    month_labels = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"]

    grid = np.full((len(years), 12), np.nan)
    for dt, ret in monthly.items():
        yi = years.index(dt.year)
        mi = dt.month - 1
        grid[yi, mi] = ret * 100

    # Symmetric colour scale around 0
    vmax = np.nanpercentile(np.abs(grid[~np.isnan(grid)]), 95) if not np.all(np.isnan(grid)) else 5
    vmax = max(vmax, 1.0)

    fig, ax = plt.subplots(figsize=(14, max(3, len(years) * 0.65 + 1.5)),
                           facecolor="#0a0e1a")
    ax.set_facecolor("#0a0e1a")

    im = ax.imshow(grid, cmap="RdYlGn", aspect="auto",
                   vmin=-vmax, vmax=vmax, interpolation="nearest")

    # Cell annotations
    for yi in range(len(years)):
        for mi in range(12):
            val = grid[yi, mi]
            if not np.isnan(val):
                txt = f"{val:+.1f}%"
                color = "black" if abs(val) < vmax * 0.6 else "white"
                ax.text(mi, yi, txt, ha="center", va="center",
                        fontsize=7.5, color=color, fontweight="500")

    ax.set_xticks(range(12))
    ax.set_xticklabels(month_labels, color="#64748b", fontsize=9)
    ax.set_yticks(range(len(years)))
    ax.set_yticklabels(years, color="#64748b", fontsize=9)
    ax.set_title(f"{result.ticker} — Monthly Returns (%)",
                 color="#e2e8f0", fontsize=13, fontweight="bold", pad=12)

    cbar = fig.colorbar(im, ax=ax, fraction=0.02, pad=0.02)
    cbar.ax.tick_params(colors="#64748b", labelsize=8)
    cbar.set_label("%", color="#64748b", fontsize=8)

    fname = f"{result.ticker}_monthly_heatmap.png"
    _save(fig, fname)
    plt.show()
    return fname


# ── 5. Trade Distribution ─────────────────────────────────────
def plot_trade_distribution(result: EngineResult, metrics: dict) -> str:
    trades = result.trades
    if not trades:
        print("  ⚠  No trades to plot.")
        return ""

    pnls = [t.pnl for t in trades]
    pcts = [t.pnl_pct * 100 for t in trades]

    fig, axes = plt.subplots(1, 2, figsize=(14, 5), facecolor="#0a0e1a")
    for ax in axes:
        ax.set_facecolor("#0d1117")

    # P&L distribution
    ax = axes[0]
    colors = [CLR_POSITIVE if p > 0 else CLR_NEGATIVE for p in pnls]
    ax.bar(range(len(pnls)), pnls, color=colors, width=0.8, zorder=2)
    ax.axhline(0, color="#64748b", linewidth=0.8)
    ax.axhline(metrics["avg_win"], color=CLR_POSITIVE, linewidth=1,
               linestyle="--", label=f"Avg win ${metrics['avg_win']:,.0f}", alpha=0.7)
    ax.axhline(-metrics["avg_loss"], color=CLR_NEGATIVE, linewidth=1,
               linestyle="--", label=f"Avg loss −${metrics['avg_loss']:,.0f}", alpha=0.7)
    ax.set_title("P&L per Trade ($)", color="#e2e8f0", fontsize=11, fontweight="bold")
    ax.set_xlabel("Trade #", color="#64748b", fontsize=9)
    ax.set_ylabel("P&L ($)", color="#64748b", fontsize=9)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(_fmt_usd))
    ax.tick_params(colors="#64748b", labelsize=8)
    ax.grid(True, alpha=0.1, color="#ffffff", axis="y")
    ax.legend(fontsize=8, framealpha=0.2, labelcolor="#e2e8f0", facecolor="#161d2e")

    # Return % histogram
    ax2 = axes[1]
    wins  = [p for p in pcts if p > 0]
    loses = [p for p in pcts if p <= 0]
    bins  = np.linspace(min(pcts) - 1, max(pcts) + 1, 30) if len(pcts) > 1 else 10
    if wins:
        ax2.hist(wins,  bins=bins, color=CLR_POSITIVE, alpha=0.7, label="Winners", zorder=2)
    if loses:
        ax2.hist(loses, bins=bins, color=CLR_NEGATIVE, alpha=0.7, label="Losers",  zorder=2)
    ax2.axvline(0, color="#64748b", linewidth=0.8)
    ax2.set_title("Return Distribution (%)", color="#e2e8f0", fontsize=11, fontweight="bold")
    ax2.set_xlabel("Return (%)", color="#64748b", fontsize=9)
    ax2.set_ylabel("Frequency",  color="#64748b", fontsize=9)
    ax2.tick_params(colors="#64748b", labelsize=8)
    ax2.grid(True, alpha=0.1, color="#ffffff", axis="y")
    ax2.legend(fontsize=8, framealpha=0.2, labelcolor="#e2e8f0", facecolor="#161d2e")

    plt.tight_layout()
    fname = f"{result.ticker}_trade_distribution.png"
    _save(fig, fname)
    plt.show()
    return fname


# ── Master call ───────────────────────────────────────────────
def plot_all(result: EngineResult, metrics: dict) -> list[str]:
    """Generate and save all charts. Returns list of saved file paths."""
    saved = []
    print("\n📊 Generating charts...")
    saved.append(plot_price_signals(result, metrics))
    saved.append(plot_equity_curve(result, metrics))
    saved.append(plot_drawdown(result, metrics))
    saved.append(plot_monthly_heatmap(result, metrics))
    saved.append(plot_trade_distribution(result, metrics))
    return [p for p in saved if p]
