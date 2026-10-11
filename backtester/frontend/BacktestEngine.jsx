import { useState, useCallback, useMemo, useRef } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, ComposedChart, Scatter
} from "recharts";

// ─────────────────────────────────────────────
// SYNTHETIC DATA GENERATOR (replaces yfinance)
// Generates realistic OHLCV with GBM + mean reversion
// ─────────────────────────────────────────────
function generateOHLCV(ticker, startDate, endDate, seed = 42) {
  const seeds = { AAPL: 42, MSFT: 137, TSLA: 999, SPY: 7, AMZN: 256, GOOGL: 512 };
  let s = seeds[ticker] ?? seed;
  const rng = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
  const randn = () => { const u = 1 - rng(); const v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const params = {
    AAPL: { S0: 150, mu: 0.00045, sigma: 0.018 },
    MSFT: { S0: 280, mu: 0.00042, sigma: 0.016 },
    TSLA: { S0: 200, mu: 0.00060, sigma: 0.035 },
    SPY:  { S0: 400, mu: 0.00035, sigma: 0.011 },
    AMZN: { S0: 120, mu: 0.00048, sigma: 0.020 },
    GOOGL:{ S0: 130, mu: 0.00044, sigma: 0.017 },
  };
  const { S0 = 100, mu = 0.0004, sigma = 0.018 } = params[ticker] ?? {};

  let price = S0;
  return days.map((date, i) => {
    const ret = mu + sigma * randn();
    price = price * Math.exp(ret);
    const range = price * sigma * (0.5 + rng() * 1.5);
    const open  = price * (1 + (rng() - 0.5) * 0.005);
    const high  = Math.max(open, price) + range * rng() * 0.5;
    const low   = Math.min(open, price) - range * rng() * 0.5;
    const volume = Math.floor(1e6 * (5 + randn() * 2));
    return {
      date: date.toISOString().split("T")[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low:  +Math.max(low, 0.01).toFixed(2),
      close: +price.toFixed(2),
      volume: Math.max(volume, 100000),
    };
  });
}

// ─────────────────────────────────────────────
// INDICATOR LIBRARY
// ─────────────────────────────────────────────
const Indicators = {
  sma(closes, period) {
    return closes.map((_, i) => {
      if (i < period - 1) return null;
      const slice = closes.slice(i - period + 1, i + 1);
      return slice.reduce((a, b) => a + b, 0) / period;
    });
  },

  ema(closes, period) {
    const k = 2 / (period + 1);
    const result = new Array(closes.length).fill(null);
    let emaPrev = null;
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { result[i] = null; continue; }
      if (i === period - 1) {
        emaPrev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result[i] = emaPrev; continue;
      }
      emaPrev = closes[i] * k + emaPrev * (1 - k);
      result[i] = emaPrev;
    }
    return result;
  },

  // Wilder's RSI (true implementation)
  rsi(closes, period = 14) {
    const result = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return result;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= period; avgLoss /= period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? Math.abs(d) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs2);
    }
    return result;
  },

  // Bollinger Bands: SMA(n) ± k * std(n)
  bollingerBands(closes, period = 20, k = 2) {
    return closes.map((_, i) => {
      if (i < period - 1) return { mid: null, upper: null, lower: null };
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const std = Math.sqrt(variance);
      return { mid: mean, upper: mean + k * std, lower: mean - k * std };
    });
  },
};

// ─────────────────────────────────────────────
// STRATEGY IMPLEMENTATIONS
// Signal returned: 1 = buy, -1 = sell, 0 = hold
// Signals on bar N → execute at bar N+1 open (no look-ahead)
// ─────────────────────────────────────────────
const Strategies = {
  ma_crossover(bars, params) {
    const closes = bars.map(b => b.close);
    const { fastPeriod = 10, slowPeriod = 30, maType = "SMA" } = params;
    const fast = maType === "EMA" ? Indicators.ema(closes, fastPeriod) : Indicators.sma(closes, fastPeriod);
    const slow = maType === "EMA" ? Indicators.ema(closes, slowPeriod) : Indicators.sma(closes, slowPeriod);
    const signals = new Array(bars.length).fill(0);
    let prevCross = null;
    for (let i = 1; i < bars.length; i++) {
      if (fast[i] === null || slow[i] === null) continue;
      const cross = fast[i] > slow[i] ? 1 : -1;
      if (prevCross !== null && cross !== prevCross) signals[i] = cross;
      prevCross = cross;
    }
    return { signals, indicators: { fast, slow } };
  },

  momentum(bars, params) {
    const closes = bars.map(b => b.close);
    const { rsiPeriod = 14, oversold = 30, overbought = 70 } = params;
    const rsiVals = Indicators.rsi(closes, rsiPeriod);
    const signals = new Array(bars.length).fill(0);
    for (let i = 1; i < bars.length; i++) {
      if (rsiVals[i] === null || rsiVals[i - 1] === null) continue;
      if (rsiVals[i - 1] <= oversold && rsiVals[i] > oversold) signals[i] = 1;
      if (rsiVals[i - 1] >= overbought && rsiVals[i] < overbought) signals[i] = -1;
    }
    return { signals, indicators: { rsi: rsiVals } };
  },

  mean_reversion(bars, params) {
    const closes = bars.map(b => b.close);
    const { bbPeriod = 20, bbK = 2 } = params;
    const bands = Indicators.bollingerBands(closes, bbPeriod, bbK);
    const signals = new Array(bars.length).fill(0);
    for (let i = 1; i < bars.length; i++) {
      const b = bands[i]; const bp = bands[i - 1];
      if (!b.upper || !bp.upper) continue;
      // Buy when price crosses back above lower band; sell when crosses back below upper
      if (closes[i - 1] < bp.lower && closes[i] >= b.lower) signals[i] = 1;
      if (closes[i - 1] > bp.upper && closes[i] <= b.upper) signals[i] = -1;
    }
    return { signals, indicators: { bands } };
  },
};

