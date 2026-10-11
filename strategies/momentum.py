# strategies/momentum.py
# ─────────────────────────────────────────────────────────────
# RSI Momentum Strategy
#
# Logic:
#   BUY  (+1) : RSI crosses UP through the oversold threshold
#               (momentum turning bullish from exhaustion)
#   SELL (-1) : RSI crosses DOWN through the overbought threshold
#               (momentum turning bearish from exhaustion)
#   HOLD ( 0) : RSI between thresholds or no crossover
#
# This is a mean-reversion variant of RSI (buy oversold, sell
# overbought) rather than a trend-following one, which suits
# most equities on daily bars.
# ─────────────────────────────────────────────────────────────
import pandas as pd
from strategies.base import BaseStrategy
from indicators import rsi as calc_rsi


class MomentumRSI(BaseStrategy):
    name = "Momentum (RSI)"

    def __init__(
        self,
        rsi_period:  int   = 14,
        oversold:    float = 30.0,
        overbought:  float = 70.0,
    ):
        if oversold >= overbought:
            raise ValueError(
                f"oversold ({oversold}) must be < overbought ({overbought})"
            )
        self.rsi_period  = rsi_period
        self.oversold    = oversold
        self.overbought  = overbought

    @property
    def params(self) -> dict:
        return {
            "rsi_period":  self.rsi_period,
            "oversold":    self.oversold,
            "overbought":  self.overbought,
        }

    def generate_signals(self, data: pd.DataFrame) -> pd.DataFrame:
        df = data.copy()
        df["rsi"] = calc_rsi(df["close"], self.rsi_period)

        prev_rsi = df["rsi"].shift(1)

        # RSI crosses UP through oversold → buy signal
        cross_up   = (df["rsi"] > self.oversold)  & (prev_rsi <= self.oversold)
        # RSI crosses DOWN through overbought → sell signal
        cross_down = (df["rsi"] < self.overbought) & (prev_rsi >= self.overbought)

        df["signal"] = 0
        df.loc[cross_up,   "signal"] = 1
        df.loc[cross_down, "signal"] = -1

        return df
