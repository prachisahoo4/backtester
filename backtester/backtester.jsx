import { useState, useCallback, useMemo, useRef } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell, ScatterChart, Scatter
} from "recharts";

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
const fmt = (n, d = 2) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : "—");
const fmtPct = (n) => (typeof n === "number" && isFinite(n) ? (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%" : "—");
const fmtDollar = (n) => (typeof n === "number" && isFinite(n) ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",").map(v => v.trim().replace(/"/g, ""));
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    const dateKey = headers.find(h => h.includes("date") || h === "timestamp");
    const closeKey = headers.find(h => h.includes("close") || h.includes("price") || h.includes("adj"));
    const openKey = headers.find(h => h.includes("open"));
    const highKey = headers.find(h => h.includes("high"));
    const lowKey = headers.find(h => h.includes("low"));
    const volKey = headers.find(h => h.includes("vol"));
    if (!dateKey || !closeKey) continue;
    const close = parseFloat(row[closeKey]);
    if (isNaN(close)) continue;
    rows.push({
      date: row[dateKey],
      open: parseFloat(row[openKey]) || close,
      high: parseFloat(row[highKey]) || close,
      low: parseFloat(row[lowKey]) || close,
      close,
      volume: parseFloat(row[volKey]) || 0,
    });
  }
  return rows.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ─────────────────────────────────────────────
// INDICATORS
// ─────────────────────────────────────────────
function sma(prices, period) {
  return prices.map((_, i) => {
    if (i < period - 1) return null;
    const slice = prices.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function ema(prices, period) {
  const k = 2 / (period + 1);
  const result = new Array(prices.length).fill(null);
  let started = false;
  let prev = 0;
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { continue; }
    if (!started) {
      prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result[i] = prev;
      started = true;
    } else {
      prev = prices[i] * k + prev * (1 - k);
      result[i] = prev;
    }
  }
  return result;
}

function rsi(prices, period = 14) {
  const result = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function bollingerBands(prices, period = 20, stdDev = 2) {
  const mid = sma(prices, period);
  return prices.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null };
    const slice = prices.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return { upper: mean + stdDev * sd, mid: mean, lower: mean - stdDev * sd };
  });
}

// ─────────────────────────────────────────────
// STRATEGIES
// ─────────────────────────────────────────────
function runMACrossover(bars, params) {
  const { fastPeriod, slowPeriod, maType } = params;
  const closes = bars.map(b => b.close);
  const fast = maType === "EMA" ? ema(closes, fastPeriod) : sma(closes, fastPeriod);
  const slow = maType === "EMA" ? ema(closes, slowPeriod) : sma(closes, slowPeriod);
  const signals = bars.map((bar, i) => {
    let signal = 0;
    if (i > 0 && fast[i] !== null && slow[i] !== null && fast[i - 1] !== null && slow[i - 1] !== null) {
      if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) signal = 1;  // golden cross
      if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) signal = -1; // death cross
    }
    return { ...bar, fast: fast[i], slow: slow[i], signal };
  });
  return signals;
}

function runMomentum(bars, params) {
  const { rsiPeriod, oversold, overbought } = params;
  const closes = bars.map(b => b.close);
  const rsiVals = rsi(closes, rsiPeriod);
  const signals = bars.map((bar, i) => {
    let signal = 0;
    if (i > 0 && rsiVals[i] !== null && rsiVals[i - 1] !== null) {
      if (rsiVals[i] > oversold && rsiVals[i - 1] <= oversold) signal = 1;   // RSI crosses above oversold
      if (rsiVals[i] < overbought && rsiVals[i - 1] >= overbought) signal = -1; // RSI crosses below overbought
    }
    return { ...bar, rsi: rsiVals[i], signal };
  });
  return signals;
}

function runMeanReversion(bars, params) {
  const { bbPeriod, bbStdDev } = params;
  const closes = bars.map(b => b.close);
  const bb = bollingerBands(closes, bbPeriod, bbStdDev);
  const signals = bars.map((bar, i) => {
    let signal = 0;
    if (i > 0 && bb[i].upper !== null && bb[i - 1].upper !== null) {
      if (bar.close <= bb[i].lower && bars[i - 1].close > bb[i - 1].lower) signal = 1;   // price crosses below lower band
      if (bar.close >= bb[i].upper && bars[i - 1].close < bb[i - 1].upper) signal = -1;  // price crosses above upper band
    }
    return { ...bar, bbUpper: bb[i].upper, bbMid: bb[i].mid, bbLower: bb[i].lower, signal };
  });
  return signals;
}

// ─────────────────────────────────────────────
// BACKTEST ENGINE (bar-by-bar, no look-ahead)
// ─────────────────────────────────────────────
function runBacktest(signalBars, params) {
  const { initialCapital, positionSize, commission, slippage } = params;
  let cash = initialCapital;
  let shares = 0;
  let inPosition = false;
  let entryPrice = 0;
  let entryDate = "";
  const equity = [];
  const trades = [];
  let peak = initialCapital;
  let maxDrawdown = 0;

  for (let i = 1; i < signalBars.length; i++) {
    const bar = signalBars[i];
    const prevSignal = signalBars[i - 1].signal;
    // Execute signal from PREVIOUS bar at CURRENT bar's open (no look-ahead)
    const execPrice = bar.open * (1 + slippage / 100);
    const execPriceSell = bar.open * (1 - slippage / 100);

    if (prevSignal === 1 && !inPosition) {
      // BUY
      const allocatedCash = cash * (positionSize / 100);
      const cost = allocatedCash * (1 + commission / 100);
      if (cost <= cash) {
        shares = allocatedCash / execPrice;
        cash -= cost;
        inPosition = true;
        entryPrice = execPrice;
        entryDate = bar.date;
      }
    } else if (prevSignal === -1 && inPosition) {
      // SELL
      const proceeds = shares * execPriceSell * (1 - commission / 100);
      const pnl = proceeds - shares * entryPrice;
      const pnlPct = (execPriceSell - entryPrice) / entryPrice;
      trades.push({ entryDate, exitDate: bar.date, entryPrice, exitPrice: execPriceSell, pnl, pnlPct, shares });
      cash += proceeds;
      shares = 0;
      inPosition = false;
    }

    const portfolioValue = cash + shares * bar.close;
    if (portfolioValue > peak) peak = portfolioValue;
    const drawdown = (peak - portfolioValue) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    equity.push({ date: bar.date, value: portfolioValue, cash, drawdown, signal: bar.signal });
  }

  // Close open position at end
  if (inPosition && signalBars.length > 0) {
    const lastBar = signalBars[signalBars.length - 1];
    const proceeds = shares * lastBar.close * (1 - commission / 100);
    const pnl = proceeds - shares * entryPrice;
    const pnlPct = (lastBar.close - entryPrice) / entryPrice;
    trades.push({ entryDate, exitDate: lastBar.date, entryPrice, exitPrice: lastBar.close, pnl, pnlPct, shares, open: true });
    const finalValue = cash + proceeds;
    equity[equity.length - 1] = { ...equity[equity.length - 1], value: finalValue };
  }

  return { equity, trades, maxDrawdown };
}

// ─────────────────────────────────────────────
// METRICS
// ─────────────────────────────────────────────
function calcMetrics(equity, trades, initialCapital) {
  if (equity.length < 2) return {};
  const finalValue = equity[equity.length - 1].value;
  const totalReturn = (finalValue - initialCapital) / initialCapital;

  // Daily returns
  const dailyReturns = [];
  for (let i = 1; i < equity.length; i++) {
    dailyReturns.push((equity[i].value - equity[i - 1].value) / equity[i - 1].value);
  }

  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe Ratio — annualized, Rf = 4.5%
  const RF_DAILY = 0.045 / 252;
  const sharpe = stdDev === 0 ? 0 : ((meanReturn - RF_DAILY) / stdDev) * Math.sqrt(252);

  // Sortino — downside deviation only
  const negReturns = dailyReturns.filter(r => r < RF_DAILY);
  const downsideVariance = negReturns.reduce((a, b) => a + Math.pow(b - RF_DAILY, 2), 0) / (dailyReturns.length || 1);
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev === 0 ? 0 : ((meanReturn - RF_DAILY) / downsideDev) * Math.sqrt(252);

  // CAGR
  const nDays = equity.length;
  const cagr = Math.pow(finalValue / initialCapital, 252 / nDays) - 1;

  // Max Drawdown
  const maxDrawdown = Math.max(...equity.map(e => e.drawdown));

  // Trade stats
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? winners.length / trades.length : 0;
  const grossProfit = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;
  const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
  const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  // Calmar ratio
  const calmar = maxDrawdown === 0 ? 0 : cagr / maxDrawdown;

  // Volatility (annualized)
  const volatility = stdDev * Math.sqrt(252);

  return {
    totalReturn, cagr, sharpe, sortino, calmar, volatility,
    maxDrawdown, finalValue,
    totalTrades: trades.length, winRate, profitFactor,
    avgWin, avgLoss, expectancy, grossProfit, grossLoss,
    winners: winners.length, losers: losers.length
  };
}

// Monthly returns heatmap data
function buildMonthlyReturns(equity) {
  const monthly = {};
  for (let i = 1; i < equity.length; i++) {
    const d = new Date(equity[i].date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthly[key]) monthly[key] = { start: equity[i - 1].value, end: equity[i].value };
    else monthly[key].end = equity[i].value;
  }
  return Object.entries(monthly).map(([key, v]) => ({
    month: key,
    year: key.slice(0, 4),
    mo: key.slice(5, 7),
    ret: (v.end - v.start) / v.start,
  }));
}

// ─────────────────────────────────────────────
// SAMPLE DATA GENERATOR (fallback demo)
// ─────────────────────────────────────────────
function generateSampleData(ticker = "DEMO", days = 504) {
  const bars = [];
  let price = 150;
  const start = new Date("2022-01-03");
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ret = (Math.random() - 0.485) * 0.025;
    price = Math.max(1, price * (1 + ret));
    const high = price * (1 + Math.random() * 0.015);
    const low = price * (1 - Math.random() * 0.015);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: price * (1 + (Math.random() - 0.5) * 0.005),
      high, low, close: price,
      volume: Math.floor(Math.random() * 10000000)
    });
  }
  return bars;
}