// ─────────────────────────────────────────────
// BACKTEST ENGINE — bar-by-bar simulation
// ─────────────────────────────────────────────
function runBacktest(bars, strategyName, strategyParams, engineParams) {
  const {
    initialCapital = 10000,
    commissionPct = 0,        // % of trade value
    slippagePct = 0.001,      // 0.1% per trade
    positionSizePct = 1.0,    // fraction of portfolio per trade
    riskFreeRate = 0,         // annual
  } = engineParams;

  const { signals, indicators } = Strategies[strategyName](bars, strategyParams);

  let cash = initialCapital;
  let shares = 0;
  let inPosition = false;
  const trades = [];
  const equity = [];
  let entryPrice = 0, entryDate = "";

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // Execute signal from previous bar at today's open
    const sig = i > 0 ? signals[i - 1] : 0;
    const execPrice = bar.open;

    if (sig === 1 && !inPosition) {
      // BUY
      const slip = execPrice * slippagePct;
      const fillPrice = execPrice + slip;
      const portfolioVal = cash + shares * execPrice;
      const invest = portfolioVal * positionSizePct;
      shares = Math.floor(invest / fillPrice);
      if (shares > 0) {
        const cost = shares * fillPrice;
        const commission = cost * commissionPct;
        cash -= cost + commission;
        inPosition = true;
        entryPrice = fillPrice;
        entryDate = bar.date;
      }
    } else if (sig === -1 && inPosition) {
      // SELL
      const slip = execPrice * slippagePct;
      const fillPrice = execPrice - slip;
      const proceeds = shares * fillPrice;
      const commission = proceeds * commissionPct;
      cash += proceeds - commission;
      const pnl = (fillPrice - entryPrice) * shares - commission;
      const pnlPct = (fillPrice - entryPrice) / entryPrice;
      trades.push({
        entryDate, exitDate: bar.date,
        entryPrice: +entryPrice.toFixed(2),
        exitPrice: +fillPrice.toFixed(2),
        shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(4),
        barIndex: i,
      });
      shares = 0;
      inPosition = false;
    }

    const portfolioVal = cash + shares * bar.close;
    equity.push({
      date: bar.date,
      value: +portfolioVal.toFixed(2),
      close: bar.close,
      signal: signals[i],
    });
  }

  // Close open position at last bar
  if (inPosition && shares > 0) {
    const lastBar = bars[bars.length - 1];
    const fillPrice = lastBar.close * (1 - slippagePct);
    const proceeds = shares * fillPrice;
    cash += proceeds;
    const pnl = (fillPrice - entryPrice) * shares;
    trades.push({
      entryDate, exitDate: lastBar.date,
      entryPrice: +entryPrice.toFixed(2),
      exitPrice: +fillPrice.toFixed(2),
      shares, pnl: +pnl.toFixed(2),
      pnlPct: +((fillPrice - entryPrice) / entryPrice).toFixed(4),
      open: true,
    });
  }

  return { equity, trades, indicators, signals };
}

