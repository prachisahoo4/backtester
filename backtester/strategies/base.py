# strategies/base.py
# ─────────────────────────────────────────────────────────────
# Abstract base class all strategies must inherit from.
# Each strategy receives a clean OHLCV DataFrame and returns
# a DataFrame with an added `signal` column:
#   +1  = go long  (buy signal at this bar's close)
#   -1  = go flat  (sell signal at this bar's close)
#    0  = hold current position
#
# Signals are computed on bar N and EXECUTED at bar N+1's open
# price by the engine — enforcing strict no-look-ahead bias.
# ─────────────────────────────────────────────────────────────
from abc import ABC, abstractmethod
import pandas as pd


class BaseStrategy(ABC):
    """
    All concrete strategies must implement `generate_signals`.
    They should also expose a `params` dict for display and logging.
    """

    name: str = "BaseStrategy"

    @abstractmethod
    def generate_signals(self, data: pd.DataFrame) -> pd.DataFrame:
        """
        Parameters
        ----------
        data : pd.DataFrame
            OHLCV DataFrame with columns [open, high, low, close, volume].

        Returns
        -------
        pd.DataFrame
            Same DataFrame with additional indicator columns and a
            `signal` column containing -1, 0, or +1.
        """
        ...

    @property
    @abstractmethod
    def params(self) -> dict:
        """Return strategy parameters as a plain dict (for logging/display)."""
        ...

    def __repr__(self):
        param_str = ", ".join(f"{k}={v}" for k, v in self.params.items())
        return f"{self.name}({param_str})"
