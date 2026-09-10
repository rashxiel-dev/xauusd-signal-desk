const POLL_MS = 20000;

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function drawSpark(values) {
  const svg = document.getElementById("spark");
  if (!values || values.length < 2) {
    svg.innerHTML = "";
    return;
  }
  const w = 400, h = 90, pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1);

  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  svg.innerHTML = `<path d="M${points.join(" L")}" />`;
}

// ---------------- Candlestick chart ----------------
function drawChart(svgId, panel, opts = {}) {
  const svg = document.getElementById(svgId);
  if (!panel || !panel.candles || panel.candles.length === 0) {
    svg.innerHTML = "";
    return;
  }

  const W = 500, H = 300;
  const padTop = 14, padBottom = 14, padLeft = 6, padRight = 54;
  const rawCandles = panel.candles;
  const n = rawCandles.length;

  // extend the last candle live using the most recent quote, so the
  // chart visibly moves between full 15-min checks
  let candles = rawCandles;
  if (opts.livePrice !== null && opts.livePrice !== undefined && n > 0) {
    candles = rawCandles.slice();
    const last = candles[n - 1];
    candles[n - 1] = {
      ...last,
      c: opts.livePrice,
      h: Math.max(last.h, opts.livePrice),
      l: Math.min(last.l, opts.livePrice),
    };
  }

  let min = Math.min(...candles.map((c) => c.l));
  let max = Math.max(...candles.map((c) => c.h));
  if (panel.trendline) {
    min = Math.min(min, panel.trendline.p1.price, panel.trendline.p2.price);
    max = Math.max(max, panel.trendline.p1.price, panel.trendline.p2.price);
  }
  const range = max - min || 1;

  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;
  const step = plotW / n;
  const bodyW = Math.max(1.5, step * 0.55);

  const xAt = (i) => padLeft + i * step + step / 2;
  const yAt = (price) => padTop + plotH - ((price - min) / range) * plotH;

  let svgParts = [];

  // price axis gridlines (drawn first so candles sit on top)
  const mid = (min + max) / 2;
  [
    { price: max, y: padTop },
    { price: mid, y: padTop + plotH / 2 },
    { price: min, y: padTop + plotH },
  ].forEach(({ price, y }) => {
    svgParts.push(
      `<line x1="${padLeft}" y1="${y}" x2="${W - padRight}" y2="${y}" stroke="#2a2c22" stroke-width="0.75" />`
    );
    svgParts.push(
      `<text x="${W - padRight - 4}" y="${y - 3}" text-anchor="end" font-size="9" fill="#8b8a78" font-family="IBM Plex Mono, monospace">${price.toFixed(2)}</text>`
    );
  });

  // candles
  candles.forEach((c, i) => {
    const x = xAt(i);
    const up = c.c >= c.o;
    const yHigh = yAt(c.h);
    const yLow = yAt(c.l);
    const yOpen = yAt(c.o);
    const yClose = yAt(c.c);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));

    svgParts.push(
      `<line class="${up ? "wick-up" : "wick-down"}" x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke-width="1" />`
    );
    svgParts.push(
      `<rect class="${up ? "candle-up" : "candle-down"}" x="${x - bodyW / 2}" y="${bodyTop}" width="${bodyW}" height="${bodyH}" />`
    );
  });

  // EMA overlays (entry panel only)
  if (panel.emaFast) {
    const pts = panel.emaFast.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
    svgParts.push(`<polyline class="ema-fast" points="${pts.join(" ")}" />`);
  }
  if (panel.emaSlow) {
    const pts = panel.emaSlow.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
    svgParts.push(`<polyline class="ema-slow" points="${pts.join(" ")}" />`);
  }

  // trendline
  if (panel.trendline) {
    const { p1, p2 } = panel.trendline;
    svgParts.push(
      `<line class="trendline" x1="${xAt(p1.index)}" y1="${yAt(p1.price)}" x2="${xAt(p2.index)}" y2="${yAt(p2.price)}" />`
    );
  }

  // signal arrow
  if (opts.signalIndex !== null && opts.signalIndex !== undefined && opts.signalIndex >= 0) {
    const c = candles[opts.signalIndex];
    if (c) {
      const x = xAt(opts.signalIndex);
      const isSell = opts.signalType === "SELL";
      const y = isSell ? yAt(c.h) - 10 : yAt(c.l) + 10;
      const tip = isSell ? y + 8 : y - 8;
      const cls = isSell ? "is-sell" : "is-buy";
      // simple triangle pointing toward the candle
      const trianglePoints = isSell
        ? `${x - 5},${y - 6} ${x + 5},${y - 6} ${x},${y + 4}`
        : `${x - 5},${y + 6} ${x + 5},${y + 6} ${x},${y - 4}`;
      svgParts.push(`<polygon class="signal-arrow ${cls}" points="${trianglePoints}" />`);
    }
  }

  // last price marker — dashed line + gold label at the current close
  const lastClose = candles[candles.length - 1].c;
  const yLast = yAt(lastClose);
  svgParts.push(
    `<line x1="${padLeft}" y1="${yLast}" x2="${W - padRight}" y2="${yLast}" stroke="#c9a227" stroke-width="0.75" stroke-dasharray="3 2" opacity="0.6" />`
  );
  svgParts.push(
    `<text x="${W - padRight + 4}" y="${yLast + 3}" font-size="9" fill="#c9a227" font-family="IBM Plex Mono, monospace" font-weight="600">${lastClose.toFixed(2)}</text>`
  );

  svg.innerHTML = svgParts.join("");
}