// ─────────────────────────────────────────────
// METRICS CALCULATOR
// ─────────────────────────────────────────────
function calcMetrics(equity, trades, initialCapital, riskFreeRate = 0) {
  if (!equity.length) return {};

  const values = equity.map(e => e.value);
  const endValue = values[values.length - 1];
  const nDays = equity.length;

  // Daily returns
  const dailyReturns = [];
  for (let i = 1; i < values.length; i++) {
    dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]);
  }

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
  const std = Math.sqrt(variance);

  // CAGR = (endValue/startValue)^(252/nDays) - 1
  const cagr = Math.pow(endValue / initialCapital, 252 / nDays) - 1;

  // Sharpe = (mean_daily - Rf/252) / std_daily * sqrt(252)
  const dailyRf = riskFreeRate / 252;
  const sharpe = std === 0 ? 0 : ((mean - dailyRf) / std) * Math.sqrt(252);

  // Sortino = (mean_daily - Rf/252) / downside_std * sqrt(252)
  const negReturns = dailyReturns.filter(r => r < dailyRf);
  const downsideVariance = negReturns.length
    ? negReturns.reduce((a, b) => a + (b - dailyRf) ** 2, 0) / negReturns.length
    : 0;
  const downsideStd = Math.sqrt(downsideVariance);
  const sortino = downsideStd === 0 ? 0 : ((mean - dailyRf) / downsideStd) * Math.sqrt(252);

  // Max drawdown = peak-to-trough
  let peak = values[0], maxDD = 0;
  const drawdownSeries = values.map(v => {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
    return +(dd * 100).toFixed(2);
  });

  // Trade metrics
  const winners = trades.filter(t => t.pnl > 0);
  const losers  = trades.filter(t => t.pnl <= 0);
  const grossProfit = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss   = Math.abs(losers.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossProfit / grossLoss;
  const winRate = trades.length ? winners.length / trades.length : 0;
  const avgWin = winners.length ? grossProfit / winners.length : 0;
  const avgLoss = losers.length ? grossLoss / losers.length : 0;

  // Monthly returns heatmap data
  const monthlyMap = {};
  equity.forEach((e, i) => {
    if (i === 0) return;
    const [yr, mo] = e.date.split("-");
    const key = `${yr}-${mo}`;
    if (!monthlyMap[key]) monthlyMap[key] = { start: values[i - 1], end: e.value, year: yr, month: mo };
    else monthlyMap[key].end = e.value;
  });
  const monthlyReturns = Object.entries(monthlyMap).map(([key, v]) => ({
    key, year: v.year, month: v.month,
    ret: +((v.end - v.start) / v.start * 100).toFixed(2),
  }));

  return {
    totalReturn: +((endValue / initialCapital - 1) * 100).toFixed(2),
    cagr: +(cagr * 100).toFixed(2),
    sharpe: +sharpe.toFixed(3),
    sortino: +sortino.toFixed(3),
    maxDrawdown: +(maxDD * 100).toFixed(2),
    volatility: +(std * Math.sqrt(252) * 100).toFixed(2),
    totalTrades: trades.length,
    winRate: +(winRate * 100).toFixed(1),
    profitFactor: isFinite(profitFactor) ? +profitFactor.toFixed(2) : "∞",
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    grossProfit: +grossProfit.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    endValue: +endValue.toFixed(2),
    drawdownSeries,
    monthlyReturns,
  };
}

