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

// Optional persistence: saves risk/report data to a private GitHub Gist
// so a redeploy doesn't wipe it. Without these set, the bot still works
// exactly as before, it just starts from zero on every deploy.
const GIST_TOKEN = process.env.GIST_TOKEN || "";
const GIST_ID = process.env.GIST_ID || "";
const PERSISTENCE_ENABLED = !!(GIST_TOKEN && GIST_ID);
const GIST_FILENAME = "signal-desk-state.json";

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
const REQUIRE_TREND_ALIGNMENT = process.env.REQUIRE_TREND_ALIGNMENT !== "false";
const REQUIRE_REGIME_MATCH = process.env.REQUIRE_REGIME_MATCH !== "false";
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || "30", 10);

const POLL_MS = 15 * 60 * 1000; // full candle + signal check, every 15 minutes
const LIVE_POLL_MS = 3 * 60 * 1000; // lightweight price-only tick, every 3 minutes

// ---------------- Challenge / risk config ----------------
const ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || "5000");
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || "200");
const MAX_LOSS_LIMIT = parseFloat(process.env.MAX_LOSS_LIMIT || "350");
const PROFIT_TARGET = parseFloat(process.env.PROFIT_TARGET || "500");
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE || "50");
// Move SL to entry (breakeven) once a trade is this many pips in favor.
// This broker counts 1 pip as $0.10 on XAUUSD, so 20 pips = $2.00.
const BREAKEVEN_TRIGGER_PIPS = parseFloat(process.env.BREAKEVEN_TRIGGER_PIPS || "20");
const BREAKEVEN_TRIGGER_USD = BREAKEVEN_TRIGGER_PIPS * 0.1;
// R-based breakeven: move the stop to entry once the trade is this many
// multiples of its ORIGINAL stop distance in profit (1.0 = "1R"). This
// scales with volatility instead of a flat $2 that normal noise reaches
// constantly. Set BREAKEVEN_R=0 to fall back to the flat-pips trigger.
const BREAKEVEN_R = parseFloat(process.env.BREAKEVEN_R || "1.0");

function breakevenTriggerUsd(leg) {
  if (BREAKEVEN_R > 0 && leg.stopDist > 0) return leg.stopDist * BREAKEVEN_R;
  return BREAKEVEN_TRIGGER_USD;
}
const XAU_LOT_USD_PER_POINT = 100; // 1.00 lot XAUUSD ≈ $100 per $1 move (100oz)

// ---- Scale-in rule ("Risk Officer" style) ----
// If a strategy re-fires the same direction while the open trade is
// already being watched, it's no longer silently dropped from P&L
// tracking. It becomes an "add" to that trade — but only once the
// existing leg has already moved to breakeven, sized at a smaller fixed
// risk (not the full RISK_PER_TRADE), and capped per trade.
const SCALE_IN_ENABLED = process.env.SCALE_IN_ENABLED !== "false";
const SCALE_IN_RISK_PCT = parseFloat(process.env.SCALE_IN_RISK_PCT || "0.5");
const SCALE_IN_RISK_USD = (ACCOUNT_SIZE * SCALE_IN_RISK_PCT) / 100;
const SCALE_IN_MAX_ADDS = parseInt(process.env.SCALE_IN_MAX_ADDS || "1", 10);

// Your local timezone as a fixed UTC offset (hours), used only for the
// daily report's "day boundary" and send time. Maldives is UTC+5, no DST.
const TIMEZONE_OFFSET_HOURS = parseFloat(process.env.TIMEZONE_OFFSET_HOURS || "5");

