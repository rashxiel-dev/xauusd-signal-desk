/**
 * XAUUSD Signal Bot — Web Backend
 * --------------------------------
 * Runs the same EMA/RSI/ATR signal logic as the standalone script, but as
 * an always-on web server: it keeps polling and sending Telegram alerts
 * on its own schedule (independent of whether anyone has the dashboard
 * open), and also serves a JSON API + static dashboard so you can check
 * status from a browser.
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
const INTERVAL = process.env.INTERVAL || "15min"; // 1min,5min,15min,30min,1h,4h,1day
const PORT = process.env.PORT || 3000;

const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 25;

const POLL_MS = 15 * 60 * 1000; // check every 15 minutes

// ---------------- In-memory state ----------------
const state = {
  status: "starting", // starting | ok | error
  lastChecked: null,
  lastError: null,
  symbol: SYMBOL,
  interval: INTERVAL,
  price: null,
  rsi: null,
  emaFast: null,
  emaSlow: null,
  atr: null,
  signal: null, // BUY | SELL | null
  suggestedSL: null,
  suggestedTP: null,
  lastSignal: null,
  lastSignalTime: null,
  history: [], // { time, signal, price }[]
  sparkline: [], // recent closes for the mini chart
};

// ---------------- Data ----------------
async function fetchCandles(n = 100) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", INTERVAL);
  url.searchParams.set("outputsize", n);
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
  url.searchParams.set("order", "ASC");

  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) {
    throw new Error(`Twelve Data error: ${JSON.stringify(data)}`);
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

function formatMessage(signal, price, rsiVal, atrVal, time) {
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
    `_Signal only — not financial advice. Confirm before trading._`
  );
}

// ---------------- Core check ----------------
async function checkOnce() {
  const candles = await fetchCandles(100);
  const closes = candles.map((c) => c.close);

  const emaFastArr = ema(closes, EMA_FAST);
  const emaSlowArr = ema(closes, EMA_SLOW);
  const rsiArr = rsi(closes, RSI_PERIOD);
  const atrArr = atr(candles, ATR_PERIOD);

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
  const time = candles[i].datetime;

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

  if (signal) {
    const sl =
      signal === "BUY" ? price - atrArr[i] * 1.5 : price + atrArr[i] * 1.5;
    const tp =
      signal === "BUY" ? price + atrArr[i] * 2.5 : price - atrArr[i] * 2.5;
    state.suggestedSL = sl;
    state.suggestedTP = tp;
  }

  if (signal && signal !== state.lastSignal) {
    const msg = formatMessage(signal, price, rsiArr[i], atrArr[i], time);
    await sendTelegram(msg);
    state.lastSignal = signal;
    state.lastSignalTime = time;
    state.history.unshift({ time, signal, price });
    state.history = state.history.slice(0, 30);
    console.log(`[${new Date().toISOString()}] Sent ${signal} @ ${price}`);
  } else {
    console.log(`[${new Date().toISOString()}] No new signal (current: ${signal})`);
  }
}

async function pollLoop() {
  try {
    await checkOnce();
  } catch (err) {
    state.status = "error";
    state.lastError = err.message;
    console.error("Check failed:", err.message);
  } finally {
    setTimeout(pollLoop, POLL_MS);
  }
}

// ---------------- Web server ----------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json(state);
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
