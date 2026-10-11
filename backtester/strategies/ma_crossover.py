# strategies/ma_crossover.py
# ─────────────────────────────────────────────────────────────
# Moving Average Crossover Strategy
#
# Logic:
#   BUY  (+1) : fast MA crosses ABOVE slow MA (golden cross)
#   SELL (-1) : fast MA crosses BELOW slow MA (death cross)
#   HOLD ( 0) : no crossover this bar
#
# Supports both SMA and EMA variants.
# ─────────────────────────────────────────────────────────────
import pandas as pd
from strategies.base import BaseStrategy
from indicators import sma, ema


class MACrossover(BaseStrategy):
    name = "MA Crossover"

    def __init__(
        self,
        fast_period: int = 20,
        slow_period: int = 50,
        ma_type: str = "SMA",   # "SMA" or "EMA"
    ):
        if fast_period >= slow_period:
            raise ValueError(
                f"fast_period ({fast_period}) must be < slow_period ({slow_period})"
            )
        self.fast_period = fast_period
        self.slow_period = slow_period
        self.ma_type     = ma_type.upper()

    @property
    def params(self) -> dict:
        return {
            "fast_period": self.fast_period,
            "slow_period": self.slow_period,
            "ma_type":     self.ma_type,
        }

    def generate_signals(self, data: pd.DataFrame) -> pd.DataFrame:
        df = data.copy()
        calc = ema if self.ma_type == "EMA" else sma

        df["fast_ma"] = calc(df["close"], self.fast_period)
        df["slow_ma"] = calc(df["close"], self.slow_period)

        # Previous bar values (shift by 1 to avoid look-ahead)
        prev_fast = df["fast_ma"].shift(1)
        prev_slow = df["slow_ma"].shift(1)

        # Golden cross: fast crosses above slow
        golden = (df["fast_ma"] > df["slow_ma"]) & (prev_fast <= prev_slow)
        # Death cross: fast crosses below slow
        death  = (df["fast_ma"] < df["slow_ma"]) & (prev_fast >= prev_slow)

        df["signal"] = 0
        df.loc[golden, "signal"] = 1
        df.loc[death,  "signal"] = -1

        return df