function localDateKeyFor(date) {
  const local = new Date(date.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

// Extra single-day closures beyond the standard weekend (e.g. Christmas,
// New Year's Day) — comma-separated "YYYY-MM-DD" dates, UTC.
const HOLIDAY_DATES = (process.env.HOLIDAY_DATES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Gold/FX conventionally trades ~23/6, closing Friday ~22:00 UTC and
// reopening Sunday ~22:00 UTC. This is a heuristic, not a broker feed —
// some brokers open a little earlier/later.
function isMarketClosed(now = new Date()) {
  const day = now.getUTCDay(); // 0 = Sun, 6 = Sat
  const hour = now.getUTCHours();

  if (day === 6) return true; // Saturday: fully closed
  if (day === 0 && hour < 22) return true; // Sunday before ~22:00 UTC
  if (day === 5 && hour >= 22) return true; // Friday after ~22:00 UTC

  const todayStr = now.toISOString().slice(0, 10);
  if (HOLIDAY_DATES.includes(todayStr)) return true;

  return false;
}

// Steps forward in 5-minute increments to find when the open/closed
// status next flips — works for the weekend rule AND any date listed
// in HOLIDAY_DATES, without needing separate math for each case.
function findNextMarketTransition(now = new Date()) {
  const currentlyClosed = isMarketClosed(now);
  const stepMs = 5 * 60 * 1000;
  const maxSteps = (8 * 24 * 60) / 5; // scan up to 8 days ahead
  let t = now;

  for (let s = 0; s < maxSteps; s++) {
    t = new Date(t.getTime() + stepMs);
    if (isMarketClosed(t) !== currentlyClosed) {
      return { changesAt: t.toISOString(), willBe: currentlyClosed ? "open" : "closed" };
    }
  }
  return null;
}

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
  strategySignals: { emaCross: null, pullback: null, srBounce: null, breakout: null, rsiReversal: null },
  regime: null,
  dailyReports: [], // { date, trades, wins, losses, winRate, pnl, byStrategy }[]
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

// Same shape, but sized against the smaller scale-in risk budget
// (SCALE_IN_RISK_USD) instead of the full RISK_PER_TRADE.
function computeScaleInLotSize(slDistance) {
  if (!slDistance || slDistance <= 0) return null;
  const raw = SCALE_IN_RISK_USD / (slDistance * XAU_LOT_USD_PER_POINT);
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

// Records a win/loss against the risk tracker (shared by auto-resolution
// and manual override) and, when trade details are available, sends a
// Telegram alert announcing the outcome.
async function applyTradeResult(result, note, details, riskUsd = RISK_PER_TRADE) {
  const amount = result === "win" ? riskUsd * (2.5 / 1.5) : result === "breakeven" ? 0 : -riskUsd;
  state.risk.dailyPnL += amount;
  state.risk.totalPnL += amount;
  state.risk.log.unshift({
    time: new Date().toISOString(),
    result,
    amount,
    note,
    signal: details?.signal || null,
    strategy: details?.strategy || null,
    addNumber: details?.addNumber || 0,
    // peak favorable move (USD and in R) before the trade closed — lets
    // you check whether breakeven is cutting off would-be winners
    mfe: details?.mfe ?? null,
    mfeR: details?.mfeR ?? null,
  });
  state.risk.log = state.risk.log.slice(0, 50);
  evaluateHalt();
  schedulePersist();

  if (details) {
    const emoji = result === "win" ? "✅" : result === "breakeven" ? "⚪" : "❌";
    const label = result === "win" ? "WIN" : result === "breakeven" ? "BREAKEVEN" : "LOSS";
    const exitPrice = result === "win" ? details.tp : details.sl;
    const addTag = details.addNumber ? ` · ADD #${details.addNumber}` : "";
    const msg =
      `${emoji} *${label}* — ${details.signal} ${SYMBOL} _(${details.strategy || "signal"}${addTag})_\n` +
      `Entry ${details.entryPrice.toFixed(2)} → Exit ~${exitPrice.toFixed(2)}\n` +
      `P&L: ${amount >= 0 ? "+" : ""}$${amount.toFixed(2)}\n` +
      `${note === "auto" ? "Auto-resolved against SL/TP" : "Manually logged"}`;
    await sendTelegram(msg);
  }

  return amount;
}

// Watches candles after the open trade's entry. Once price moves
// BREAKEVEN_R x its original stop distance in favor, the stop moves to entry (so a
// reversal from there resolves as breakeven, not a loss) — checked
// before the SL/TP touch on each candle so both can apply in the same
// candle if it's a big range bar. If both SL and TP are touched within
// the same candle, SL is assumed to have hit first (conservative).
// A trade is now (possibly) several legs: the original entry plus any
// scale-in adds, each with its own entry/SL/TP/breakeven state. Each leg
// is watched and resolved independently; the trade as a whole stays
// "open" until every leg has resolved.
async function resolveOpenTrade(entryCandles) {
  const open = state.risk.openTrade;
  if (!open) return;

  const stillOpenLegs = [];
  for (const leg of open.legs) {
    const after = entryCandles.filter((c) => c.datetime > leg.entryTime);
    let resolved = false;

    for (const c of after) {
      const favorableMove = open.signal === "BUY" ? c.high - leg.entryPrice : leg.entryPrice - c.low;
      if (favorableMove > (leg.mfe || 0)) leg.mfe = favorableMove;

      const beTrigger = breakevenTriggerUsd(leg);
      if (!leg.beMoved && beTrigger > 0) {
        if (favorableMove >= beTrigger) {
          leg.sl = leg.entryPrice;
          leg.beMoved = true;
          const addTag = leg.addNumber ? ` ADD #${leg.addNumber}` : "";
          await sendTelegram(
            `🔒 *Breakeven* — ${open.signal} ${SYMBOL} _(${leg.strategy || "signal"}${addTag})_ stop moved to entry ${leg.entryPrice.toFixed(2)} after +$${beTrigger.toFixed(2)} in favor${BREAKEVEN_R > 0 ? ` (${BREAKEVEN_R}R)` : ""}.`
          );
          console.log(
            `[${new Date().toISOString()}] Moved ${open.signal}${addTag} leg to breakeven at ${leg.entryPrice} (candle ${c.datetime})`
          );
          schedulePersist();
        }
      }

      const hitSL = open.signal === "BUY" ? c.low <= leg.sl : c.high >= leg.sl;
      const hitTP = open.signal === "BUY" ? c.high >= leg.tp : c.low <= leg.tp;

      if (hitSL || hitTP) {
        const result = hitSL ? (leg.beMoved ? "breakeven" : "loss") : "win";
        await applyTradeResult(
          result,
          "auto",
          {
            signal: open.signal,
            entryPrice: leg.entryPrice,
            sl: leg.sl,
            tp: leg.tp,
            strategy: leg.strategy,
            addNumber: leg.addNumber,
            mfe: leg.mfe || 0,
            mfeR: leg.stopDist > 0 ? (leg.mfe || 0) / leg.stopDist : null,
          },
          leg.riskUsd
        );
        console.log(
          `[${new Date().toISOString()}] Auto-resolved ${open.signal}${leg.addNumber ? ` ADD #${leg.addNumber}` : ""} leg as ${result.toUpperCase()} (candle ${c.datetime})`
        );
        resolved = true;
        break;
      }
    }

    if (!resolved) stillOpenLegs.push(leg);
  }

  open.legs = stillOpenLegs;
  if (open.legs.length === 0) {
    state.risk.openTrade = null;
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
  url.searchParams.set("timezone", "UTC");

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

// Classifies the market into one of 3 regimes (per the "know the
// environment" framework: same setup, different odds depending on
// regime): trending-up, trending-down, or ranging — plus a separate
// volatility-expansion flag. Trend-following strategies should only
// fire with a matching trend regime; mean-reversion strategies should
// only fire while ranging.
function classifyRegime(candles, emaSlowArr, atrArr, i, lookback = 30) {
  const start = Math.max(0, i - lookback);
  const slice = candles.slice(start, i + 1);
  const emaSlice = emaSlowArr.slice(start, i + 1);

  let aboveCount = 0;
  for (let k = 0; k < slice.length; k++) {
    if (slice[k].close > emaSlice[k]) aboveCount++;
  }
  const aboveRatio = aboveCount / slice.length;
  const bias = closesBias(slice);

  let trend;
  if (bias === "up" && aboveRatio >= 0.58) trend = "trending-up";
  else if (bias === "down" && aboveRatio <= 0.42) trend = "trending-down";
  else trend = "ranging";

  const priorATRs = atrArr.slice(start, i).filter((v) => v !== null);
  const avgATR = priorATRs.length ? priorATRs.reduce((a, b) => a + b, 0) / priorATRs.length : atrArr[i];
  const volatilityExpansion = atrArr[i] !== null && avgATR ? atrArr[i] > avgATR * 1.3 : false;

  return { trend, volatilityExpansion };
}

// ---------------- Strategies ----------------
// Each evaluator looks only at the entry timeframe and returns either
// null (no setup right now) or { signal, sl, tp, reason }. Every
// strategy targets a 2:1 reward:risk minimum per the entry/stop/target
// framework (risk ATR*1.0, target ATR*2.0, scaled per strategy).

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
      tp: price + atrVal * 3.0,
      reason: `EMA${EMA_FAST} crossed above EMA${EMA_SLOW} with RSI at ${rsiArr[i].toFixed(1)} — bullish momentum confirmed.`,
    };
  }
  if (crossedDown && rsiArr[i] > RSI_OVERSOLD) {
    return {
      signal: "SELL",
      sl: price + atrVal * 1.5,
      tp: price - atrVal * 3.0,
      reason: `EMA${EMA_FAST} crossed below EMA${EMA_SLOW} with RSI at ${rsiArr[i].toFixed(1)} — bearish momentum confirmed.`,
    };
  }
  return null;
}

// Price pulls back to the EMA21 ("the 20 EMA") inside an established
// trend and closes back in the trend's direction — the classic
// pullback-entry setup, only valid while the regime is actually trending.
function evaluatePullback(entryCandles, emaSlowArr, atrArr, i, regime) {
  const c = entryCandles[i];
  const atrVal = atrArr[i];
  if (!atrVal) return null;
  const emaMid = emaSlowArr[i];
  const tolerance = atrVal * 0.5;

  if (regime.trend === "trending-up") {
    const touchedEma = c.low <= emaMid + tolerance && c.low >= emaMid - tolerance * 1.5;
    const closedAboveEma = c.close > emaMid;
    const bullishClose = c.close > c.open;
    if (touchedEma && closedAboveEma && bullishClose) {
      const sl = c.low - atrVal * 0.5;
      const tp = c.close + (c.close - sl) * 2.0;
      return {
        signal: "BUY",
        sl,
        tp,
        reason: `Price pulled back to EMA${EMA_SLOW} near ${emaMid.toFixed(2)} in an uptrend and closed bullish — trend pullback entry.`,
      };
    }
  }
  if (regime.trend === "trending-down") {
    const touchedEma = c.high >= emaMid - tolerance && c.high <= emaMid + tolerance * 1.5;
    const closedBelowEma = c.close < emaMid;
    const bearishClose = c.close < c.open;
    if (touchedEma && closedBelowEma && bearishClose) {
      const sl = c.high + atrVal * 0.5;
      const tp = c.close - (sl - c.close) * 2.0;
      return {
        signal: "SELL",
        sl,
        tp,
        reason: `Price pulled back to EMA${EMA_SLOW} near ${emaMid.toFixed(2)} in a downtrend and closed bearish — trend pullback entry.`,
      };
    }
  }
  return null;
}

// Rejection off an auto-drawn support or resistance trendline. Requires
// two candles: the wick-and-close rejection, THEN a follow-through
// candle that closes further in the rejection direction — filters out
// single-candle noise that immediately reverses.
function evaluateSRBounce(entryCandles, atrArr, i, supportLine, resistanceLine) {
  if (i - 1 < 0) return null;
  const rejection = entryCandles[i - 1];
  const confirm = entryCandles[i];
  const atrVal = atrArr[i];
  if (!atrVal) return null;
  const tolerance = atrVal * 0.6;

  if (supportLine) {
    const lineVal = trendlineValueAt(supportLine, i - 1);
    const wickedThrough = rejection.low <= lineVal + tolerance;
    const closedAbove = rejection.close > lineVal;
    const bullishRejection = rejection.close > rejection.open;
    const followsThrough = confirm.close > rejection.close;

    if (wickedThrough && closedAbove && bullishRejection && followsThrough) {
      const sl = rejection.low - atrVal * 0.5;
      const tp = confirm.close + (confirm.close - sl) * 2.0;
      return {
        signal: "BUY",
        sl,
        tp,
        reason: `Price wicked into the support trendline near ${lineVal.toFixed(2)}, closed back above it, and the next candle followed through higher — confirmed rejection bounce.`,
      };
    }
  }

  if (resistanceLine) {
    const lineVal = trendlineValueAt(resistanceLine, i - 1);
    const wickedThrough = rejection.high >= lineVal - tolerance;
    const closedBelow = rejection.close < lineVal;
    const bearishRejection = rejection.close < rejection.open;
    const followsThrough = confirm.close < rejection.close;

    if (wickedThrough && closedBelow && bearishRejection && followsThrough) {
      const sl = rejection.high + atrVal * 0.5;
      const tp = confirm.close - (sl - confirm.close) * 2.0;
      return {
        signal: "SELL",
        sl,
        tp,
        reason: `Price wicked into the resistance trendline near ${lineVal.toFixed(2)}, closed back below it, and the next candle followed through lower — confirmed rejection.`,
      };
    }
  }

  return null;
}

// Close breaks beyond the recent N-candle range with volatility clearly
// expanding (well above its own recent average) — trend continuation.
// Longer lookback + higher expansion bar = fewer, more meaningful breaks.
function evaluateBreakout(entryCandles, atrArr, i, lookback = 40) {
  if (i - lookback < 0) return null;
  const atrVal = atrArr[i];
  if (!atrVal) return null;

  const priorCandles = entryCandles.slice(i - lookback, i);
  const highestHigh = Math.max(...priorCandles.map((c) => c.high));
  const lowestLow = Math.min(...priorCandles.map((c) => c.low));

  const priorATRs = atrArr.slice(i - lookback, i).filter((v) => v !== null);
  const avgATR = priorATRs.length ? priorATRs.reduce((a, b) => a + b, 0) / priorATRs.length : atrVal;
  const expanding = atrVal > avgATR * 1.4;

  const c = entryCandles[i];
  if (c.close > highestHigh && expanding) {
    return {
      signal: "BUY",
      sl: c.close - atrVal * 1.2,
      tp: c.close + atrVal * 2.4,
      reason: `Price closed above the ${lookback}-candle high (${highestHigh.toFixed(2)}) with volatility well above average — breakout continuation.`,
    };
  }
  if (c.close < lowestLow && expanding) {
    return {
      signal: "SELL",
      sl: c.close + atrVal * 1.2,
      tp: c.close - atrVal * 2.4,
      reason: `Price closed below the ${lookback}-candle low (${lowestLow.toFixed(2)}) with volatility well above average — breakdown continuation.`,
    };
  }
  return null;
}

// RSI crossing back out of an extreme (oversold/overbought) — a momentum
// reversal call, distinct from the trend-following strategies above.
function evaluateRsiReversal(entryCandles, rsiArr, atrArr, i) {
  if (i - 1 < 0) return null;
  const prevRsi = rsiArr[i - 1];
  const currRsi = rsiArr[i];
  const atrVal = atrArr[i];
  const price = entryCandles[i].close;
  if (prevRsi === null || currRsi === null || !atrVal) return null;

  if (prevRsi < 30 && currRsi >= 30) {
    return {
      signal: "BUY",
      sl: price - atrVal * 1.3,
      tp: price + atrVal * 2.6,
      reason: `RSI crossed back above 30 (from ${prevRsi.toFixed(1)} to ${currRsi.toFixed(1)}) out of oversold — momentum reversal.`,
    };
  }
  if (prevRsi > 70 && currRsi <= 70) {
    return {
      signal: "SELL",
      sl: price + atrVal * 1.3,
      tp: price - atrVal * 2.6,
      reason: `RSI crossed back below 70 (from ${prevRsi.toFixed(1)} to ${currRsi.toFixed(1)}) out of overbought — momentum reversal.`,
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

function formatMessage(strategyName, signal, price, rsiVal, time, lot, reason, sl, tp, addNumber = 0) {
  const header = addNumber
    ? `*${signal} SCALE-IN ADD #${addNumber} — ${SYMBOL}* _(${strategyName})_`
    : `*${signal} SIGNAL — ${SYMBOL}* _(${strategyName})_`;
  const riskNote = addNumber
    ? `Suggested lot: ${lot ? lot.toFixed(2) : "—"} (add-on risk $${SCALE_IN_RISK_USD.toFixed(2)} — ${SCALE_IN_RISK_PCT}% of account)\n` +
      `_Scale-in: the open leg is already at breakeven, so this add only risks fresh money._\n`
    : `Suggested lot: ${lot ? lot.toFixed(2) : "—"} (risking $${RISK_PER_TRADE} on a $${ACCOUNT_SIZE} account)\n`;
  return (
    `${header}\n` +
    `Time: ${time}\n` +
    `Price: ${price.toFixed(2)}\n` +
    `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}\n` +
    `${reason}\n` +
    `Suggested SL: ${sl.toFixed(2)}\n` +
    `Suggested TP: ${tp.toFixed(2)}\n` +
    riskNote +
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
  if (isMarketClosed()) {
    state.status = "closed";
    state.lastError = null;
    console.log(`[${new Date().toISOString()}] Market closed — skipping check`);
    return;
  }

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
  await resolveOpenTrade(entryCandles);
  evaluateHalt();

  // trendlines used by both the S/R Bounce strategy and the chart map
  const supportLine = buildTrendline(entryCandles, "up");
  const resistanceLine = buildTrendline(entryCandles, "down");

  // Higher-timeframe bias — signals must agree with it (trend filter).
  const htfBias = closesBias(contextCandles);

  // Entry-timeframe regime — trend-following strategies only fire with
  // a matching trend regime; mean-reversion strategies only while ranging.
  const entryRegime = classifyRegime(entryCandles, emaSlowArr, atrArr, i);
  state.regime = entryRegime;

  const strategies = [
    {
      key: "emaCross",
      name: "EMA Cross",
      type: "trend",
      result: evaluateEmaCross(entryCandles, emaFastArr, emaSlowArr, rsiArr, atrArr, i),
    },
    {
      key: "pullback",
      name: "Pullback",
      type: "trend",
      result: evaluatePullback(entryCandles, emaSlowArr, atrArr, i, entryRegime),
    },
    {
      key: "srBounce",
      name: "S/R Bounce",
      type: "reversion",
      result: evaluateSRBounce(entryCandles, atrArr, i, supportLine, resistanceLine),
    },
    {
      key: "breakout",
      name: "Breakout",
      type: "trend",
      result: evaluateBreakout(entryCandles, atrArr, i),
    },
    {
      key: "rsiReversal",
      name: "RSI Reversal",
      type: "reversion",
      result: evaluateRsiReversal(entryCandles, rsiArr, atrArr, i),
    },
  ];

  state.signal = strategies.find((s) => s.result)?.result.signal || null;

  const nowMs = Date.now();
  let anyFired = false;

  for (const strat of strategies) {
    if (!strat.result) continue; // no setup; leave cooldown memory intact

    const { signal, sl, tp, reason } = strat.result;

    // --- Filter 1: regime match ("strategy tells WHAT, regime tells WHEN") ---
    if (REQUIRE_REGIME_MATCH && strat.type === "trend") {
      const regimeOk =
        (signal === "BUY" && entryRegime.trend === "trending-up") ||
        (signal === "SELL" && entryRegime.trend === "trending-down");
      if (!regimeOk) {
        console.log(
          `[${new Date().toISOString()}] ${strat.name} ${signal} skipped — regime is ${entryRegime.trend}, not a matching trend`
        );
        continue;
      }
    } else if (REQUIRE_REGIME_MATCH && strat.type === "reversion" && entryRegime.trend !== "ranging") {
      console.log(
        `[${new Date().toISOString()}] ${strat.name} ${signal} skipped — regime is ${entryRegime.trend}, not ranging`
      );
      continue;
    }

    // --- Filter 2: higher-timeframe trend alignment (trend strategies only — 
    // requiring H4 alignment on a "ranging" reversion signal is nearly a
    // contradiction and was blocking almost everything) ---
    if (REQUIRE_TREND_ALIGNMENT && strat.type === "trend") {
      const aligned =
        (signal === "BUY" && htfBias === "up") || (signal === "SELL" && htfBias === "down");
      if (!aligned) {
        console.log(
          `[${new Date().toISOString()}] ${strat.name} ${signal} skipped — against ${HIGH_INTERVAL} trend (${htfBias})`
        );
        continue;
      }
    }

    // --- Filter 3: per-strategy cooldown on the same direction ---
    const prev = state.strategySignals[strat.key];
    if (prev && prev.lastSignal === signal) {
      const elapsedMin = (nowMs - new Date(prev.firedAtMs || 0).getTime()) / 60000;
      if (elapsedMin < COOLDOWN_MINUTES) {
        console.log(
          `[${new Date().toISOString()}] ${strat.name} ${signal} skipped — cooldown (${Math.round(elapsedMin)}/${COOLDOWN_MINUTES} min)`
        );
        continue;
      }
    }

    state.strategySignals[strat.key] = {
      lastSignal: signal,
      lastTime: time,
      firedAtMs: new Date(nowMs).toISOString(),
    };
    anyFired = true;

    // Scale-in decision: if a trade is already open in the SAME
    // direction, this re-fire is a candidate add, not a brand-new trade.
    // It only proceeds once the open trade already has a leg at
    // breakeven, and only up to SCALE_IN_MAX_ADDS adds per trade.
    // A trade open in the OPPOSITE direction, or any re-fire with scale-in
    // disabled, falls back to the original behavior: alert sent, not
    // tracked for P&L (this dashboard watches one trade at a time).
    let addNumber = 0;
    let trackThis = !state.risk.openTrade;
    if (state.risk.openTrade && SCALE_IN_ENABLED && state.risk.openTrade.signal === signal) {
      const legs = state.risk.openTrade.legs;
      const addsSoFar = legs.filter((l) => l.addNumber > 0).length;
      const anyAtBreakeven = legs.some((l) => l.beMoved);
      if (addsSoFar < SCALE_IN_MAX_ADDS && anyAtBreakeven) {
        addNumber = addsSoFar + 1;
        trackThis = true;
      } else {
        console.log(
          `[${new Date().toISOString()}] ${strat.name} ${signal} not scaled in — ${
            addsSoFar >= SCALE_IN_MAX_ADDS ? `add cap (${SCALE_IN_MAX_ADDS}) reached` : "open leg not at breakeven yet"
          }`
        );
      }
    }

    // Volatility expansion → position size may need to decrease.
    let lot = addNumber > 0 ? computeScaleInLotSize(Math.abs(price - sl)) : computeLotSize(Math.abs(price - sl));
    if (entryRegime.volatilityExpansion && lot) {
      lot = Math.max(0.01, Math.round(lot * 0.7 * 100) / 100);
    }

    state.lastSignal = signal;
    state.lastSignalTime = time;
    state.lastSignalPrice = price;
    state.lastSignalStrategy = strat.name;
    state.lastSignalReason = reason;
    state.suggestedSL = sl;
    state.suggestedTP = tp;
    state.suggestedLot = lot;
    state.history.unshift({ time, signal, price, strategy: strat.name, addNumber });
    state.history = state.history.slice(0, 30);

    if (state.risk.halted) {
      console.log(
        `[${new Date().toISOString()}] ${strat.name} ${signal} suppressed — risk halt active (${state.risk.haltReason})`
      );
      continue;
    }

    const msg = formatMessage(strat.name, signal, price, rsiArr[i], time, lot, reason, sl, tp, addNumber);
    await sendTelegram(msg);
    state.risk.tradesToday += 1;

    if (!state.risk.openTrade) {
      state.risk.openTrade = {
        signal,
        legs: [
          { entryPrice: price, sl, tp, entryTime: time, strategy: strat.name, beMoved: false, addNumber: 0, riskUsd: RISK_PER_TRADE, lot, stopDist: Math.abs(price - sl), mfe: 0 },
        ],
      };
    } else if (trackThis && addNumber > 0) {
      state.risk.openTrade.legs.push({
        entryPrice: price,
        sl,
        tp,
        entryTime: time,
        strategy: strat.name,
        beMoved: false,
        addNumber,
        riskUsd: SCALE_IN_RISK_USD,
        lot,
        stopDist: Math.abs(price - sl),
        mfe: 0,
      });
    } else {
      console.log(
        `[${new Date().toISOString()}] ${strat.name} ${signal} fired while a trade is still open — not auto-tracked for P&L`
      );
    }

    console.log(`[${new Date().toISOString()}] Sent ${strat.name} ${signal}${addNumber ? ` (ADD #${addNumber})` : ""} @ ${price}`);
    schedulePersist();
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

  state.htfBias = htfBias;
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

// ---------------- Daily reports ----------------
// Builds a summary of every trade resolved (win or loss) on a given
// local calendar day, broken down by strategy.
function buildDailyReport(dateKey) {
  const entries = state.risk.log.filter((l) => localDateKeyFor(new Date(l.time)) === dateKey);
  const wins = entries.filter((e) => e.result === "win");
  const losses = entries.filter((e) => e.result === "loss");
  const breakevens = entries.filter((e) => e.result === "breakeven");
  const pnl = entries.reduce((a, e) => a + e.amount, 0);

  const byStrategy = {};
  entries.forEach((e) => {
    const key = e.strategy || "Manual";
    if (!byStrategy[key]) byStrategy[key] = { wins: 0, losses: 0, breakevens: 0, pnl: 0 };
    if (e.result === "win") byStrategy[key].wins += 1;
    else if (e.result === "breakeven") byStrategy[key].breakevens += 1;
    else byStrategy[key].losses += 1;
    byStrategy[key].pnl += e.amount;
  });

  return {
    date: dateKey,
    trades: entries.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate: entries.length ? (wins.length / entries.length) * 100 : 0,
    pnl,
    byStrategy,
  };
}

function formatDailyReportMessage(r) {
  const lines = [
    `📊 *Daily Report — ${r.date}*`,
    "",
    `Trades: ${r.trades} (${r.wins}W / ${r.losses}L / ${r.breakevens || 0}BE${r.trades ? `, ${r.winRate.toFixed(0)}% win rate` : ""})`,
    `Net P&L: ${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}`,
  ];
  if (r.trades) {
    lines.push("", "By strategy:");
    Object.entries(r.byStrategy).forEach(([name, s]) => {
      lines.push(`• ${name}: ${s.wins}W/${s.losses}L/${s.breakevens || 0}BE, ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`);
    });
  } else {
    lines.push("", "_No trades resolved today._");
  }
  return lines.join("\n");
}

let lastReportLocalDate = null;

// Fires once per local day, right after local midnight, summarizing the
// day that just ended. Works off wall-clock time, independent of
// market hours, so it still sends on weekends/holidays if trades
// happened to resolve right before the close.
async function maybeSendDailyReport() {
  const now = new Date();
  const local = new Date(now.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000);
  const isJustAfterMidnight = local.getUTCHours() === 0 && local.getUTCMinutes() < 15;
  const todayLocalKey = localDateKeyFor(now);

  if (isJustAfterMidnight && lastReportLocalDate !== todayLocalKey) {
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const reportDateKey = localDateKeyFor(yesterday);
    const report = buildDailyReport(reportDateKey);

    state.dailyReports.unshift(report);
    state.dailyReports = state.dailyReports.slice(0, 60);
    await sendTelegram(formatDailyReportMessage(report));

    lastReportLocalDate = todayLocalKey;
    console.log(`[${new Date().toISOString()}] Sent daily report for ${reportDateKey}`);
    schedulePersist();
  }
}

// Lightweight tick between structural checks so the price/chart feel live.
async function liveLoop() {
  try {
    if (!isMarketClosed()) {
      const price = await fetchQuote();
      state.livePrice = price;
      state.liveCheckedAt = new Date().toISOString();
    }
    await maybeSendDailyReport();
  } catch (err) {
    console.error("Live quote failed:", err.message);
  } finally {
    setTimeout(liveLoop, LIVE_POLL_MS);
  }
}

// ---------------- Persistence (GitHub Gist) ----------------
// Only the data that should survive a redeploy — not live market
// snapshots like price/RSI/chart, which refresh from the API anyway
// within a few minutes of startup.
function persistableSnapshot() {
  return {
    risk: state.risk,
    dailyReports: state.dailyReports,
    strategySignals: state.strategySignals,
    lastSignal: state.lastSignal,
    lastSignalTime: state.lastSignalTime,
    lastSignalPrice: state.lastSignalPrice,
    lastSignalStrategy: state.lastSignalStrategy,
    lastSignalReason: state.lastSignalReason,
    history: state.history,
    savedAt: new Date().toISOString(),
  };
}

async function loadPersistedState() {
  if (!PERSISTENCE_ENABLED) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `token ${GIST_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });
    const data = await res.json();
    const file = data.files && data.files[GIST_FILENAME];
    if (!file || !file.content) {
      console.log("No prior saved state found in Gist — starting fresh.");
      return;
    }
    const saved = JSON.parse(file.content);

    if (saved.risk) Object.assign(state.risk, saved.risk);

    // Migrate a trade saved in the old single-leg shape (pre scale-in)
    // into the legs[] shape so a redeploy mid-trade can't crash resolution.
    const ot = state.risk.openTrade;
    if (ot && !Array.isArray(ot.legs)) {
      state.risk.openTrade = {
        signal: ot.signal,
        legs: [
          {
            entryPrice: ot.entryPrice, sl: ot.sl, tp: ot.tp, entryTime: ot.entryTime,
            strategy: ot.strategy, beMoved: !!ot.beMoved, addNumber: 0, riskUsd: RISK_PER_TRADE,
            stopDist: 0, mfe: 0,
          },
        ],
      };
    }
    state.dailyReports = saved.dailyReports || [];
    state.strategySignals = saved.strategySignals || state.strategySignals;
    state.lastSignal = saved.lastSignal ?? null;
    state.lastSignalTime = saved.lastSignalTime ?? null;
    state.lastSignalPrice = saved.lastSignalPrice ?? null;
    state.lastSignalStrategy = saved.lastSignalStrategy ?? null;
    state.lastSignalReason = saved.lastSignalReason ?? null;
    state.history = saved.history || [];

    console.log(`Restored saved state from Gist (last saved ${saved.savedAt || "unknown time"}).`);
  } catch (err) {
    console.error("Failed to load persisted state:", err.message);
  }
}

let persistTimer = null;
function schedulePersist() {
  if (!PERSISTENCE_ENABLED) return;
  clearTimeout(persistTimer);
  // debounce so several rapid changes only trigger one save
  persistTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: "PATCH",
        headers: {
          Authorization: `token ${GIST_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: { [GIST_FILENAME]: { content: JSON.stringify(persistableSnapshot(), null, 2) } },
        }),
      });
      if (!res.ok) {
        console.error("Persist to Gist failed:", res.status, await res.text());
      }
    } catch (err) {
      console.error("Persist to Gist failed:", err.message);
    }
  }, 5000);
}

// ---------------- Web server ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({ ...state, marketTransition: findNextMarketTransition() });
});

// Log the outcome of the currently open trade (manual override — the
// bot normally resolves this itself against SL/TP). Falls back to a
// generic log entry if nothing is currently open.
// body: { result: "win" | "loss" }
app.post("/api/trade-result", async (req, res) => {
  resetDailyIfNeeded();
  const { result } = req.body || {};
  if (result !== "win" && result !== "loss") {
    return res.status(400).json({ error: "result must be 'win' or 'loss'" });
  }

  const open = state.risk.openTrade;
  if (open) {
    // Manual override closes every open leg (original + any scale-in
    // adds) at once, each logged against its own risk size.
    for (const leg of open.legs) {
      await applyTradeResult(
        result,
        "manual override",
        { signal: open.signal, entryPrice: leg.entryPrice, sl: leg.sl, tp: leg.tp, strategy: leg.strategy, addNumber: leg.addNumber, mfe: leg.mfe || 0, mfeR: leg.stopDist > 0 ? (leg.mfe || 0) / leg.stopDist : null },
        leg.riskUsd
      );
    }
  } else {
    await applyTradeResult(result, "manual", null);
  }
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
  schedulePersist();
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
  state.strategySignals = { emaCross: null, pullback: null, srBounce: null, breakout: null, rsiReversal: null };
  schedulePersist();
  res.json({ ok: true, risk: state.risk });
});

app.listen(PORT, async () => {
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

  if (PERSISTENCE_ENABLED) {
    await loadPersistedState();
  } else {
    console.log("GIST_TOKEN/GIST_ID not set — running without persistence (data resets on every deploy).");
  }

  pollLoop();
  liveLoop();
});
