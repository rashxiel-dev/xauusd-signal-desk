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