function render(state) {
  const pulse = document.getElementById("pulse");
  const pulseText = document.getElementById("pulse-text");

  if (state.status === "ok") {
    pulse.className = "desk__pulse is-live";
    pulseText.textContent = "live";
  } else if (state.status === "error") {
    pulse.className = "desk__pulse is-down";
    pulseText.textContent = state.lastError || "error";
  } else {
    pulse.className = "desk__pulse";
    pulseText.textContent = "starting";
  }

  document.getElementById("pair-line").textContent =
    `${state.symbol || "XAU/USD"} · ${state.interval || "15min"} · EMA 9/21 + RSI`;

  const displayPrice =
    state.livePrice !== null && state.livePrice !== undefined ? state.livePrice : state.price;
  document.getElementById("price").textContent =
    displayPrice !== null && displayPrice !== undefined ? fmt(displayPrice) : "—";

  const checkedText = state.liveCheckedAt
    ? `live tick ${timeAgo(state.liveCheckedAt)} · full check ${timeAgo(state.lastChecked)}`
    : state.lastChecked
    ? `checked ${timeAgo(state.lastChecked)}`
    : "waiting for first check…";
  document.getElementById("checked-at").textContent = checkedText;

  drawSpark(
    state.livePrice !== null && state.livePrice !== undefined
      ? [...(state.sparkline || []), state.livePrice]
      : state.sparkline
  );

  document.getElementById("rsi-val").textContent = fmt(state.rsi, 1);
  document.getElementById("ema-fast").textContent = fmt(state.emaFast);
  document.getElementById("ema-slow").textContent = fmt(state.emaSlow);
  document.getElementById("atr-val").textContent = fmt(state.atr);

  const sigWord = document.getElementById("signal-word");
  const sigTargets = document.getElementById("signal-targets");
  const activeSignal = state.lastSignal;

  sigWord.textContent = activeSignal || "NONE";
  sigWord.className = "signal" + (activeSignal === "BUY" ? " is-buy" : activeSignal === "SELL" ? " is-sell" : "");

  if (activeSignal && state.suggestedSL && state.suggestedTP) {
    sigTargets.innerHTML =
      `Entry zone <span>${fmt(state.lastSignalPrice)}</span><br>` +
      `Stop loss <span>${fmt(state.suggestedSL)}</span><br>` +
      `Take profit <span>${fmt(state.suggestedTP)}</span><br>` +
      `Suggested lot <span>${state.suggestedLot ? state.suggestedLot.toFixed(2) : "—"}</span><br>` +
      `Fired <span>${formatDateTime(state.lastSignalTime)}</span> (${timeAgo(state.lastSignalTime)})`;
  } else {
    sigTargets.textContent = "No active crossover — watching for the next one.";
  }

  const list = document.getElementById("history-list");
  if (!state.history || state.history.length === 0) {
    list.innerHTML = `<li class="history__empty">No signals fired yet.</li>`;
  } else {
    list.innerHTML = state.history
      .map(
        (h) =>
          `<li><span class="history__signal is-${h.signal.toLowerCase()}">${h.signal}${h.strategy ? ` · ${h.strategy}` : ""}</span><span>${fmt(h.price)} · ${formatDateTime(h.time)}</span></li>`
      )
      .join("");
  }

  // signal map
  const reasonEl = document.getElementById("reason-text");
  if (state.chartMap) {
    document.getElementById("context-label").textContent =
      `${state.chartMap.context.interval} · context`;
    document.getElementById("entry-label").textContent =
      `${state.chartMap.entry.interval} · entry`;

    drawChart("chart-context", state.chartMap.context);
    drawChart("chart-entry", state.chartMap.entry, {
      signalIndex: state.chartMap.entry.signalIndex,
      signalType: state.chartMap.entry.signalType,
      livePrice: state.livePrice,
    });

    reasonEl.textContent = state.chartMap.reason || "";
  } else {
    reasonEl.textContent = "Waiting for first check…";
  }

  // risk manager
  if (state.risk) renderRisk(state.risk);
}

