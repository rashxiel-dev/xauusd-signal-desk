/**
 * XAUUSD Signal Bot — Web Backend
 * --------------------------------
 * Runs the EMA/RSI/ATR signal logic as an always-on web server: keeps
 * polling and sending Telegram alerts on its own schedule (independent
 * of whether anyone has the dashboard open), and serves a JSON API +
 * dashboard with a "signal map" — H4 context chart + entry-timeframe
 * chart, each with an auto-drawn trendline, plus the reasoning behind
 * the current signal.
 *
 * Requires Node 18+ (uses the built-in fetch).
 */

const express = require("express");
const path = require("path");

// ---------------- Config ----------------
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const SYMBOL = process.env.SYMBOL || "XAU/USD";
const INTERVAL = process.env.INTERVAL || "15min"; // entry timeframe
const HIGH_INTERVAL = process.env.HIGH_INTERVAL || "4h"; // context timeframe
const PORT = process.env.PORT || 3000;

const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 25;
const SWING_WINDOW = 2; // candles on each side to qualify as a swing point

const POLL_MS = 15 * 60 * 1000; // full candle + signal check, every 15 minutes
const LIVE_POLL_MS = 3 * 60 * 1000; // lightweight price-only tick, every 3 minutes

// ---------------- Challenge / risk config ----------------
const ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || "5000");
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || "200");
const MAX_LOSS_LIMIT = parseFloat(process.env.MAX_LOSS_LIMIT || "350");
const PROFIT_TARGET = parseFloat(process.env.PROFIT_TARGET || "500");
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE || "50");
const XAU_LOT_USD_PER_POINT = 100; // 1.00 lot XAUUSD ≈ $100 per $1 move (100oz)

// ---------------- In-memory state ----------------
const state = {
  status: "starting",
  lastChecked: null,
  lastError: null,
  symbol: SYMBOL,
  interval: INTERVAL,
  price: null,
  rsi: null,
  emaFast: null,
  emaSlow: null,
  atr: null,
  signal: null,
  suggestedSL: null,
  suggestedTP: null,
  lastSignal: null,
  lastSignalTime: null,
  lastSignalPrice: null,
  lastSignalStrategy: null,
  lastSignalReason: null,
  strategySignals: { emaCross: null, srBounce: null, breakout: null },
  history: [],
  sparkline: [],
  chartMap: null, // { context: {...}, entry: {...}, reason: "" }
  suggestedLot: null,
  livePrice: null,
  liveCheckedAt: null,
  risk: {
    accountSize: ACCOUNT_SIZE,
    dailyLossLimit: DAILY_LOSS_LIMIT,
    maxLossLimit: MAX_LOSS_LIMIT,
    profitTarget: PROFIT_TARGET,
    riskPerTrade: RISK_PER_TRADE,
    dailyPnL: 0,
    totalPnL: 0,
    dayKey: null,
    tradesToday: 0,
    halted: false,
    haltReason: null,
    log: [], // { time, result, amount }[]
    openTrade: null, // { signal, entryPrice, sl, tp, entryTime }
  },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded() {
  const key = todayKey();
  if (state.risk.dayKey !== key) {
    state.risk.dayKey = key;
    state.risk.dailyPnL = 0;
    state.risk.tradesToday = 0;
    if (state.risk.haltReason === "daily") {
      state.risk.halted = false;
      state.risk.haltReason = null;
    }
  }
}

function evaluateHalt() {
  if (state.risk.totalPnL <= -MAX_LOSS_LIMIT) {
    state.risk.halted = true;
    state.risk.haltReason = "max";
  } else if (state.risk.dailyPnL <= -DAILY_LOSS_LIMIT) {
    state.risk.halted = true;
    state.risk.haltReason = "daily";
  }
}

// lot size sized so a full stop-out costs exactly RISK_PER_TRADE
function computeLotSize(slDistance) {
  if (!slDistance || slDistance <= 0) return null;
  const raw = RISK_PER_TRADE / (slDistance * XAU_LOT_USD_PER_POINT);
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

// Records a win/loss against the risk tracker (shared by auto-resolution
// and manual override).
function applyTradeResult(result, note) {
  const amount = result === "win" ? RISK_PER_TRADE * (2.5 / 1.5) : -RISK_PER_TRADE;
  state.risk.dailyPnL += amount;
  state.risk.totalPnL += amount;
  state.risk.log.unshift({ time: new Date().toISOString(), result, amount, note });
  state.risk.log = state.risk.log.slice(0, 50);
  evaluateHalt();
  return amount;
}

// Watches candles after the open trade's entry for the first touch of
// SL or TP and auto-logs the outcome. If both are touched within the
// same candle, SL is assumed to have hit first (conservative).
function resolveOpenTrade(entryCandles) {
  const open = state.risk.openTrade;
  if (!open) return;

  const after = entryCandles.filter((c) => c.datetime > open.entryTime);
  for (const c of after) {
    const hitSL =
      open.signal === "BUY" ? c.low <= open.sl : c.high >= open.sl;
    const hitTP =
      open.signal === "BUY" ? c.high >= open.tp : c.low <= open.tp;

    if (hitSL || hitTP) {
      const result = hitSL ? "loss" : "win";
      applyTradeResult(result, "auto");
      console.log(
        `[${new Date().toISOString()}] Auto-resolved ${open.signal} trade as ${result.toUpperCase()} (candle ${c.datetime})`
      );
      state.risk.openTrade = null;
      return;
    }
  }
}

// ---------------- Data ----------------
async function fetchCandles(interval, n = 100) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", n);
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
  url.searchParams.set("order", "ASC");

  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) {
    throw new Error(`Twelve Data error (${interval}): ${JSON.stringify(data)}`);
  }
  return data.values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

// Lightweight current-price poll (no candle recompute) so the ticker
// visibly moves between the full 15-min structural checks.
async function fetchQuote() {
  const url = new URL("https://api.twelvedata.com/price");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
  const res = await fetch(url);
  const data = await res.json();
  if (!data.price) {
    throw new Error(`Twelve Data quote error: ${JSON.stringify(data)}`);
  }
  return parseFloat(data.price);
}

// ---------------- Indicators ----------------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
  }
  return out;
}