// ─────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────
const COLORS = {
  bg: "#0a0e1a",
  surface: "#111827",
  card: "#161d2e",
  border: "#1f2d45",
  accent: "#00d4ff",
  accentDim: "#0099bb",
  green: "#00e676",
  red: "#ff3d57",
  yellow: "#ffd600",
  purple: "#a855f7",
  text: "#e2e8f0",
  muted: "#64748b",
};

const MetricCard = ({ label, value, sub, color = COLORS.text, large }) => (
  <div style={{
    background: COLORS.card, border: `1px solid ${COLORS.border}`,
    borderRadius: 12, padding: large ? "20px 24px" : "16px 20px",
    display: "flex", flexDirection: "column", gap: 4
  }}>
    <div style={{ fontSize: 11, color: COLORS.muted, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "monospace" }}>{label}</div>
    <div style={{ fontSize: large ? 28 : 22, fontWeight: 700, color, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "-0.02em" }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: COLORS.muted }}>{sub}</div>}
  </div>
);

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 32 }}>
    <div style={{ fontSize: 11, color: COLORS.accent, letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: "monospace", marginBottom: 14, paddingLeft: 2 }}>{title}</div>
    {children}
  </div>
);

const Slider = ({ label, value, min, max, step = 1, onChange, unit = "" }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
    <div style={{ width: 160, fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>{label}</div>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
      style={{ flex: 1, accentColor: COLORS.accent, height: 4, cursor: "pointer" }} />
    <div style={{ width: 60, fontSize: 13, color: COLORS.text, fontFamily: "monospace", textAlign: "right" }}>{value}{unit}</div>
  </div>
);

const Select = ({ label, value, options, onChange }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
    <div style={{ width: 160, fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>{label}</div>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, borderRadius: 6, padding: "6px 10px", fontSize: 13, fontFamily: "monospace", cursor: "pointer" }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Tabs = ({ tabs, active, onSelect }) => (
  <div style={{ display: "flex", gap: 2, background: COLORS.surface, padding: 4, borderRadius: 10, border: `1px solid ${COLORS.border}`, marginBottom: 24 }}>
    {tabs.map(t => (
      <button key={t.id} onClick={() => onSelect(t.id)} style={{
        flex: 1, padding: "8px 12px", borderRadius: 7, border: "none", cursor: "pointer",
        background: active === t.id ? COLORS.accent : "transparent",
        color: active === t.id ? "#000" : COLORS.muted,
        fontSize: 12, fontWeight: active === t.id ? 700 : 400,
        fontFamily: "monospace", letterSpacing: "0.05em", textTransform: "uppercase",
        transition: "all 0.15s"
      }}>{t.label}</button>
    ))}
  </div>
);

// ─── EQUITY CURVE CHART ───
function EquityCurveChart({ equity, initialCapital }) {
  if (!equity?.length) return null;
  const data = equity.filter((_, i) => i % Math.max(1, Math.floor(equity.length / 500)) === 0);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS.accent} stopOpacity={0.3} />
            <stop offset="95%" stopColor={COLORS.accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
        <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10, fontFamily: "monospace" }} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fill: COLORS.muted, fontSize: 10, fontFamily: "monospace" }} tickLine={false} tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} />
        <Tooltip contentStyle={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: "monospace", fontSize: 12 }}
          formatter={(v) => [fmtDollar(v), "Portfolio"]} labelStyle={{ color: COLORS.muted }} />
        <ReferenceLine y={initialCapital} stroke={COLORS.muted} strokeDasharray="4 4" />
        <Area type="monotone" dataKey="value" stroke={COLORS.accent} strokeWidth={1.5} fill="url(#eqGrad)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── DRAWDOWN CHART ───
