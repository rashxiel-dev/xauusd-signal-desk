const POLL_MS = 20000;

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
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
  const candles = panel.candles;
  const n = candles.length;

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

  document.getElementById("price").textContent =
    state.price !== null ? fmt(state.price) : "—";

  document.getElementById("checked-at").textContent = state.lastChecked
    ? `checked ${timeAgo(state.lastChecked)}`
    : "waiting for first check…";

  drawSpark(state.sparkline);

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
      `Stop loss <span>${fmt(state.suggestedSL)}</span><br>` +
      `Take profit <span>${fmt(state.suggestedTP)}</span><br>` +
      `Fired ${timeAgo(state.lastSignalTime)}`;
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
          `<li><span class="history__signal is-${h.signal.toLowerCase()}">${h.signal}</span><span>${fmt(h.price)} · ${timeAgo(h.time)}</span></li>`
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
    });

    reasonEl.textContent = state.chartMap.reason || "";
  } else {
    reasonEl.textContent = "Waiting for first check…";
  }
}

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