function atr(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  });
  const out = new Array(trs.length).fill(null);
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    out[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

// ---------------- Trendline detection ----------------
function findSwingHighs(candles, window = SWING_WINDOW) {
  const pts = [];
  for (let i = window; i < candles.length - window; i++) {
    const h = candles[i].high;
    let isSwing = true;
    for (let w = 1; w <= window; w++) {
      if (candles[i - w].high >= h || candles[i + w].high >= h) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) pts.push({ index: i, price: h });
  }
  return pts;
}

function findSwingLows(candles, window = SWING_WINDOW) {
  const pts = [];
  for (let i = window; i < candles.length - window; i++) {
    const l = candles[i].low;
    let isSwing = true;
    for (let w = 1; w <= window; w++) {
      if (candles[i - w].low <= l || candles[i + w].low <= l) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) pts.push({ index: i, price: l });
  }
  return pts;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((a, p) => a + p.index, 0);
  const sumY = points.reduce((a, p) => a + p.price, 0);
  const sumXY = points.reduce((a, p) => a + p.index * p.price, 0);
  const sumXX = points.reduce((a, p) => a + p.index * p.index, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Fits a resistance line through swing highs (downtrend) or a support
// line through swing lows (uptrend), spanning the full candle window.
function buildTrendline(candles, bias) {
  const pts = bias === "down" ? findSwingHighs(candles) : findSwingLows(candles);
  const usable = pts.length >= 2 ? pts : bias === "down" ? findSwingHighs(candles, 1) : findSwingLows(candles, 1);
  const reg = linearRegression(usable);
  if (!reg) return null;

  const firstIndex = 0;
  const lastIndex = candles.length - 1;
  return {
    p1: { index: firstIndex, price: reg.slope * firstIndex + reg.intercept },
    p2: { index: lastIndex, price: reg.slope * lastIndex + reg.intercept },
    slope: reg.slope,
    intercept: reg.intercept,
  };
}

function trendlineValueAt(trendline, index) {
  return trendline.slope * index + trendline.intercept;
}

// Overall bias for a candle set: slope of a regression through closes.
function closesBias(candles) {
  const pts = candles.map((c, i) => ({ index: i, price: c.close }));
  const reg = linearRegression(pts);
  if (!reg) return "flat";
  return reg.slope < 0 ? "down" : "up";
}

// ---------------- Strategies ----------------
// Each evaluator looks only at the entry timeframe and returns either
// null (no setup right now) or { signal, sl, tp, reason }.

function evaluateEmaCross(entryCandles, emaFastArr, emaSlowArr, rsiArr, atrArr, i) {
  const prevI = i - 1;
  const price = entryCandles[i].close;
  const atrVal = atrArr[i];
  if (!atrVal) return null;

  const crossedUp = emaFastArr[prevI] <= emaSlowArr[prevI] && emaFastArr[i] > emaSlowArr[i];
  const crossedDown = emaFastArr[prevI] >= emaSlowArr[prevI] && emaFastArr[i] < emaSlowArr[i];

  if (crossedUp && rsiArr[i] < RSI_OVERBOUGHT) {
    return {
      signal: "BUY",
      sl: price - atrVal * 1.5,
      tp: price + atrVal * 2.5,
      reason: `EMA${EMA_FAST} crossed above EMA${EMA_SLOW} with RSI at ${rsiArr[i].toFixed(1)} — bullish momentum confirmed.`,
    };
  }
  if (crossedDown && rsiArr[i] > RSI_OVERSOLD) {
    return {
      signal: "SELL",
      sl: price + atrVal * 1.5,
      tp: price - atrVal * 2.5,
      reason: `EMA${EMA_FAST} crossed below EMA${EMA_SLOW} with RSI at ${rsiArr[i].toFixed(1)} — bearish momentum confirmed.`,
    };
  }
  return null;
}

// Rejection off an auto-drawn support or resistance trendline: price
// wicks through the line but closes back on the "right" side.
function evaluateSRBounce(entryCandles, atrArr, i, supportLine, resistanceLine) {
  const c = entryCandles[i];
  const atrVal = atrArr[i];
  if (!atrVal) return null;
  const tolerance = atrVal * 0.6;

  if (supportLine) {
    const lineVal = trendlineValueAt(supportLine, i);
    const wickedThrough = c.low <= lineVal + tolerance;
    const closedAbove = c.close > lineVal;
    const bullishCandle = c.close > c.open;
    if (wickedThrough && closedAbove && bullishCandle) {
      const sl = c.low - atrVal * 0.5;
      const tp = c.close + (c.close - sl) * 1.5;
      return {
        signal: "BUY",
        sl,
        tp,
        reason: `Price wicked into the support trendline near ${lineVal.toFixed(2)} and closed back above it on a bullish candle — rejection bounce.`,
      };
    }
  }

  if (resistanceLine) {
    const lineVal = trendlineValueAt(resistanceLine, i);
    const wickedThrough = c.high >= lineVal - tolerance;
    const closedBelow = c.close < lineVal;
    const bearishCandle = c.close < c.open;
    if (wickedThrough && closedBelow && bearishCandle) {
      const sl = c.high + atrVal * 0.5;
      const tp = c.close - (sl - c.close) * 1.5;
      return {
        signal: "SELL",
        sl,
        tp,
        reason: `Price wicked into the resistance trendline near ${lineVal.toFixed(2)} and closed back below it on a bearish candle — rejection.`,
      };
    }
  }

  return null;
}

// Close breaks beyond the recent N-candle range with volatility
// expanding (ATR above its own recent average) — trend continuation.
function evaluateBreakout(entryCandles, atrArr, i, lookback = 20) {
  if (i - lookback < 0) return null;
  const atrVal = atrArr[i];
  if (!atrVal) return null;

  const priorCandles = entryCandles.slice(i - lookback, i);
  const highestHigh = Math.max(...priorCandles.map((c) => c.high));
  const lowestLow = Math.min(...priorCandles.map((c) => c.low));

  const priorATRs = atrArr.slice(i - lookback, i).filter((v) => v !== null);
  const avgATR = priorATRs.length ? priorATRs.reduce((a, b) => a + b, 0) / priorATRs.length : atrVal;
  const expanding = atrVal > avgATR * 1.1;

  const c = entryCandles[i];
  if (c.close > highestHigh && expanding) {
    return {
      signal: "BUY",
      sl: c.close - atrVal * 1.2,
      tp: c.close + atrVal * 2.2,
      reason: `Price closed above the ${lookback}-candle high (${highestHigh.toFixed(2)}) with expanding volatility — breakout continuation.`,
    };
  }
  if (c.close < lowestLow && expanding) {
    return {
      signal: "SELL",
      sl: c.close + atrVal * 1.2,
      tp: c.close - atrVal * 2.2,
      reason: `Price closed below the ${lookback}-candle low (${lowestLow.toFixed(2)}) with expanding volatility — breakdown continuation.`,
    };
  }
  return null;
}

// ---------------- Telegram ----------------
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    console.error("Telegram send failed:", await res.text());
  }
}

function formatMessage(strategyName, signal, price, rsiVal, time, lot, reason, sl, tp) {
  return (
    `*${signal} SIGNAL — ${SYMBOL}* _(${strategyName})_\n` +
    `Time: ${time}\n` +
    `Price: ${price.toFixed(2)}\n` +
    `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}\n` +
    `${reason}\n` +
    `Suggested SL: ${sl.toFixed(2)}\n` +
    `Suggested TP: ${tp.toFixed(2)}\n` +
    `Suggested lot: ${lot ? lot.toFixed(2) : "—"} (risking $${RISK_PER_TRADE} on a $${ACCOUNT_SIZE} account)\n` +
    `_Signal only — not financial advice. Confirm before trading._`
  );
}

function formatReason(_unused, price, rsiVal, bias) {
  return `No active crossover — price is ${
    bias === "down" ? "testing resistance" : "testing support"
  } near ${price.toFixed(2)}, EMA${EMA_FAST}/${EMA_SLOW} still trending ${
    bias === "down" ? "down" : "up"
  }.`;
}

// ---------------- Core check ----------------
let startupMessageSent = false;

async function checkOnce() {
  const [entryCandles, contextCandles] = await Promise.all([
    fetchCandles(INTERVAL, 100),
    fetchCandles(HIGH_INTERVAL, 80),
  ]);

  const closes = entryCandles.map((c) => c.close);
  const emaFastArr = ema(closes, EMA_FAST);
  const emaSlowArr = ema(closes, EMA_SLOW);
  const rsiArr = rsi(closes, RSI_PERIOD);
  const atrArr = atr(entryCandles, ATR_PERIOD);

  const i = closes.length - 1;

  const price = closes[i];
  const time = entryCandles[i].datetime;

  state.price = price;
  state.rsi = rsiArr[i];
  state.emaFast = emaFastArr[i];
  state.emaSlow = emaSlowArr[i];
  state.atr = atrArr[i];
  state.lastChecked = new Date().toISOString();
  state.status = "ok";
  state.lastError = null;
  state.sparkline = closes.slice(-40);

  if (!startupMessageSent) {
    startupMessageSent = true;
    await sendTelegram(
      `✅ Signal bot is live — watching *${SYMBOL}* on ${INTERVAL} candles.\n` +
        `Current price: ${price.toFixed(2)} · RSI: ${rsiArr[i].toFixed(1)}\n` +
        `Running 3 strategies: EMA Cross, S/R Bounce, Breakout.`
    );
  }

  resetDailyIfNeeded();

  // resolve any trade already being watched before considering new ones
  resolveOpenTrade(entryCandles);
  evaluateHalt();

  // trendlines used by both the S/R Bounce strategy and the chart map
  const supportLine = buildTrendline(entryCandles, "up");
  const resistanceLine = buildTrendline(entryCandles, "down");

  const strategies = [
    {
      key: "emaCross",
      name: "EMA Cross",
      result: evaluateEmaCross(entryCandles, emaFastArr, emaSlowArr, rsiArr, atrArr, i),
    },
    {
      key: "srBounce",
      name: "S/R Bounce",
      result: evaluateSRBounce(entryCandles, atrArr, i, supportLine, resistanceLine),
    },
    {
      key: "breakout",
      name: "Breakout",
      result: evaluateBreakout(entryCandles, atrArr, i),
    },
  ];

  state.signal = strategies.find((s) => s.result)?.result.signal || null;

  let anyFired = false;
  for (const strat of strategies) {
    if (!strat.result) {
      state.strategySignals[strat.key] = null;
      continue;
    }

    const prev = state.strategySignals[strat.key];
    if (prev && prev.lastSignal === strat.result.signal) continue; // still the same active call

    state.strategySignals[strat.key] = { lastSignal: strat.result.signal, lastTime: time };
    anyFired = true;

    const { signal, sl, tp, reason } = strat.result;
    const lot = computeLotSize(Math.abs(price - sl));

    state.lastSignal = signal;
    state.lastSignalTime = time;
    state.lastSignalPrice = price;
    state.lastSignalStrategy = strat.name;
    state.lastSignalReason = reason;
    state.suggestedSL = sl;
    state.suggestedTP = tp;
    state.suggestedLot = lot;
    state.history.unshift({ time, signal, price, strategy: strat.name });
    state.history = state.history.slice(0, 30);

    if (state.risk.halted) {
      console.log(
        `[${new Date().toISOString()}] ${strat.name} ${signal} suppressed — risk halt active (${state.risk.haltReason})`
      );
      continue;
    }

    const msg = formatMessage(strat.name, signal, price, rsiArr[i], time, lot, reason, sl, tp);
    await sendTelegram(msg);
    state.risk.tradesToday += 1;

    if (!state.risk.openTrade) {
      state.risk.openTrade = { signal, entryPrice: price, sl, tp, entryTime: time, strategy: strat.name };
    } else {
      console.log(
        `[${new Date().toISOString()}] ${strat.name} ${signal} fired while a trade is still open — not auto-tracked for P&L`
      );
    }

    console.log(`[${new Date().toISOString()}] Sent ${strat.name} ${signal} @ ${price}`);
  }

  if (!anyFired) {
    console.log(`[${new Date().toISOString()}] No new signal from any strategy`);
  }

  // ---- Signal map: entry chart + context chart, each with a trendline ----
  const entryBias = state.lastSignal === "SELL" ? "down" : state.lastSignal === "BUY" ? "up" : closesBias(entryCandles);
  const contextBias = closesBias(contextCandles);

  const entryTrendline = entryBias === "down" ? resistanceLine : supportLine;
  const contextTrendline = buildTrendline(contextCandles, contextBias);

  let signalIndex = null;
  if (state.lastSignal && state.lastSignalTime) {
    const idx = entryCandles.findIndex((c) => c.datetime === state.lastSignalTime);
    if (idx >= 0) signalIndex = idx;
  }

  state.chartMap = {
    reason:
      state.lastSignal && state.lastSignalReason
        ? `${state.lastSignalReason} (${state.lastSignalStrategy})`
        : formatReason(null, price, rsiArr[i], entryBias),
    entry: {
      interval: INTERVAL,
      candles: entryCandles.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, t: c.datetime })),
      emaFast: emaFastArr,
      emaSlow: emaSlowArr,
      trendline: entryTrendline,
      bias: entryBias,
      signalIndex,
      signalType: state.lastSignal,
    },
    context: {
      interval: HIGH_INTERVAL,
      candles: contextCandles.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, t: c.datetime })),
      trendline: contextTrendline,
      bias: contextBias,
    },
  };
}