function DrawdownChart({ equity }) {
  if (!equity?.length) return null;
  const data = equity.filter((_, i) => i % Math.max(1, Math.floor(equity.length / 500)) === 0)
    .map(e => ({ ...e, drawdownPct: -(e.drawdown * 100) }));
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS.red} stopOpacity={0.4} />
            <stop offset="95%" stopColor={COLORS.red} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
        <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10, fontFamily: "monospace" }} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fill: COLORS.muted, fontSize: 10, fontFamily: "monospace" }} tickLine={false} tickFormatter={v => v.toFixed(1) + "%"} />
        <Tooltip contentStyle={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: "monospace", fontSize: 12 }}
          formatter={(v) => [v.toFixed(2) + "%", "Drawdown"]} labelStyle={{ color: COLORS.muted }} />
        <ReferenceLine y={0} stroke={COLORS.border} />
        <Area type="monotone" dataKey="drawdownPct" stroke={COLORS.red} strokeWidth={1.5} fill="url(#ddGrad)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── PRICE CHART WITH SIGNALS ───
function PriceChart({ signalBars, strategy }) {
  if (!signalBars?.length) return null;
  const step = Math.max(1, Math.floor(signalBars.length / 400));
  const data = signalBars.filter((_, i) => i % step === 0);
  const entries = signalBars.filter(b => b.signal === 1);
  const exits = signalBars.filter(b => b.signal === -1);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
        <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10, fontFamily: "monospace" }} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fill: COLORS.muted, fontSize: 10, fontFamily: "monospace" }} tickLine={false} tickFormatter={v => "$" + v.toFixed(0)} yAxisId="price" />
        <Tooltip contentStyle={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: "monospace", fontSize: 11 }}
          formatter={(v, name) => [typeof v === "number" ? v.toFixed(2) : v, name]} labelStyle={{ color: COLORS.muted }} />
        <Line yAxisId="price" type="monotone" dataKey="close" stroke={COLORS.text} strokeWidth={1} dot={false} name="Price" />
        {strategy === "ma_crossover" && <>
          <Line yAxisId="price" type="monotone" dataKey="fast" stroke={COLORS.accent} strokeWidth={1.5} dot={false} name="Fast MA" strokeDasharray="0" />
          <Line yAxisId="price" type="monotone" dataKey="slow" stroke={COLORS.yellow} strokeWidth={1.5} dot={false} name="Slow MA" strokeDasharray="0" />
        </>}
        {strategy === "mean_reversion" && <>
          <Line yAxisId="price" type="monotone" dataKey="bbUpper" stroke={COLORS.purple} strokeWidth={1} dot={false} name="BB Upper" strokeDasharray="4 2" />
          <Line yAxisId="price" type="monotone" dataKey="bbMid" stroke={COLORS.muted} strokeWidth={1} dot={false} name="BB Mid" strokeDasharray="4 2" />
          <Line yAxisId="price" type="monotone" dataKey="bbLower" stroke={COLORS.purple} strokeWidth={1} dot={false} name="BB Lower" strokeDasharray="4 2" />
        </>}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── MONTHLY HEATMAP ───
