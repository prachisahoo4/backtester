# AlgoBacktest Engine

A professional-grade algorithmic trading backtesting system in Python.

## Features
- **3 strategies**: Moving Average Crossover, RSI Momentum, Bollinger Band Mean Reversion
- **Bar-by-bar engine**: signals on bar N execute at bar N+1 open — zero look-ahead bias
- **3 data sources**: yfinance (primary) → Alpha Vantage (fallback) → CSV upload
- **Full metrics**: Sharpe, Sortino, Calmar, CAGR, Max Drawdown, Win Rate, Profit Factor, Expectancy
- **5 charts**: Price+signals, Equity curve, Drawdown, Monthly heatmap, Trade distribution
- **Flask dashboard**: browse results interactively in your browser

---

## Setup

```bash
# 1. Clone / unzip the project
cd backtester

# 2. Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt
```

---

## Run

```bash
python cli.py
```

The CLI will walk you through everything interactively:

```
── Data ─────────────────────────────────────────────
  Ticker symbol (e.g. AAPL, SPY, BTC-USD) [SPY]: AAPL
  Start date (YYYY-MM-DD) [2020-01-01]:
  End date   (YYYY-MM-DD) [2024-12-31]:
  Data source (YF/CSV) [YF]:

── Strategy ─────────────────────────────────────────
  1. Moving Average Crossover (SMA / EMA)
  2. Momentum — RSI
  3. Mean Reversion — Bollinger Bands
  Select strategy (1/2/3) [1]: 1

── Strategy Parameters ──────────────────────────────
  MA type (SMA/EMA) [SMA]:
  Fast period (bars) [20]:
  Slow period (bars) [50]:

── Portfolio ─────────────────────────────────────────
  Initial capital ($) [10000.0]:
  Position size (% of portfolio) [100.0]:
  Commission per leg (%) [0.0]:
  Slippage per leg (%) [0.1]:
```

---

## CSV Upload

Download a CSV from [Yahoo Finance](https://finance.yahoo.com):
1. Search for a ticker → **Historical Data** → **Download**
2. Place the file in `data/uploads/`
3. When prompted for data source, choose `CSV` and enter the path

The CSV must have at minimum: `Date`, `Open`, `High`, `Low`, `Close`.

---

## Alpha Vantage (optional fallback)

Get a free key at https://www.alphavantage.co/support/#api-key  
Set it via environment variable:
```bash
export AV_API_KEY=your_key_here
```
Or edit `config.py` → `ALPHA_VANTAGE_API_KEY`.

---

## Metrics Reference

| Metric | Formula |
|---|---|
| **CAGR** | `(FV/IV)^(252/n_days) − 1` |
| **Sharpe** | `(μ_daily − Rf/252) / σ_daily × √252`, Rf = 4.5% |
| **Sortino** | Same but σ = downside deviation only |
| **Calmar** | `CAGR / Max Drawdown` |
| **Max Drawdown** | `max((peak − trough) / peak)` rolling |
| **Profit Factor** | `Gross Profit / Gross Loss` |
| **Expectancy** | `win_rate × avg_win − loss_rate × avg_loss` |

---

## Project Structure

```
backtester/
├── cli.py                 ← Entry point — run this
├── app.py                 ← Flask dashboard
├── engine.py              ← Bar-by-bar backtest loop
├── metrics.py             ← All performance metrics
├── indicators.py          ← SMA, EMA, RSI, Bollinger Bands
├── plotter.py             ← 5 matplotlib charts
├── data_fetcher.py        ← yfinance / Alpha Vantage / CSV
├── config.py              ← Constants (Rf, colours, paths)
├── strategies/
│   ├── base.py            ← Abstract base class
│   ├── ma_crossover.py    ← Golden/death cross
│   ├── momentum.py        ← RSI overbought/oversold
│   └── mean_reversion.py  ← Bollinger Band reversion
├── templates/
│   └── dashboard.html     ← Flask UI
├── data/uploads/          ← Drop CSV files here
├── results/               ← Charts saved here (PNG)
└── requirements.txt
```

---

## Adding a Custom Strategy

1. Create `strategies/my_strategy.py` inheriting `BaseStrategy`
2. Implement `generate_signals(data)` — add a `signal` column (+1 / -1 / 0)
3. Import it in `strategies/__init__.py`
4. Add a menu option in `cli.py`

```python
from strategies.base import BaseStrategy

class MyStrategy(BaseStrategy):
    name = "My Custom Strategy"

    def __init__(self, period: int = 10):
        self.period = period

    @property
    def params(self):
        return {"period": self.period}

    def generate_signals(self, data):
        df = data.copy()
        # ... compute indicator, set df["signal"] ...
        return df
```