async function pollLoop() {
  try {
    await checkOnce();
    setTimeout(pollLoop, POLL_MS);
  } catch (err) {
    state.status = "error";
    state.lastError = err.message;
    console.error("Check failed:", err.message);
    // retry sooner than a full cycle so a transient network blip
    // (common right after a cold start) doesn't leave the dashboard
    // blank for 15 minutes
    setTimeout(pollLoop, 60 * 1000);
  }
}

// Lightweight tick between structural checks so the price/chart feel live.
async function liveLoop() {
  try {
    const price = await fetchQuote();
    state.livePrice = price;
    state.liveCheckedAt = new Date().toISOString();
  } catch (err) {
    console.error("Live quote failed:", err.message);
  } finally {
    setTimeout(liveLoop, LIVE_POLL_MS);
  }
}

// ---------------- Web server ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json(state);
});

// Log the outcome of the currently open trade (manual override — the
// bot normally resolves this itself against SL/TP). Falls back to a
// generic log entry if nothing is currently open.
// body: { result: "win" | "loss" }
app.post("/api/trade-result", (req, res) => {
  resetDailyIfNeeded();
  const { result } = req.body || {};
  if (result !== "win" && result !== "loss") {
    return res.status(400).json({ error: "result must be 'win' or 'loss'" });
  }

  applyTradeResult(result, state.risk.openTrade ? "manual override" : "manual");
  state.risk.openTrade = null;

  res.json({ ok: true, risk: state.risk });
});

