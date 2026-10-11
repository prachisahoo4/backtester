# config.py
# ─────────────────────────────────────────────────────────────
# Global constants for the backtesting engine
# ─────────────────────────────────────────────────────────────

# Risk-free rate (annualised) used in Sharpe & Sortino
# Using approximate current 3-month T-bill yield (update as needed)
RISK_FREE_RATE_ANNUAL = 0.045          # 4.5%
RISK_FREE_RATE_DAILY  = RISK_FREE_RATE_ANNUAL / 252

TRADING_DAYS_PER_YEAR = 252

# Default portfolio settings
DEFAULT_INITIAL_CAPITAL = 10_000.0     # USD
DEFAULT_POSITION_SIZE   = 1.0          # fraction of portfolio (1.0 = 100%)
DEFAULT_COMMISSION_PCT  = 0.0          # % per trade (each leg)
DEFAULT_SLIPPAGE_PCT    = 0.1          # % per trade (each leg)

# Alpha Vantage — set your key here or via AV_API_KEY env variable
ALPHA_VANTAGE_API_KEY = "demo"

# Output directories
RESULTS_DIR   = "results"
UPLOAD_DIR    = "data/uploads"

# Chart style
CHART_STYLE   = "dark_background"
CHART_DPI     = 150
CHART_FIGSIZE = (14, 8)

# Colours (hex, used in plotter.py)
CLR_PRICE     = "#e2e8f0"
CLR_FAST_MA   = "#00d4ff"
CLR_SLOW_MA   = "#ffd600"
CLR_BB_BAND   = "#a855f7"
CLR_BB_MID    = "#64748b"
CLR_EQUITY    = "#00d4ff"
CLR_DRAWDOWN  = "#ff3d57"
CLR_BUY       = "#00e676"
CLR_SELL      = "#ff3d57"
CLR_POSITIVE  = "#00e676"
CLR_NEGATIVE  = "#ff3d57"
CLR_NEUTRAL   = "#64748b"
