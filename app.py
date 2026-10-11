# app.py
# ─────────────────────────────────────────────────────────────
# Flask dashboard — serves backtest results as an interactive
# web page at http://127.0.0.1:5000
#
# Routes:
#   GET  /              → dashboard with metrics + embedded charts
#   GET  /api/metrics   → JSON metrics payload
#   GET  /api/equity    → JSON equity curve data
#   GET  /api/trades    → JSON trade log
#   GET  /charts/<file> → serve saved PNG from results/
# ─────────────────────────────────────────────────────────────
from __future__ import annotations
import os
import json
from flask import Flask, render_template, jsonify, send_from_directory

from engine  import EngineResult
from config  import RESULTS_DIR


def create_app(result: EngineResult, metrics: dict) -> Flask:
    """
    Factory function — binds the backtest result into the app context
    so that routes can access it via closure.
    """
    app = Flask(__name__, template_folder="templates")

    @app.route("/")
    def dashboard():
        m = metrics
        # Format metrics for template display
        ctx = {
            "ticker":          result.ticker,
            "strategy":        result.strategy_name,
            "initial_capital": result.initial_capital,
            "metrics":         m,
            "n_bars":          len(result.equity),
            "start":           str(result.equity.index[0].date()),
            "end":             str(result.equity.index[-1].date()),
            "n_trades":        len(result.trades),
            "chart_files":     _list_charts(result.ticker),
            "trades":          _format_trades(result.trades),
        }
        return render_template("dashboard.html", **ctx)

    @app.route("/api/metrics")
    def api_metrics():
        safe = {k: (v if isinstance(v, (int, str, bool)) or
                    (isinstance(v, float) and v == v and abs(v) < 1e15)
                    else str(v))
                for k, v in metrics.items()}
        return jsonify(safe)

    @app.route("/api/equity")
    def api_equity():
        eq = result.equity.reset_index()
        eq["date"] = eq["date"].astype(str)
        return jsonify(eq[["date", "value", "drawdown"]].to_dict(orient="records"))

    @app.route("/api/trades")
    def api_trades():
        return jsonify(_format_trades(result.trades))

    @app.route("/charts/<path:filename>")
    def serve_chart(filename):
        return send_from_directory(os.path.abspath(RESULTS_DIR), filename)

    return app


def _list_charts(ticker: str) -> list[str]:
    if not os.path.isdir(RESULTS_DIR):
        return []
    return [
        f for f in sorted(os.listdir(RESULTS_DIR))
        if f.startswith(ticker) and f.endswith(".png")
    ]


def _format_trades(trades) -> list[dict]:
    return [
        {
            "entry_date":  t.entry_date,
            "exit_date":   t.exit_date,
            "entry_price": round(t.entry_price, 4),
            "exit_price":  round(t.exit_price,  4),
            "shares":      round(t.shares,       4),
            "pnl":         round(t.pnl,          2),
            "pnl_pct":     round(t.pnl_pct * 100, 2),
            "commission":  round(t.commission,    2),
            "is_open":     t.is_open,
        }
        for t in trades
    ]
