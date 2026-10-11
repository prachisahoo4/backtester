# data_fetcher.py
# ─────────────────────────────────────────────────────────────
# Fetches OHLCV data from three sources with automatic fallback:
#   1. yfinance  (primary, no key needed)
#   2. Alpha Vantage (secondary, needs free API key)
#   3. Local CSV  (manual upload)
# Always returns a clean DataFrame:
#   index : DatetimeIndex (sorted ascending, business days only)
#   cols  : open, high, low, close, volume  (all float64)
# ─────────────────────────────────────────────────────────────
import os
import logging
import requests
import pandas as pd
import numpy as np

from config import ALPHA_VANTAGE_API_KEY, UPLOAD_DIR

logger = logging.getLogger(__name__)


# ── helpers ──────────────────────────────────────────────────
def _clean(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise column names, drop bad rows, sort ascending."""
    df.columns = [c.strip().lower().split(" ")[-1] for c in df.columns]
    # Rename common variants
    renames = {
        "price": "close", "adj": "close",
        "vol":   "volume",
    }
    df = df.rename(columns={k: v for k, v in renames.items() if k in df.columns})
    required = {"open", "high", "low", "close"}
    if not required.issubset(df.columns):
        raise ValueError(f"Missing columns. Found: {list(df.columns)}")
    if "volume" not in df.columns:
        df["volume"] = np.nan
    df = df[["open", "high", "low", "close", "volume"]].copy()
    df = df.apply(pd.to_numeric, errors="coerce")
    df.dropna(subset=["close"], inplace=True)
    df.sort_index(inplace=True)
    return df


# ── 1. yfinance ──────────────────────────────────────────────
def fetch_yfinance(ticker: str, start: str, end: str) -> pd.DataFrame:
    """
    Download daily OHLCV data via yfinance.
    Uses auto_adjust=True so 'Close' is the adjusted close price,
    avoiding the need to separately account for splits/dividends.
    """
    try:
        import yfinance as yf
        raw = yf.download(
            ticker,
            start=start,
            end=end,
            auto_adjust=True,
            progress=False,
            multi_level_index=False,
        )
        if raw.empty:
            raise ValueError("yfinance returned empty DataFrame")
        return _clean(raw)
    except Exception as exc:
        logger.warning("yfinance failed: %s", exc)
        raise


# ── 2. Alpha Vantage ─────────────────────────────────────────
def fetch_alpha_vantage(ticker: str, start: str, end: str) -> pd.DataFrame:
    """
    Download daily OHLCV via Alpha Vantage TIME_SERIES_DAILY_ADJUSTED.
    Free tier: 25 requests/day, 500 requests/month.
    """
    api_key = os.environ.get("AV_API_KEY", ALPHA_VANTAGE_API_KEY)
    url = (
        "https://www.alphavantage.co/query"
        "?function=TIME_SERIES_DAILY_ADJUSTED"
        f"&symbol={ticker}&outputsize=full&apikey={api_key}"
    )
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        ts = data.get("Time Series (Daily)")
        if not ts:
            note = data.get("Note") or data.get("Information") or "Unknown AV error"
            raise ValueError(f"Alpha Vantage: {note}")
        rows = {
            date: {
                "open":   float(vals["1. open"]),
                "high":   float(vals["2. high"]),
                "low":    float(vals["3. low"]),
                "close":  float(vals["5. adjusted close"]),   # use adjusted
                "volume": float(vals["6. volume"]),
            }
            for date, vals in ts.items()
        }
        df = pd.DataFrame.from_dict(rows, orient="index")
        df.index = pd.to_datetime(df.index)
        df = df.loc[start:end]
        if df.empty:
            raise ValueError("Alpha Vantage returned no rows for date range")
        return _clean(df)
    except Exception as exc:
        logger.warning("Alpha Vantage failed: %s", exc)
        raise


# ── 3. CSV upload ─────────────────────────────────────────────
def fetch_csv(filepath: str, start: str, end: str) -> pd.DataFrame:
    """
    Load OHLCV data from a local CSV file.
    Accepts files from Yahoo Finance, Alpha Vantage, or any CSV with
    a date column and at least a Close/Price column.
    """
    df = pd.read_csv(filepath)
    # Find date column
    date_col = next(
        (c for c in df.columns if "date" in c.lower() or "timestamp" in c.lower()),
        None
    )
    if date_col is None:
        raise ValueError("CSV has no recognisable date column")
    df[date_col] = pd.to_datetime(df[date_col], infer_datetime_format=True)
    df = df.set_index(date_col)
    df = df.loc[start:end]
    if df.empty:
        raise ValueError("CSV returned no rows for the selected date range")
    return _clean(df)


# ── public entry point ────────────────────────────────────────
def get_data(
    ticker: str,
    start: str,
    end: str,
    csv_path: str = None,
) -> tuple[pd.DataFrame, str]:
    """
    Fetch data with automatic fallback chain:
        yfinance → Alpha Vantage → CSV (if path provided)
    Returns (DataFrame, source_name).
    Raises RuntimeError if all sources fail.
    """
    errors = []

    # Try yfinance first
    try:
        df = fetch_yfinance(ticker, start, end)
        print(f"  ✓ Data loaded from yfinance ({len(df)} bars)")
        return df, "yfinance"
    except Exception as e:
        errors.append(f"yfinance: {e}")

    # Try Alpha Vantage
    try:
        df = fetch_alpha_vantage(ticker, start, end)
        print(f"  ✓ Data loaded from Alpha Vantage ({len(df)} bars)")
        return df, "alpha_vantage"
    except Exception as e:
        errors.append(f"Alpha Vantage: {e}")

    # Try CSV
    if csv_path:
        try:
            df = fetch_csv(csv_path, start, end)
            print(f"  ✓ Data loaded from CSV ({len(df)} bars)")
            return df, "csv"
        except Exception as e:
            errors.append(f"CSV: {e}")

    raise RuntimeError(
        "All data sources failed:\n" + "\n".join(f"  • {e}" for e in errors)
    )
