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

const POLL_MS = 15 * 60 * 1000; // check every 15 minutes

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
  history: [],
  sparkline: [],
  chartMap: null, // { context: {...}, entry: {...}, reason: "" }
  suggestedLot: null,
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
  };
}

// Overall bias for a candle set: slope of a regression through closes.
function closesBias(candles) {
  const pts = candles.map((c, i) => ({ index: i, price: c.close }));
  const reg = linearRegression(pts);
  if (!reg) return "flat";
  return reg.slope < 0 ? "down" : "up";
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

function formatMessage(signal, price, rsiVal, atrVal, time, lot) {
  const sl = signal === "BUY" ? price - atrVal * 1.5 : price + atrVal * 1.5;
  const tp = signal === "BUY" ? price + atrVal * 2.5 : price - atrVal * 2.5;
  return (
    `*${signal} SIGNAL — ${SYMBOL}*\n` +
    `Time: ${time}\n` +
    `Price: ${price.toFixed(2)}\n` +
    `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}\n` +
    `EMA${EMA_FAST}/${EMA_SLOW} crossover on ${INTERVAL}\n` +
    `Suggested SL: ${sl.toFixed(2)}\n` +
    `Suggested TP: ${tp.toFixed(2)}\n` +
    `Suggested lot: ${lot ? lot.toFixed(2) : "—"} (risking $${RISK_PER_TRADE} on a $${ACCOUNT_SIZE} account)\n` +
    `_Signal only — not financial advice. Confirm before trading._`
  );
}

function formatReason(signal, price, rsiVal, bias) {
  if (signal === "SELL") {
    return `EMA${EMA_FAST} crossed below EMA${EMA_SLOW} with RSI at ${rsiVal.toFixed(
      1
    )} — bearish momentum confirmed near the resistance trendline.`;
  }
  if (signal === "BUY") {
    return `EMA${EMA_FAST} crossed above EMA${EMA_SLOW} with RSI at ${rsiVal.toFixed(
      1
    )} — bullish momentum confirmed near the support trendline.`;
  }
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
  const prevI = i - 1;

  const crossedUp =
    emaFastArr[prevI] <= emaSlowArr[prevI] && emaFastArr[i] > emaSlowArr[i];
  const crossedDown =
    emaFastArr[prevI] >= emaSlowArr[prevI] && emaFastArr[i] < emaSlowArr[i];

  let signal = null;
  if (crossedUp && rsiArr[i] < RSI_OVERBOUGHT) signal = "BUY";
  else if (crossedDown && rsiArr[i] > RSI_OVERSOLD) signal = "SELL";

  const price = closes[i];
  const time = entryCandles[i].datetime;

  state.price = price;
  state.rsi = rsiArr[i];
  state.emaFast = emaFastArr[i];
  state.emaSlow = emaSlowArr[i];
  state.atr = atrArr[i];
  state.signal = signal;
  state.lastChecked = new Date().toISOString();
  state.status = "ok";
  state.lastError = null;
  state.sparkline = closes.slice(-40);

  if (!startupMessageSent) {
    startupMessageSent = true;
    await sendTelegram(
      `✅ Signal bot is live — watching *${SYMBOL}* on ${INTERVAL} candles.\n` +
        `Current price: ${price.toFixed(2)} · RSI: ${rsiArr[i].toFixed(1)}\n` +
        `You'll get a message here the moment an EMA${EMA_FAST}/${EMA_SLOW} crossover confirms.`
    );
  }

  if (signal) {
    const sl =
      signal === "BUY" ? price - atrArr[i] * 1.5 : price + atrArr[i] * 1.5;
    const tp =
      signal === "BUY" ? price + atrArr[i] * 2.5 : price - atrArr[i] * 2.5;
    state.suggestedSL = sl;
    state.suggestedTP = tp;
    state.suggestedLot = computeLotSize(Math.abs(price - sl));
  }

  resetDailyIfNeeded();
  evaluateHalt();

  if (signal && signal !== state.lastSignal) {
    state.lastSignal = signal;
    state.lastSignalTime = time;
    state.history.unshift({ time, signal, price });
    state.history = state.history.slice(0, 30);

    if (state.risk.halted) {
      console.log(
        `[${new Date().toISOString()}] ${signal} signal suppressed — risk halt active (${state.risk.haltReason})`
      );
    } else {
      const msg = formatMessage(signal, price, rsiArr[i], atrArr[i], time, state.suggestedLot);
      await sendTelegram(msg);
      state.risk.tradesToday += 1;
      console.log(`[${new Date().toISOString()}] Sent ${signal} @ ${price}`);
    }
  } else {
    console.log(`[${new Date().toISOString()}] No new signal (current: ${signal})`);
  }

  // ---- Signal map: entry chart + context chart, each with a trendline ----
  const entryBias = state.lastSignal === "SELL" ? "down" : state.lastSignal === "BUY" ? "up" : closesBias(entryCandles);
  const contextBias = closesBias(contextCandles);

  const entryTrendline = buildTrendline(entryCandles, entryBias);
  const contextTrendline = buildTrendline(contextCandles, contextBias);

  let signalIndex = null;
  if (state.lastSignal && state.lastSignalTime) {
    const idx = entryCandles.findIndex((c) => c.datetime === state.lastSignalTime);
    if (idx >= 0) signalIndex = idx;
  }

  state.chartMap = {
    reason: formatReason(state.lastSignal, price, rsiArr[i], entryBias),
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

// ---------------- Web server ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json(state);
});

// Log the outcome of the last-taken trade against the risk tracker.
// body: { result: "win" | "loss" }
app.post("/api/trade-result", (req, res) => {
  resetDailyIfNeeded();
  const { result } = req.body || {};
  if (result !== "win" && result !== "loss") {
    return res.status(400).json({ error: "result must be 'win' or 'loss'" });
  }

  // Win pays out at the same reward:risk ratio as the TP/SL suggestion (2.5 : 1.5).
  const amount = result === "win" ? RISK_PER_TRADE * (2.5 / 1.5) : -RISK_PER_TRADE;
  state.risk.dailyPnL += amount;
  state.risk.totalPnL += amount;
  state.risk.log.unshift({ time: new Date().toISOString(), result, amount });
  state.risk.log = state.risk.log.slice(0, 50);
  evaluateHalt();

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
  state.risk.dayKey = todayKey();
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
});