app.post("/api/reset-day", (req, res) => {
  state.risk.dailyPnL = 0;
  state.risk.tradesToday = 0;
  state.risk.dayKey = todayKey();
  if (state.risk.haltReason === "daily") {
    state.risk.halted = false;
    state.risk.haltReason = null;
  }
  res.json({ ok: true, risk: state.risk });
});

app.post("/api/reset-challenge", (req, res) => {
  state.risk.dailyPnL = 0;
  state.risk.totalPnL = 0;
  state.risk.tradesToday = 0;
  state.risk.halted = false;
  state.risk.haltReason = null;
  state.risk.log = [];
  state.risk.openTrade = null;
  state.risk.dayKey = todayKey();
  state.strategySignals = { emaCross: null, srBounce: null, breakout: null };
  res.json({ ok: true, risk: state.risk });
});

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);

  const missing = [
    ["TWELVE_DATA_API_KEY", TWELVE_DATA_API_KEY],
    ["TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN],
    ["TELEGRAM_CHAT_ID", TELEGRAM_CHAT_ID],
  ].filter(([, v]) => !v);

  if (missing.length) {
    state.status = "error";
    state.lastError = `Missing config: ${missing.map(([n]) => n).join(", ")}`;
    console.error(state.lastError);
    return;
  }

  pollLoop();
  liveLoop();
});