// ─────────────────────────────────────────────
// PARSE CSV
// ─────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].toLowerCase().split(",").map(h => h.trim());
  const required = ["date", "open", "high", "low", "close", "volume"];
  const missing = required.filter(r => !headers.includes(r));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}`);
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = h === "date" ? vals[i] : parseFloat(vals[i]); });
    return row;
  }).filter(r => r.date && !isNaN(r.close)).sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────
// CHART COMPONENTS
// ─────────────────────────────────────────────
const PALETTE = { bg: "#0a0e1a", card: "#0f1629", border: "#1e2d4a", accent: "#00d4ff", green: "#00ff88", red: "#ff4466", yellow: "#ffd700", text: "#e2e8f0", muted: "#64748b" };

function MetricCard({ label, value, sub, color = PALETTE.text, up }) {
  const arrow = up === true ? "↑" : up === false ? "↓" : "";
  const arrowColor = up === true ? PALETTE.green : up === false ? PALETTE.red : "";
  return (
    <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: "16px 20px", minWidth: 140 }}>
      <div style={{ color: PALETTE.muted, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
        {arrow && <span style={{ color: arrowColor, marginRight: 4, fontSize: 16 }}>{arrow}</span>}
        {value}
      </div>
      {sub && <div style={{ color: PALETTE.muted, fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function EquityChart({ equity, initialCapital }) {
  const data = equity.map(e => ({ ...e, baseline: initialCapital }));
  const maxVal = Math.max(...equity.map(e => e.value));
  const minVal = Math.min(...equity.map(e => e.value));
  return (
    <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ color: PALETTE.text, fontWeight: 600, marginBottom: 16, fontSize: 14, letterSpacing: "0.05em" }}>EQUITY CURVE</div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
          <defs>
            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={PALETTE.accent} stopOpacity={0.3} />
              <stop offset="95%" stopColor={PALETTE.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
          <XAxis dataKey="date" tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={d => d.slice(2, 7)} interval="preserveStartEnd" />
          <YAxis tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(1)}k`} domain={["auto", "auto"]} />
          <Tooltip contentStyle={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 8, color: PALETTE.text }} formatter={(v) => [`$${v.toLocaleString()}`, "Portfolio"]} labelFormatter={l => `Date: ${l}`} />
          <ReferenceLine y={initialCapital} stroke={PALETTE.yellow} strokeDasharray="4 4" strokeOpacity={0.6} />
          <Area type="monotone" dataKey="value" stroke={PALETTE.accent} strokeWidth={2} fill="url(#eqGrad)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function DrawdownChart({ drawdownSeries, equity }) {
  const data = equity.map((e, i) => ({ date: e.date, dd: drawdownSeries[i] }));
  return (
    <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ color: PALETTE.text, fontWeight: 600, marginBottom: 16, fontSize: 14, letterSpacing: "0.05em" }}>DRAWDOWN</div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
          <defs>
            <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={PALETTE.red} stopOpacity={0.4} />
              <stop offset="95%" stopColor={PALETTE.red} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
          <XAxis dataKey="date" tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={d => d.slice(2, 7)} interval="preserveStartEnd" />
          <YAxis tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={v => `${v.toFixed(1)}%`} />
          <Tooltip contentStyle={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 8, color: PALETTE.text }} formatter={(v) => [`${v.toFixed(2)}%`, "Drawdown"]} />
          <ReferenceLine y={0} stroke={PALETTE.muted} />
          <Area type="monotone" dataKey="dd" stroke={PALETTE.red} strokeWidth={1.5} fill="url(#ddGrad)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function PriceChart({ bars, trades, indicators, strategy, params }) {
  const closes = bars.map(b => b.close);
  const step = Math.max(1, Math.floor(bars.length / 300));
  const sampled = bars.filter((_, i) => i % step === 0);

  const data = sampled.map((bar, si) => {
    const i = si * step;
    const row = { date: bar.date, close: bar.close };
    if (strategy === "ma_crossover") {
      row.fast = indicators.fast?.[i] ? +indicators.fast[i].toFixed(2) : null;
      row.slow = indicators.slow?.[i] ? +indicators.slow[i].toFixed(2) : null;
    }
    if (strategy === "momentum") {
      row.rsi = indicators.rsi?.[i] ? +indicators.rsi[i].toFixed(2) : null;
    }
    if (strategy === "mean_reversion") {
      row.upper = indicators.bands?.[i]?.upper ? +indicators.bands[i].upper.toFixed(2) : null;
      row.mid   = indicators.bands?.[i]?.mid   ? +indicators.bands[i].mid.toFixed(2) : null;
      row.lower = indicators.bands?.[i]?.lower ? +indicators.bands[i].lower.toFixed(2) : null;
    }
    return row;
  });

  const buyDots = trades.map(t => ({ date: t.entryDate, price: t.entryPrice }));
  const sellDots = trades.map(t => ({ date: t.exitDate, price: t.exitPrice }));

  // For RSI — separate chart
  if (strategy === "momentum") {
    return (
      <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ color: PALETTE.text, fontWeight: 600, marginBottom: 8, fontSize: 14, letterSpacing: "0.05em" }}>PRICE + RSI</div>
        <ResponsiveContainer width="100%" height={150}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
            <XAxis dataKey="date" tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={d => d.slice(2, 7)} interval="preserveStartEnd" />
            <YAxis tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={v => `$${v.toFixed(0)}`} />
            <Tooltip contentStyle={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 8, color: PALETTE.text }} />
            <Line type="monotone" dataKey="close" stroke={PALETTE.text} strokeWidth={1.5} dot={false} name="Price" />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ marginTop: 12 }}>
          <ResponsiveContainer width="100%" height={100}>
            <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
              <XAxis dataKey="date" tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={d => d.slice(2, 7)} interval="preserveStartEnd" />
              <YAxis domain={[0, 100]} tick={{ fill: PALETTE.muted, fontSize: 10 }} />
              <Tooltip contentStyle={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 8, color: PALETTE.text }} />
              <ReferenceLine y={params.oversold ?? 30} stroke={PALETTE.green} strokeDasharray="3 3" strokeOpacity={0.7} />
              <ReferenceLine y={params.overbought ?? 70} stroke={PALETTE.red} strokeDasharray="3 3" strokeOpacity={0.7} />
              <Line type="monotone" dataKey="rsi" stroke={PALETTE.yellow} strokeWidth={1.5} dot={false} name="RSI" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ color: PALETTE.text, fontWeight: 600, marginBottom: 16, fontSize: 14, letterSpacing: "0.05em" }}>
        PRICE + INDICATORS + TRADES
        <span style={{ color: PALETTE.muted, fontSize: 11, marginLeft: 12 }}>
          <span style={{ color: PALETTE.green }}>▲ buy</span>&nbsp;&nbsp;<span style={{ color: PALETTE.red }}>▼ sell</span>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
          <XAxis dataKey="date" tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={d => d.slice(2, 7)} interval="preserveStartEnd" />
          <YAxis tick={{ fill: PALETTE.muted, fontSize: 10 }} tickFormatter={v => `$${v.toFixed(0)}`} />
          <Tooltip contentStyle={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 8, color: PALETTE.text }} />
          <Line type="monotone" dataKey="close" stroke={PALETTE.text} strokeWidth={1.5} dot={false} name="Price" />
          {strategy === "ma_crossover" && <>
            <Line type="monotone" dataKey="fast" stroke={PALETTE.accent} strokeWidth={1.5} dot={false} name="Fast MA" connectNulls />
            <Line type="monotone" dataKey="slow" stroke={PALETTE.yellow} strokeWidth={1.5} dot={false} name="Slow MA" connectNulls />
          </>}
          {strategy === "mean_reversion" && <>
            <Line type="monotone" dataKey="upper" stroke={PALETTE.red} strokeWidth={1} dot={false} name="Upper BB" strokeDasharray="4 2" connectNulls />
            <Line type="monotone" dataKey="mid"   stroke={PALETTE.yellow} strokeWidth={1} dot={false} name="Mid BB" connectNulls />
            <Line type="monotone" dataKey="lower" stroke={PALETTE.green} strokeWidth={1} dot={false} name="Lower BB" strokeDasharray="4 2" connectNulls />
          </>}
          {trades.flatMap((t, ti) => [
            <ReferenceLine key={`b${ti}`} x={t.entryDate} stroke={PALETTE.green} strokeWidth={1} strokeOpacity={0.5} />,
            <ReferenceLine key={`s${ti}`} x={t.exitDate} stroke={PALETTE.red} strokeWidth={1} strokeOpacity={0.5} />,
          ])}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function MonthlyHeatmap({ monthlyReturns }) {
  if (!monthlyReturns.length) return null;
  const years = [...new Set(monthlyReturns.map(r => r.year))].sort();
  const maxAbs = Math.max(...monthlyReturns.map(r => Math.abs(r.ret)), 1);
  const getColor = (ret) => {
    if (ret === undefined || ret === null) return "#1a2236";
    const t = Math.min(Math.abs(ret) / maxAbs, 1);
    if (ret >= 0) return `rgba(0,255,136,${0.15 + t * 0.7})`;
    return `rgba(255,68,102,${0.15 + t * 0.7})`;
  };
  const retMap = {};
  monthlyReturns.forEach(r => { retMap[`${r.year}-${r.month}`] = r.ret; });
  return (
    <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ color: PALETTE.text, fontWeight: 600, marginBottom: 16, fontSize: 14, letterSpacing: "0.05em" }}>MONTHLY RETURNS HEATMAP</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 4, width: "100%" }}>
          <thead>
            <tr>
              <td style={{ color: PALETTE.muted, fontSize: 11, paddingRight: 8, paddingBottom: 6 }}>Year</td>
              {MONTH_NAMES.map(m => <td key={m} style={{ color: PALETTE.muted, fontSize: 10, textAlign: "center", paddingBottom: 6 }}>{m}</td>)}
              <td style={{ color: PALETTE.muted, fontSize: 10, paddingLeft: 8 }}>Annual</td>
            </tr>
          </thead>
          <tbody>
            {years.map(yr => {
              const annual = monthlyReturns.filter(r => r.year === yr).reduce((a, r) => a * (1 + r.ret / 100), 1) - 1;
              return (
                <tr key={yr}>
                  <td style={{ color: PALETTE.muted, fontSize: 11, paddingRight: 8 }}>{yr}</td>
                  {Array.from({ length: 12 }, (_, mi) => {
                    const moStr = String(mi + 1).padStart(2, "0");
                    const key = `${yr}-${moStr}`;
                    const ret = retMap[key];
                    return (
                      <td key={mi} title={ret !== undefined ? `${ret > 0 ? "+" : ""}${ret}%` : "N/A"}
                        style={{ background: getColor(ret), borderRadius: 4, textAlign: "center", padding: "5px 3px", fontSize: 9, color: PALETTE.text, minWidth: 36, cursor: "default" }}>
                        {ret !== undefined ? `${ret > 0 ? "+" : ""}${ret.toFixed(1)}` : ""}
                      </td>
                    );
                  })}
                  <td style={{ color: annual >= 0 ? PALETTE.green : PALETTE.red, fontSize: 11, paddingLeft: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                    {annual >= 0 ? "+" : ""}{(annual * 100).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TradeLog({ trades }) {
  const [page, setPage] = useState(0);
  const PER_PAGE = 8;
  const total = Math.ceil(trades.length / PER_PAGE);
  const shown = trades.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  return (
    <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ color: PALETTE.text, fontWeight: 600, marginBottom: 16, fontSize: 14, letterSpacing: "0.05em" }}>TRADE LOG <span style={{ color: PALETTE.muted, fontWeight: 400 }}>({trades.length} trades)</span></div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{["Entry Date","Exit Date","Entry $","Exit $","Shares","P&L","Return"].map(h =>
            <th key={h} style={{ color: PALETTE.muted, textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${PALETTE.border}`, fontWeight: 500 }}>{h}</th>
          )}</tr>
        </thead>
        <tbody>
          {shown.map((t, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${PALETTE.border}20` }}>
              <td style={{ padding: "6px 8px", color: PALETTE.muted, fontFamily: "monospace" }}>{t.entryDate}</td>
              <td style={{ padding: "6px 8px", color: PALETTE.muted, fontFamily: "monospace" }}>{t.exitDate}</td>
              <td style={{ padding: "6px 8px", color: PALETTE.text, fontFamily: "monospace" }}>${t.entryPrice}</td>
              <td style={{ padding: "6px 8px", color: PALETTE.text, fontFamily: "monospace" }}>${t.exitPrice}</td>
              <td style={{ padding: "6px 8px", color: PALETTE.muted }}>{t.shares}</td>
              <td style={{ padding: "6px 8px", color: t.pnl >= 0 ? PALETTE.green : PALETTE.red, fontFamily: "monospace" }}>
                {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
              </td>
              <td style={{ padding: "6px 8px", color: t.pnlPct >= 0 ? PALETTE.green : PALETTE.red, fontFamily: "monospace" }}>
                {(t.pnlPct * 100).toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ background: "transparent", border: `1px solid ${PALETTE.border}`, color: PALETTE.muted, borderRadius: 6, padding: "4px 12px", cursor: page === 0 ? "default" : "pointer" }}>←</button>
          <span style={{ color: PALETTE.muted, fontSize: 12 }}>Page {page + 1} / {total}</span>
          <button onClick={() => setPage(p => Math.min(total - 1, p + 1))} disabled={page === total - 1}
            style={{ background: "transparent", border: `1px solid ${PALETTE.border}`, color: PALETTE.muted, borderRadius: 6, padding: "4px 12px", cursor: page === total - 1 ? "default" : "pointer" }}>→</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// STRATEGY PARAMETER PANELS
// ─────────────────────────────────────────────
function ParamSlider({ label, value, min, max, step = 1, onChange }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: PALETTE.muted, fontSize: 12 }}>{label}</span>
        <span style={{ color: PALETTE.accent, fontSize: 12, fontFamily: "monospace" }}>{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: PALETTE.accent }} />
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
const TICKERS = ["AAPL", "MSFT", "TSLA", "SPY", "AMZN", "GOOGL"];
const STRATEGIES = [
  { id: "ma_crossover", label: "Moving Average Crossover" },
  { id: "momentum", label: "RSI Momentum" },
  { id: "mean_reversion", label: "Bollinger Mean Reversion" },
];

export default function App() {
  const [ticker, setTicker] = useState("AAPL");
  const [startDate, setStartDate] = useState("2020-01-01");
  const [endDate, setEndDate] = useState("2024-01-01");
  const [strategy, setStrategy] = useState("ma_crossover");
  const [initialCapital, setInitialCapital] = useState(10000);
  const [commissionPct, setCommissionPct] = useState(0);
  const [slippagePct, setSlippagePct] = useState(0.001);
  const [positionSizePct, setPositionSizePct] = useState(1.0);
  const [maParams, setMaParams] = useState({ fastPeriod: 10, slowPeriod: 30, maType: "SMA" });
  const [momParams, setMomParams] = useState({ rsiPeriod: 14, oversold: 30, overbought: 70 });
  const [mrParams, setMrParams] = useState({ bbPeriod: 20, bbK: 2 });
  const [csvData, setCsvData] = useState(null);
  const [csvName, setCsvName] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dataSource, setDataSource] = useState("synthetic");
  const fileRef = useRef();

  const activeParams = strategy === "ma_crossover" ? maParams : strategy === "momentum" ? momParams : mrParams;

  const handleCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseCSV(ev.target.result);
        setCsvData(parsed);
        setCsvName(file.name);
        setDataSource("csv");
        setError("");
      } catch (err) { setError(`CSV Error: ${err.message}`); }
    };
    reader.readAsText(file);
  };

  const runBacktestHandler = useCallback(() => {
    setLoading(true);
    setError("");
    setTimeout(() => {
      try {
        let bars;
        if (dataSource === "csv" && csvData) {
          bars = csvData.filter(b => b.date >= startDate && b.date <= endDate);
        } else {
          bars = generateOHLCV(ticker, startDate, endDate);
        }
        if (bars.length < 50) { setError("Not enough data — try a longer date range."); setLoading(false); return; }

        const engineParams = { initialCapital, commissionPct, slippagePct, positionSizePct };
        const { equity, trades, indicators, signals } = runBacktest(bars, strategy, activeParams, engineParams);
        const metrics = calcMetrics(equity, trades, initialCapital);
        setResults({ bars, equity, trades, indicators, metrics, signals });
      } catch (err) { setError(`Engine error: ${err.message}`); }
      setLoading(false);
    }, 50);
  }, [ticker, startDate, endDate, strategy, activeParams, initialCapital, commissionPct, slippagePct, positionSizePct, dataSource, csvData]);

  const S = (obj, key, val) => {
    const setters = { ma_crossover: setMaParams, momentum: setMomParams, mean_reversion: setMrParams };
    setters[strategy](prev => ({ ...prev, [key]: val }));
  };

  return (
    <div style={{ background: PALETTE.bg, minHeight: "100vh", color: PALETTE.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${PALETTE.border}`, padding: "16px 32px", display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.accent, boxShadow: `0 0 12px ${PALETTE.accent}` }} />
        <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "0.1em", textTransform: "uppercase" }}>AlgoBacktest</span>
        <span style={{ color: PALETTE.muted, fontSize: 12, marginLeft: 4 }}>v1.0 — Algorithmic Trading Engine</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 0, minHeight: "calc(100vh - 57px)" }}>
        {/* LEFT PANEL */}
        <div style={{ borderRight: `1px solid ${PALETTE.border}`, padding: 24, overflowY: "auto" }}>

          {/* Data Source */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ color: PALETTE.muted, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Data Source</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {[["synthetic", "Simulated"], ["csv", "CSV Upload"]].map(([v, l]) => (
                <button key={v} onClick={() => setDataSource(v)}
                  style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${dataSource === v ? PALETTE.accent : PALETTE.border}`, background: dataSource === v ? `${PALETTE.accent}15` : "transparent", color: dataSource === v ? PALETTE.accent : PALETTE.muted, fontSize: 12, cursor: "pointer", transition: "all 0.15s" }}>
                  {l}
                </button>
              ))}
            </div>
            {dataSource === "csv" ? (
              <div>
                <input ref={fileRef} type="file" accept=".csv" onChange={handleCSV} style={{ display: "none" }} />
                <button onClick={() => fileRef.current.click()}
                  style={{ width: "100%", padding: "10px", borderRadius: 8, border: `1px dashed ${PALETTE.border}`, background: "transparent", color: PALETTE.muted, fontSize: 12, cursor: "pointer" }}>
                  {csvName || "Click to upload CSV (date,open,high,low,close,volume)"}
                </button>
              </div>
            ) : (
              <div>
                <div style={{ color: PALETTE.muted, fontSize: 11, marginBottom: 6 }}>Ticker</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {TICKERS.map(t => (
                    <button key={t} onClick={() => setTicker(t)}
                      style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${ticker === t ? PALETTE.accent : PALETTE.border}`, background: ticker === t ? `${PALETTE.accent}15` : "transparent", color: ticker === t ? PALETTE.accent : PALETTE.muted, fontSize: 12, cursor: "pointer", fontFamily: "monospace" }}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Date Range */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ color: PALETTE.muted, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Date Range</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[["Start", startDate, setStartDate], ["End", endDate, setEndDate]].map(([label, val, setter]) => (
                <div key={label}>
                  <div style={{ color: PALETTE.muted, fontSize: 11, marginBottom: 4 }}>{label}</div>
                  <input type="date" value={val} onChange={e => setter(e.target.value)}
                    style={{ width: "100%", background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 8, padding: "8px 10px", color: PALETTE.text, fontSize: 12, boxSizing: "border-box" }} />
                </div>
              ))}
            </div>
          </div>

          {/* Strategy */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ color: PALETTE.muted, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Strategy</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {STRATEGIES.map(s => (
                <button key={s.id} onClick={() => setStrategy(s.id)}
                  style={{ padding: "10px 14px", borderRadius: 8, border: `1px solid ${strategy === s.id ? PALETTE.accent : PALETTE.border}`, background: strategy === s.id ? `${PALETTE.accent}15` : "transparent", color: strategy === s.id ? PALETTE.accent : PALETTE.muted, fontSize: 12, cursor: "pointer", textAlign: "left", transition: "all 0.15s" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Strategy Params */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ color: PALETTE.muted, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Strategy Parameters</div>
            {strategy === "ma_crossover" && <>
              <ParamSlider label="Fast Period" value={maParams.fastPeriod} min={2} max={50} onChange={v => setMaParams(p => ({ ...p, fastPeriod: v }))} />
              <ParamSlider label="Slow Period" value={maParams.slowPeriod} min={5} max={200} onChange={v => setMaParams(p => ({ ...p, slowPeriod: v }))} />
              <div style={{ marginBottom: 14 }}>
                <div style={{ color: PALETTE.muted, fontSize: 12, marginBottom: 6 }}>MA Type</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {["SMA", "EMA"].map(t => (
                    <button key={t} onClick={() => setMaParams(p => ({ ...p, maType: t }))}
                      style={{ flex: 1, padding: "6px", borderRadius: 6, border: `1px solid ${maParams.maType === t ? PALETTE.accent : PALETTE.border}`, background: maParams.maType === t ? `${PALETTE.accent}15` : "transparent", color: maParams.maType === t ? PALETTE.accent : PALETTE.muted, fontSize: 12, cursor: "pointer" }}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </>}
            {strategy === "momentum" && <>
              <ParamSlider label="RSI Period" value={momParams.rsiPeriod} min={2} max={50} onChange={v => setMomParams(p => ({ ...p, rsiPeriod: v }))} />
              <ParamSlider label="Oversold Level" value={momParams.oversold} min={5} max={45} onChange={v => setMomParams(p => ({ ...p, oversold: v }))} />
              <ParamSlider label="Overbought Level" value={momParams.overbought} min={55} max={95} onChange={v => setMomParams(p => ({ ...p, overbought: v }))} />
            </>}
            {strategy === "mean_reversion" && <>
              <ParamSlider label="BB Period" value={mrParams.bbPeriod} min={5} max={100} onChange={v => setMrParams(p => ({ ...p, bbPeriod: v }))} />
              <ParamSlider label={`BB Width (k = ${mrParams.bbK})`} value={mrParams.bbK} min={0.5} max={4} step={0.1} onChange={v => setMrParams(p => ({ ...p, bbK: v }))} />
            </>}
          </div>

          {/* Engine Params */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ color: PALETTE.muted, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Simulation</div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: PALETTE.muted, fontSize: 12 }}>Initial Capital</span>
                <span style={{ color: PALETTE.accent, fontSize: 12, fontFamily: "monospace" }}>${initialCapital.toLocaleString()}</span>
              </div>
              <input type="range" min={1000} max={100000} step={1000} value={initialCapital}
                onChange={e => setInitialCapital(Number(e.target.value))}
                style={{ width: "100%", accentColor: PALETTE.accent }} />
            </div>
            <ParamSlider label={`Commission (${(commissionPct * 100).toFixed(2)}%)`} value={commissionPct} min={0} max={0.01} step={0.0001} onChange={v => setCommissionPct(v)} />
            <ParamSlider label={`Slippage (${(slippagePct * 100).toFixed(2)}%)`} value={slippagePct} min={0} max={0.005} step={0.0001} onChange={v => setSlippagePct(v)} />
            <ParamSlider label={`Position Size (${(positionSizePct * 100).toFixed(0)}%)`} value={positionSizePct} min={0.1} max={1} step={0.05} onChange={v => setPositionSizePct(v)} />
          </div>

          {/* Run Button */}
          <button onClick={runBacktestHandler} disabled={loading}
            style={{ width: "100%", padding: "14px", borderRadius: 10, border: "none", background: loading ? PALETTE.border : PALETTE.accent, color: loading ? PALETTE.muted : "#000", fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer", letterSpacing: "0.05em", transition: "all 0.2s", boxShadow: loading ? "none" : `0 0 24px ${PALETTE.accent}40` }}>
            {loading ? "RUNNING..." : "▶  RUN BACKTEST"}
          </button>
          {error && <div style={{ color: PALETTE.red, fontSize: 12, marginTop: 10, padding: "8px 12px", background: `${PALETTE.red}10`, borderRadius: 8, border: `1px solid ${PALETTE.red}30` }}>{error}</div>}
        </div>

        {/* RIGHT PANEL */}
        <div style={{ padding: 24, overflowY: "auto" }}>
          {!results ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16 }}>
              <div style={{ width: 80, height: 80, borderRadius: "50%", border: `2px solid ${PALETTE.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>📈</div>
              <div style={{ color: PALETTE.muted, fontSize: 14 }}>Configure your strategy and run a backtest</div>
              <div style={{ color: PALETTE.border, fontSize: 12 }}>Sharpe • Sortino • CAGR • Max Drawdown • Monthly Heatmap</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Key Metrics Row */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                <MetricCard label="Total Return" value={`${results.metrics.totalReturn > 0 ? "+" : ""}${results.metrics.totalReturn}%`} color={results.metrics.totalReturn >= 0 ? PALETTE.green : PALETTE.red} up={results.metrics.totalReturn >= 0} />
                <MetricCard label="CAGR" value={`${results.metrics.cagr > 0 ? "+" : ""}${results.metrics.cagr}%`} color={results.metrics.cagr >= 0 ? PALETTE.green : PALETTE.red} up={results.metrics.cagr >= 0} />
                <MetricCard label="Sharpe Ratio" value={results.metrics.sharpe} color={results.metrics.sharpe >= 1 ? PALETTE.green : results.metrics.sharpe >= 0 ? PALETTE.yellow : PALETTE.red} sub="annualized" />
                <MetricCard label="Sortino Ratio" value={results.metrics.sortino} color={results.metrics.sortino >= 1 ? PALETTE.green : results.metrics.sortino >= 0 ? PALETTE.yellow : PALETTE.red} sub="downside only" />
                <MetricCard label="Max Drawdown" value={`${results.metrics.maxDrawdown}%`} color={PALETTE.red} up={false} />
                <MetricCard label="Volatility" value={`${results.metrics.volatility}%`} sub="annualized" />
                <MetricCard label="Win Rate" value={`${results.metrics.winRate}%`} color={results.metrics.winRate >= 50 ? PALETTE.green : PALETTE.yellow} sub={`${results.metrics.totalTrades} trades`} />
                <MetricCard label="Profit Factor" value={results.metrics.profitFactor} color={results.metrics.profitFactor >= 1.5 ? PALETTE.green : results.metrics.profitFactor >= 1 ? PALETTE.yellow : PALETTE.red} />
                <MetricCard label="End Value" value={`$${results.metrics.endValue.toLocaleString()}`} sub={`from $${initialCapital.toLocaleString()}`} color={results.metrics.endValue >= initialCapital ? PALETTE.green : PALETTE.red} />
              </div>

              {/* Charts */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <EquityChart equity={results.equity} initialCapital={initialCapital} />
                <DrawdownChart drawdownSeries={results.metrics.drawdownSeries} equity={results.equity} />
              </div>
              <PriceChart bars={results.bars} trades={results.trades} indicators={results.indicators} strategy={strategy} params={activeParams} />
              <MonthlyHeatmap monthlyReturns={results.metrics.monthlyReturns} />
              {results.trades.length > 0 && <TradeLog trades={results.trades} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
