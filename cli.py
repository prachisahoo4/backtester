#!/usr/bin/env python3
# cli.py
# ─────────────────────────────────────────────────────────────
# Interactive terminal interface for the backtesting engine.
# Guides the user through:
#   1. Ticker and date range
#   2. Data source (yfinance / CSV)
#   3. Strategy selection
#   4. Strategy parameters (with sensible defaults)
#   5. Portfolio settings
#   6. Runs backtest → prints metrics → saves + shows charts
#   7. Optionally launches Flask dashboard
# ─────────────────────────────────────────────────────────────
import sys
import os

# Make sure project root is on path
sys.path.insert(0, os.path.dirname(__file__))

from data_fetcher import get_data
from strategies   import MACrossover, MomentumRSI, MeanReversionBB
from engine       import run_backtest
from metrics      import compute_metrics, print_metrics
from plotter      import plot_all
from config       import (
    DEFAULT_INITIAL_CAPITAL,
    DEFAULT_POSITION_SIZE,
    DEFAULT_COMMISSION_PCT,
    DEFAULT_SLIPPAGE_PCT,
    UPLOAD_DIR,
)


# ── Prompt helpers ────────────────────────────────────────────
def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        val = input(f"  {prompt}{suffix}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n  Exiting.")
        sys.exit(0)
    return val if val else default


def ask_float(prompt: str, default: float, lo: float = None, hi: float = None) -> float:
    while True:
        raw = ask(prompt, str(default))
        try:
            val = float(raw)
            if lo is not None and val < lo:
                print(f"  ⚠  Must be ≥ {lo}")
                continue
            if hi is not None and val > hi:
                print(f"  ⚠  Must be ≤ {hi}")
                continue
            return val
        except ValueError:
            print("  ⚠  Please enter a number.")


def ask_int(prompt: str, default: int, lo: int = None, hi: int = None) -> int:
    return int(ask_float(prompt, default, lo, hi))


def ask_choice(prompt: str, options: list[str], default: str) -> str:
    opts = "/".join(options)
    while True:
        val = ask(f"{prompt} ({opts})", default).upper()
        if val in [o.upper() for o in options]:
            return val
        print(f"  ⚠  Please choose one of: {opts}")


def banner():
    print("""
╔══════════════════════════════════════════════════════╗
║         ALGO BACKTEST ENGINE  •  Python Edition     ║
║     Strategies: MA Crossover · RSI · Bollinger      ║
╚══════════════════════════════════════════════════════╝
""")


# ── Main flow ─────────────────────────────────────────────────
def main():
    banner()

    # ── 1. Ticker & date range ────────────────────────────────
    print("── Data ─────────────────────────────────────────────")
    ticker = ask("Ticker symbol (e.g. AAPL, SPY, BTC-USD)", "SPY").upper()
    start  = ask("Start date (YYYY-MM-DD)", "2020-01-01")
    end    = ask("End date   (YYYY-MM-DD)", "2024-12-31")

    # ── 2. Data source ────────────────────────────────────────
    csv_path = None
    src = ask_choice(
        "Data source",
        ["YF", "CSV"],
        "YF",
    )
    if src == "CSV":
        csv_path = ask("Path to CSV file", os.path.join(UPLOAD_DIR, "data.csv"))
        if not os.path.exists(csv_path):
            print(f"  ⚠  File not found: {csv_path}")
            print("     Falling back to yfinance.")
            csv_path = None

    print(f"\n  Fetching data for {ticker} ({start} → {end})…")
    try:
        data, source = get_data(ticker, start, end, csv_path)
    except RuntimeError as e:
        print(f"\n  ✗ {e}")
        sys.exit(1)

    print(f"  Bars loaded  : {len(data)}")
    print(f"  Date range   : {data.index[0].date()} → {data.index[-1].date()}")

    # ── 3. Strategy ───────────────────────────────────────────
    print("\n── Strategy ─────────────────────────────────────────")
    print("  1. Moving Average Crossover (SMA / EMA)")
    print("  2. Momentum — RSI")
    print("  3. Mean Reversion — Bollinger Bands")
    strat_choice = ask_int("Select strategy (1/2/3)", 1, 1, 3)

    # ── 4. Strategy parameters ────────────────────────────────
    print("\n── Strategy Parameters ──────────────────────────────")
    if strat_choice == 1:
        ma_type    = ask_choice("MA type", ["SMA", "EMA"], "SMA")
        fast_p     = ask_int("Fast period (bars)", 20, 2, 100)
        slow_p     = ask_int("Slow period (bars)", 50, fast_p + 1, 300)
        strategy   = MACrossover(fast_period=fast_p, slow_period=slow_p, ma_type=ma_type)

    elif strat_choice == 2:
        rsi_p      = ask_int("RSI period (bars)", 14, 2, 50)
        oversold   = ask_float("Oversold level", 30.0, 1.0, 49.0)
        overbought = ask_float("Overbought level", 70.0, oversold + 1, 99.0)
        strategy   = MomentumRSI(rsi_period=rsi_p, oversold=oversold, overbought=overbought)

    else:
        bb_period  = ask_int("Bollinger period (bars)", 20, 5, 100)
        bb_std     = ask_float("Std deviations", 2.0, 0.5, 5.0)
        strategy   = MeanReversionBB(bb_period=bb_period, bb_std_dev=bb_std)

    print(f"\n  Strategy: {strategy}")

    # ── 5. Portfolio settings ─────────────────────────────────
    print("\n── Portfolio ─────────────────────────────────────────")
    capital    = ask_float("Initial capital ($)", DEFAULT_INITIAL_CAPITAL, 100)
    pos_size   = ask_float("Position size (% of portfolio)", 100.0, 1.0, 100.0) / 100
    commission = ask_float("Commission per leg (%)", DEFAULT_COMMISSION_PCT, 0.0, 5.0)
    slippage   = ask_float("Slippage per leg (%)", DEFAULT_SLIPPAGE_PCT, 0.0, 5.0)

    # ── 6. Run backtest ───────────────────────────────────────
    print("\n  ⏳ Running backtest…")
    signals_df = strategy.generate_signals(data)
    result     = run_backtest(
        signals_df      = signals_df,
        ticker          = ticker,
        strategy_name   = strategy.name,
        initial_capital = capital,
        position_size   = pos_size,
        commission_pct  = commission,
        slippage_pct    = slippage,
    )
    metrics = compute_metrics(result)

    # ── 7. Print metrics ──────────────────────────────────────
    print_metrics(metrics, result)

    # ── 8. Charts ─────────────────────────────────────────────
    charts = ask_choice("Generate charts?", ["Y", "N"], "Y")
    if charts == "Y":
        saved = plot_all(result, metrics)
        print(f"\n  Charts saved to: results/")

    # ── 9. Flask dashboard ────────────────────────────────────
    flask_q = ask_choice("Launch Flask dashboard in browser?", ["Y", "N"], "Y")
    if flask_q == "Y":
        try:
            from app import create_app
            app = create_app(result, metrics)
            print("\n  🌐 Dashboard running at → http://127.0.0.1:5000")
            print("     Press Ctrl+C to stop.\n")
            app.run(debug=False, port=5000)
        except ImportError as e:
            print(f"  ⚠  Flask not available: {e}")
        except KeyboardInterrupt:
            print("\n  Dashboard stopped.")

    print("\n  ✅ Done.\n")


if __name__ == "__main__":
    main()