function renderRisk(risk) {
  const banner = document.getElementById("risk-banner");
  if (risk.halted) {
    banner.style.display = "block";
    banner.textContent =
      risk.haltReason === "max"
        ? `Max loss limit reached ($${risk.maxLossLimit}) — new trade alerts are suppressed until you reset the challenge.`
        : `Daily loss limit reached ($${risk.dailyLossLimit}) — new trade alerts are paused until the day resets.`;
  } else {
    banner.style.display = "none";
  }

  document.getElementById("risk-daily-limit").textContent = `/ -$${risk.dailyLossLimit}`;
  document.getElementById("risk-total-limit").textContent = `/ -$${risk.maxLossLimit} · target +$${risk.profitTarget}`;

  const dailyPct = Math.min(100, Math.abs(risk.dailyPnL) / risk.dailyLossLimit * 100);
  const dailyFill = document.getElementById("risk-daily-fill");
  dailyFill.style.width = `${risk.dailyPnL < 0 ? dailyPct : 0}%`;
  dailyFill.className = "riskbar__fill" + (risk.dailyPnL < 0 ? " is-loss" : "");
  document.getElementById("risk-daily-value").textContent =
    `${risk.dailyPnL >= 0 ? "+" : ""}$${risk.dailyPnL.toFixed(2)}`;

  const totalBasis = risk.totalPnL < 0 ? risk.maxLossLimit : risk.profitTarget;
  const totalPct = Math.min(100, Math.abs(risk.totalPnL) / totalBasis * 100);
  const totalFill = document.getElementById("risk-total-fill");
  totalFill.style.width = `${totalPct}%`;
  totalFill.className = "riskbar__fill" + (risk.totalPnL < 0 ? " is-loss" : "");
  document.getElementById("risk-total-value").textContent =
    `${risk.totalPnL >= 0 ? "+" : ""}$${risk.totalPnL.toFixed(2)}`;

  document.getElementById("risk-meta").textContent =
    `$${risk.riskPerTrade} risked per trade on a $${risk.accountSize} account · ${risk.tradesToday} alert(s) sent today`;

  const openEl = document.getElementById("risk-open-trade");
  if (risk.openTrade) {
    const o = risk.openTrade;
    openEl.style.display = "block";
    openEl.innerHTML =
      `Watching open <span class="is-${o.signal === "BUY" ? "win" : "loss"}">${o.signal}</span> from ${fmt(o.entryPrice)} — ` +
      `auto-resolves on SL ${fmt(o.sl)} / TP ${fmt(o.tp)} touch. Use the buttons below only to override.`;
  } else {
    openEl.style.display = "none";
  }

  const log = document.getElementById("risk-log");
  if (!risk.log || risk.log.length === 0) {
    log.innerHTML = `<li>No trades logged yet.</li>`;
  } else {
    log.innerHTML = risk.log
      .map(
        (l) =>
          `<li><span class="is-${l.result}">${l.result.toUpperCase()}</span><span>${l.amount >= 0 ? "+" : ""}$${l.amount.toFixed(2)} · ${timeAgo(l.time)}</span></li>`
      )
      .join("");
  }

  const winBtn = document.getElementById("btn-log-win");
  const lossBtn = document.getElementById("btn-log-loss");
  winBtn.disabled = risk.halted;
  lossBtn.disabled = false; // always allow logging a loss even if halted
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-log-win").addEventListener("click", async () => {
    await postJSON("/api/trade-result", { result: "win" });
  });
  document.getElementById("btn-log-loss").addEventListener("click", async () => {
    await postJSON("/api/trade-result", { result: "loss" });
  });
  document.getElementById("btn-reset-day").addEventListener("click", async () => {
    if (confirm("Reset today's P&L and trade count?")) await postJSON("/api/reset-day");
  });
  document.getElementById("btn-reset-challenge").addEventListener("click", async () => {
    if (confirm("Reset the ENTIRE challenge tracker (daily + total P&L, log)? This can't be undone.")) {
      await postJSON("/api/reset-challenge");
    }
  });
});

async function poll() {
  try {
    const res = await fetch("/api/status");
    const state = await res.json();
    render(state);
  } catch (err) {
    const pulse = document.getElementById("pulse");
    pulse.className = "desk__pulse is-down";
    document.getElementById("pulse-text").textContent = "unreachable";
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

poll();