function MonthlyHeatmap({ equity }) {
  if (!equity?.length) return null;
  const monthly = buildMonthlyReturns(equity);
  const years = [...new Set(monthly.map(m => m.year))].sort();
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const moLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lookup = {};
  monthly.forEach(m => { lookup[`${m.year}-${m.mo}`] = m.ret; });

  const cellColor = (ret) => {
    if (ret === undefined) return COLORS.surface;
    if (ret > 0.08) return "#00897b";
    if (ret > 0.04) return "#26a69a";
    if (ret > 0.01) return "#4db6ac";
    if (ret > 0) return "#80cbc4";
    if (ret > -0.01) return "#ef9a9a";
    if (ret > -0.04) return "#ef5350";
    if (ret > -0.08) return "#e53935";
    return "#b71c1c";
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 3, fontFamily: "monospace", fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ color: COLORS.muted, fontWeight: 400, padding: "2px 8px", textAlign: "left" }}>Year</th>
            {moLabels.map(m => <th key={m} style={{ color: COLORS.muted, fontWeight: 400, padding: "2px 6px", textAlign: "center", minWidth: 44 }}>{m}</th>)}
            <th style={{ color: COLORS.muted, fontWeight: 400, padding: "2px 8px", textAlign: "right" }}>YTD</th>
          </tr>
        </thead>
        <tbody>
          {years.map(year => {
            const ytd = months.reduce((acc, mo) => {
              const r = lookup[`${year}-${mo}`];
              return r !== undefined ? (1 + acc) * (1 + r) - 1 : acc;
            }, 0);
            return (
              <tr key={year}>
                <td style={{ color: COLORS.text, padding: "2px 8px", fontWeight: 600 }}>{year}</td>
                {months.map((mo, idx) => {
                  const ret = lookup[`${year}-${mo}`];
                  return (
                    <td key={mo} style={{ background: cellColor(ret), borderRadius: 4, padding: "4px 6px", textAlign: "center", color: ret !== undefined ? "#fff" : COLORS.surface, fontWeight: 500 }}>
                      {ret !== undefined ? (ret * 100).toFixed(1) + "%" : ""}
                    </td>
                  );
                })}
                <td style={{ color: ytd >= 0 ? COLORS.green : COLORS.red, padding: "2px 8px", textAlign: "right", fontWeight: 700 }}>
                  {(ytd * 100).toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── TRADE TABLE ───
function TradeTable({ trades }) {
  if (!trades?.length) return <div style={{ color: COLORS.muted, fontFamily: "monospace", fontSize: 12, padding: 16 }}>No trades executed.</div>;
  const recent = trades.slice(-50).reverse();
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            {["Entry Date", "Exit Date", "Entry $", "Exit $", "Shares", "P&L", "Return"].map(h => (
              <th key={h} style={{ color: COLORS.muted, fontWeight: 400, padding: "8px 12px", textAlign: "right", letterSpacing: "0.05em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {recent.map((t, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${COLORS.border}20`, background: i % 2 === 0 ? `${COLORS.surface}50` : "transparent" }}>
              <td style={{ padding: "7px 12px", color: COLORS.muted, textAlign: "right" }}>{t.entryDate}</td>
              <td style={{ padding: "7px 12px", color: COLORS.muted, textAlign: "right" }}>{t.exitDate}</td>
              <td style={{ padding: "7px 12px", color: COLORS.text, textAlign: "right" }}>{fmtDollar(t.entryPrice)}</td>
              <td style={{ padding: "7px 12px", color: COLORS.text, textAlign: "right" }}>{fmtDollar(t.exitPrice)}</td>
              <td style={{ padding: "7px 12px", color: COLORS.muted, textAlign: "right" }}>{t.shares.toFixed(4)}</td>
              <td style={{ padding: "7px 12px", color: t.pnl >= 0 ? COLORS.green : COLORS.red, textAlign: "right", fontWeight: 600 }}>{fmtDollar(t.pnl)}</td>
              <td style={{ padding: "7px 12px", color: t.pnlPct >= 0 ? COLORS.green : COLORS.red, textAlign: "right", fontWeight: 600 }}>{fmtPct(t.pnlPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trades.length > 50 && <div style={{ color: COLORS.muted, fontSize: 11, padding: "8px 12px" }}>Showing last 50 of {trades.length} trades.</div>}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState("builder");
  const [resultsTab, setResultsTab] = useState("equity");
  const [strategy, setStrategy] = useState("ma_crossover");
  const [dataSource, setDataSource] = useState("demo");
  const [csvTicker, setCsvTicker] = useState("DEMO");
  const [bars, setBars] = useState(null);
  const [signalBars, setSignalBars] = useState(null);
  const [backtestResult, setBacktestResult] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const fileRef = useRef();

  // Strategy params
  const [maParams, setMaParams] = useState({ fastPeriod: 20, slowPeriod: 50, maType: "SMA" });
  const [momParams, setMomParams] = useState({ rsiPeriod: 14, oversold: 30, overbought: 70 });
  const [mrParams, setMrParams] = useState({ bbPeriod: 20, bbStdDev: 2 });

  // Portfolio params
  const [initialCapital, setInitialCapital] = useState(10000);
  const [positionSize, setPositionSize] = useState(100);
  const [commission, setCommission] = useState(0);
  const [slippage, setSlippage] = useState(0.1);

  // Date range
  const [startDate, setStartDate] = useState("2020-01-01");
  const [endDate, setEndDate] = useState("2024-12-31");

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseCSV(ev.target.result);
        if (parsed.length < 50) { setError("CSV has fewer than 50 bars — need more data."); return; }
        setCsvTicker(file.name.replace(".csv", "").toUpperCase());
        setBars(parsed);
        setDataSource("csv");
        setStatus(`✓ Loaded ${parsed.length} bars from ${file.name}`);
        setError("");
      } catch (err) {
        setError("Failed to parse CSV: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  const loadDemoData = () => {
    const data = generateSampleData("DEMO", 756);
    setBars(data);
    setDataSource("demo");
    setStatus(`✓ Loaded ${data.length} bars of demo data`);
    setError("");
  };

  const runBacktestClick = () => {
    setLoading(true);
    setError("");
    setTimeout(() => {
      try {
        let data = bars;
        if (!data) {
          data = generateSampleData("DEMO", 756);
          setBars(data);
        }
        // Filter by date range
        const filtered = data.filter(b => b.date >= startDate && b.date <= endDate);
        if (filtered.length < 30) { setError("Not enough bars in selected date range (need at least 30)."); setLoading(false); return; }

        // Run strategy
        let sigs;
        if (strategy === "ma_crossover") sigs = runMACrossover(filtered, maParams);
        else if (strategy === "momentum") sigs = runMomentum(filtered, momParams);
        else sigs = runMeanReversion(filtered, mrParams);

        const result = runBacktest(sigs, { initialCapital, positionSize, commission, slippage });
        const m = calcMetrics(result.equity, result.trades, initialCapital);
        setSignalBars(sigs);
        setBacktestResult(result);
        setMetrics(m);
        setActiveTab("results");
        setStatus(`✓ Backtest complete — ${result.trades.length} trades over ${filtered.length} bars`);
      } catch (err) {
        setError("Backtest error: " + err.message);
      }
      setLoading(false);
    }, 50);
  };

  const inputStyle = {
    background: COLORS.surface, border: `1px solid ${COLORS.border}`,
    color: COLORS.text, borderRadius: 6, padding: "7px 10px", fontSize: 13,
    fontFamily: "monospace", width: "100%", boxSizing: "border-box"
  };

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      {/* Google Font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        input[type=range] { -webkit-appearance: none; background: transparent; }
        input[type=range]::-webkit-slider-runnable-track { height: 4px; background: #1f2d45; border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #00d4ff; margin-top: -5px; cursor: pointer; }
        select option { background: #111827; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #0a0e1a; }
        ::-webkit-scrollbar-thumb { background: #1f2d45; border-radius: 3px; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: `${COLORS.surface}cc`, backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.accent, boxShadow: `0 0 12px ${COLORS.accent}` }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em" }}>ALGO<span style={{ color: COLORS.accent }}>BACKTEST</span></span>
          <span style={{ color: COLORS.muted, fontSize: 12, fontFamily: "monospace" }}>v1.0</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {status && <div style={{ fontSize: 11, color: COLORS.green, fontFamily: "monospace", opacity: 0.8 }}>{status}</div>}
          {error && <div style={{ fontSize: 11, color: COLORS.red, fontFamily: "monospace" }}>{error}</div>}
        </div>
      </div>

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "32px 24px", display: "grid", gridTemplateColumns: "360px 1fr", gap: 24, alignItems: "start" }}>

        {/* ─── LEFT PANEL ─── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>

          {/* Strategy selector */}
          <Section title="Strategy">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { id: "ma_crossover", label: "Moving Average Crossover", desc: "Golden/death cross signals" },
                { id: "momentum", label: "Momentum (RSI)", desc: "RSI overbought/oversold" },
                { id: "mean_reversion", label: "Mean Reversion", desc: "Bollinger Band breakouts" },
              ].map(s => (
                <button key={s.id} onClick={() => setStrategy(s.id)} style={{
                  background: strategy === s.id ? `${COLORS.accent}18` : COLORS.card,
                  border: `1px solid ${strategy === s.id ? COLORS.accent : COLORS.border}`,
                  borderRadius: 10, padding: "12px 16px", cursor: "pointer",
                  display: "flex", flexDirection: "column", gap: 3, textAlign: "left",
                  transition: "all 0.15s"
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: strategy === s.id ? COLORS.accent : COLORS.text, fontFamily: "monospace" }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </Section>

          {/* Strategy parameters */}
          <Section title="Parameters">
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "16px 20px" }}>
              {strategy === "ma_crossover" && <>
                <Select label="MA Type" value={maParams.maType} options={[{ value: "SMA", label: "SMA (Simple)" }, { value: "EMA", label: "EMA (Exponential)" }]} onChange={v => setMaParams(p => ({ ...p, maType: v }))} />
                <Slider label="Fast Period" value={maParams.fastPeriod} min={5} max={50} onChange={v => setMaParams(p => ({ ...p, fastPeriod: v }))} unit=" bars" />
                <Slider label="Slow Period" value={maParams.slowPeriod} min={20} max={200} onChange={v => setMaParams(p => ({ ...p, slowPeriod: v }))} unit=" bars" />
              </>}
              {strategy === "momentum" && <>
                <Slider label="RSI Period" value={momParams.rsiPeriod} min={5} max={30} onChange={v => setMomParams(p => ({ ...p, rsiPeriod: v }))} unit=" bars" />
                <Slider label="Oversold Level" value={momParams.oversold} min={10} max={50} onChange={v => setMomParams(p => ({ ...p, oversold: v }))} />
                <Slider label="Overbought Level" value={momParams.overbought} min={50} max={90} onChange={v => setMomParams(p => ({ ...p, overbought: v }))} />
              </>}
              {strategy === "mean_reversion" && <>
                <Slider label="BB Period" value={mrParams.bbPeriod} min={10} max={50} onChange={v => setMrParams(p => ({ ...p, bbPeriod: v }))} unit=" bars" />
                <Slider label="Std Deviations" value={mrParams.bbStdDev} min={1} max={4} step={0.5} onChange={v => setMrParams(p => ({ ...p, bbStdDev: v }))} unit="σ" />
              </>}
            </div>
          </Section>

          {/* Portfolio */}
          <Section title="Portfolio">
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "16px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{ width: 160, fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>Initial Capital</div>
                <input type="number" value={initialCapital} onChange={e => setInitialCapital(Number(e.target.value))} min={100} step={1000}
                  style={{ ...inputStyle, flex: 1 }} />
              </div>
              <Slider label="Position Size" value={positionSize} min={10} max={100} step={5} onChange={setPositionSize} unit="%" />
              <Slider label="Commission" value={commission} min={0} max={1} step={0.05} onChange={setCommission} unit="%" />
              <Slider label="Slippage" value={slippage} min={0} max={1} step={0.05} onChange={setSlippage} unit="%" />
            </div>
          </Section>

          {/* Date range */}
          <Section title="Date Range">
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 70, fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>From</div>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 70, fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>To</div>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              </div>
            </div>
          </Section>

          {/* Data Source */}
          <Section title="Data Source">
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
              <button onClick={loadDemoData} style={{
                background: dataSource === "demo" ? `${COLORS.accent}18` : COLORS.surface,
                border: `1px solid ${dataSource === "demo" ? COLORS.accent : COLORS.border}`,
                color: COLORS.text, borderRadius: 8, padding: "10px 14px", cursor: "pointer",
                fontSize: 12, fontFamily: "monospace", textAlign: "left"
              }}>
                📊 Load Demo Data (3 years, simulated)
              </button>
              <button onClick={() => fileRef.current?.click()} style={{
                background: dataSource === "csv" ? `${COLORS.accent}18` : COLORS.surface,
                border: `1px solid ${dataSource === "csv" ? COLORS.accent : COLORS.border}`,
                color: COLORS.text, borderRadius: 8, padding: "10px 14px", cursor: "pointer",
                fontSize: 12, fontFamily: "monospace", textAlign: "left"
              }}>
                📁 Upload CSV (Date, Open, High, Low, Close, Volume)
              </button>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleCSVUpload} style={{ display: "none" }} />
              <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.5, fontFamily: "monospace" }}>
                💡 For real data: download CSV from Yahoo Finance (finance.yahoo.com → Historical Data → Download)
              </div>
            </div>
          </Section>

          {/* Run button */}
          <button onClick={runBacktestClick} disabled={loading} style={{
            background: loading ? COLORS.border : `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentDim})`,
            border: "none", borderRadius: 12, padding: "16px", cursor: loading ? "not-allowed" : "pointer",
            fontSize: 14, fontWeight: 700, color: "#000", fontFamily: "'IBM Plex Mono', monospace",
            letterSpacing: "0.08em", textTransform: "uppercase",
            boxShadow: loading ? "none" : `0 0 24px ${COLORS.accent}40`,
            transition: "all 0.2s"
          }}>
            {loading ? "⏳ Running..." : "▶ Run Backtest"}
          </button>
        </div>

        {/* ─── RIGHT PANEL ─── */}
        <div>
          {!backtestResult ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 400, color: COLORS.muted, fontFamily: "monospace", textAlign: "center", gap: 16 }}>
              <div style={{ fontSize: 48, opacity: 0.3 }}>📈</div>
              <div style={{ fontSize: 14 }}>Configure your strategy and click<br /><span style={{ color: COLORS.accent }}>Run Backtest</span> to see results</div>
            </div>
          ) : (
            <>
              {/* Key metrics row */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 24 }}>
                <MetricCard label="Total Return" value={fmtPct(metrics.totalReturn)} color={metrics.totalReturn >= 0 ? COLORS.green : COLORS.red} large />
                <MetricCard label="CAGR" value={fmtPct(metrics.cagr)} color={metrics.cagr >= 0 ? COLORS.green : COLORS.red} large />
                <MetricCard label="Sharpe Ratio" value={fmt(metrics.sharpe)} color={metrics.sharpe > 1 ? COLORS.green : metrics.sharpe > 0 ? COLORS.yellow : COLORS.red} large />
                <MetricCard label="Max Drawdown" value={fmtPct(-metrics.maxDrawdown)} color={COLORS.red} large />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 28 }}>
                <MetricCard label="Final Value" value={fmtDollar(metrics.finalValue)} />
                <MetricCard label="Sortino" value={fmt(metrics.sortino)} />
                <MetricCard label="Win Rate" value={fmtPct(metrics.winRate)} />
                <MetricCard label="Profit Factor" value={isFinite(metrics.profitFactor) ? fmt(metrics.profitFactor) : "∞"} />
                <MetricCard label="Total Trades" value={metrics.totalTrades} />
                <MetricCard label="Volatility" value={fmtPct(metrics.volatility)} sub="Annualized" />
                <MetricCard label="Calmar Ratio" value={fmt(metrics.calmar)} />
                <MetricCard label="Expectancy" value={fmtDollar(metrics.expectancy)} sub="Per trade" color={metrics.expectancy >= 0 ? COLORS.green : COLORS.red} />
              </div>

              {/* Charts tabs */}
              <Tabs
                tabs={[
                  { id: "equity", label: "Equity Curve" },
                  { id: "drawdown", label: "Drawdown" },
                  { id: "price", label: "Price + Signals" },
                  { id: "heatmap", label: "Monthly Returns" },
                  { id: "trades", label: "Trade Log" },
                ]}
                active={resultsTab}
                onSelect={setResultsTab}
              />

              <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "20px 16px" }}>
                {resultsTab === "equity" && <>
                  <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 12 }}>Portfolio value over time — dashed line = initial capital</div>
                  <EquityCurveChart equity={backtestResult.equity} initialCapital={initialCapital} />
                </>}
                {resultsTab === "drawdown" && <>
                  <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 12 }}>Peak-to-trough decline as % of peak portfolio value</div>
                  <DrawdownChart equity={backtestResult.equity} />
                </>}
                {resultsTab === "price" && <>
                  <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 12 }}>Price with strategy indicators overlaid</div>
                  <PriceChart signalBars={signalBars} strategy={strategy} />
                </>}
                {resultsTab === "heatmap" && <>
                  <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 14 }}>Monthly portfolio returns — green = profit, red = loss</div>
                  <MonthlyHeatmap equity={backtestResult.equity} />
                </>}
                {resultsTab === "trades" && <>
                  <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 12 }}>
                    {metrics.winners}W / {metrics.losers}L — Avg win: {fmtDollar(metrics.avgWin)} | Avg loss: {fmtDollar(metrics.avgLoss)}
                  </div>
                  <TradeTable trades={backtestResult.trades} />
                </>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
