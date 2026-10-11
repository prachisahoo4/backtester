# indicators.py
# ─────────────────────────────────────────────────────────────
# All technical indicators return pandas Series aligned to the
# input index. NaN values appear where there is insufficient
# history (warm-up period).
# ─────────────────────────────────────────────────────────────
import numpy as np
import pandas as pd


def sma(series: pd.Series, period: int) -> pd.Series:
    """Simple Moving Average."""
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    """
    Exponential Moving Average.
    Uses pandas ewm with adjust=False (standard recursive EMA).
    Seed: first `period` bars are averaged to form the initial EMA value;
    prior values are set to NaN to avoid warm-up contamination.
    """
    result = series.ewm(span=period, adjust=False, min_periods=period).mean()
    # Mask the warm-up window with NaN for consistency with SMA behaviour
    result.iloc[:period - 1] = np.nan
    return result


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """
    Relative Strength Index (Wilder's smoothing method).
    Formula:
        RS  = AvgGain / AvgLoss  (Wilder smoothed)
        RSI = 100 - 100 / (1 + RS)
    Returns values in [0, 100]. NaN for the first `period` bars.

    Implementation uses a manual loop seeded with the SMA of the first
    `period` gains/losses, then applies Wilder's recursive smoothing:
        AvgGain_t = (AvgGain_{t-1} * (period-1) + Gain_t) / period
    This avoids pandas ewm edge-case behaviour with all-zero series.
    """
    delta = series.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)

    result = pd.Series(np.nan, index=series.index)

    if len(series) < period + 1:
        return result

    # Seed: simple average of first `period` gains and losses
    avg_gain = float(gain.iloc[1:period + 1].mean())
    avg_loss = float(loss.iloc[1:period + 1].mean())

    if avg_loss == 0:
        result.iloc[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        result.iloc[period] = 100.0 - (100.0 / (1.0 + rs))

    # Wilder recursive smoothing from bar period+1 onwards
    for i in range(period + 1, len(series)):
        avg_gain = (avg_gain * (period - 1) + float(gain.iloc[i])) / period
        avg_loss = (avg_loss * (period - 1) + float(loss.iloc[i])) / period
        if avg_loss == 0:
            result.iloc[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            result.iloc[i] = 100.0 - (100.0 / (1.0 + rs))

    return result


def bollinger_bands(
    series: pd.Series,
    period: int = 20,
    num_std: float = 2.0
) -> pd.DataFrame:
    """
    Bollinger Bands.
    Returns a DataFrame with columns: [upper, mid, lower, bandwidth, %b]
        mid       = SMA(period)
        upper     = mid + num_std * rolling_std
        lower     = mid - num_std * rolling_std
        bandwidth = (upper - lower) / mid          (normalised width)
        pct_b     = (price - lower) / (upper - lower)   (position within bands)
    """
    mid   = series.rolling(window=period, min_periods=period).mean()
    std   = series.rolling(window=period, min_periods=period).std(ddof=0)
    upper = mid + num_std * std
    lower = mid - num_std * std
    bw    = (upper - lower) / mid
    pct_b = (series - lower) / (upper - lower).replace(0, np.nan)
    return pd.DataFrame({
        "upper": upper,
        "mid":   mid,
        "lower": lower,
        "bandwidth": bw,
        "pct_b": pct_b,
    }, index=series.index)
