# strategies/mean_reversion.py
# ─────────────────────────────────────────────────────────────
# Bollinger Band Mean Reversion Strategy
#
# Logic:
#   BUY  (+1) : close crosses DOWN through the lower band
#               (price statistically cheap — expect reversion to mean)
#   SELL (-1) : close crosses UP through the upper band
#               (price statistically expensive — expect reversion to mean)
#   HOLD ( 0) : price within bands or no crossover
#
# The crossover filter (price must CROSS the band, not just touch it)
# reduces false signals compared to a simple "price < lower" rule.
# ─────────────────────────────────────────────────────────────
import pandas as pd
from strategies.base import BaseStrategy
from indicators import bollinger_bands


class MeanReversionBB(BaseStrategy):
    name = "Mean Reversion (Bollinger Bands)"

    def __init__(
        self,
        bb_period:  int   = 20,
        bb_std_dev: float = 2.0,
    ):
        self.bb_period  = bb_period
        self.bb_std_dev = bb_std_dev

    @property
    def params(self) -> dict:
        return {
            "bb_period":  self.bb_period,
            "bb_std_dev": self.bb_std_dev,
        }

    def generate_signals(self, data: pd.DataFrame) -> pd.DataFrame:
        df   = data.copy()
        bb   = bollinger_bands(df["close"], self.bb_period, self.bb_std_dev)
        df["bb_upper"]     = bb["upper"]
        df["bb_mid"]       = bb["mid"]
        df["bb_lower"]     = bb["lower"]
        df["bb_bandwidth"] = bb["bandwidth"]
        df["bb_pct_b"]     = bb["pct_b"]

        prev_close = df["close"].shift(1)
        prev_lower = df["bb_lower"].shift(1)
        prev_upper = df["bb_upper"].shift(1)

        # Price crosses below lower band → BUY (oversold, expect bounce)
        cross_lower = (df["close"] < df["bb_lower"]) & (prev_close >= prev_lower)
        # Price crosses above upper band → SELL (overbought, expect pullback)
        cross_upper = (df["close"] > df["bb_upper"]) & (prev_close <= prev_upper)

        df["signal"] = 0
        df.loc[cross_lower, "signal"] = 1
        df.loc[cross_upper, "signal"] = -1

        return df
