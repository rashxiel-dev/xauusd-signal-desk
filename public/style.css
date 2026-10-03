const POLL_MS = 20000;

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function asUTCDate(raw) {
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = asUTCDate(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Math.max(0, Date.now() - asUTCDate(iso).getTime());
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
  svg.innerHTML = `<path d="M${points.join(" L")}" style="fill:none;stroke:var(--gold);stroke-width:1.5;" />`;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function render(state) {
  const pulse = document.getElementById("pulse");
  const pulseText = document.getElementById("pulse-text");

  if (state.status === "ok") {
    pulse.className = "desk__pulse is-live";
    pulseText.textContent = "live";
  } else if (state.status === "closed") {
    pulse.className = "desk__pulse";
    pulseText.textContent = "market closed";
  } else if (state.status === "not-started") {
    pulse.className = "desk__pulse";
    pulseText.textContent = state.competition && state.competition.startDate
      ? `starts ${state.competition.startDate}`
      : "not started";
  } else if (state.status === "error") {
    pulse.className = "desk__pulse is-down";
    pulseText.textContent = state.lastError || "error";
  } else {
    pulse.className = "desk__pulse";
    pulseText.textContent = "starting";
  }

  const biasLabel = state.htfBias ? ` · H4 trend ${state.htfBias === "up" ? "▲ up" : "▼ down"}` : "";
  document.getElementById("pair-line").textContent =
    `${state.symbol || "XAU/USD"} · ${state.interval || "15min"} · manual signals, not an EA${biasLabel}`;

  const displayPrice = state.livePrice ?? state.price;
  document.getElementById("price").textContent = displayPrice != null ? fmt(displayPrice) : "—";
  document.getElementById("checked-at").textContent = state.lastChecked
    ? `checked ${timeAgo(state.lastChecked)}`
    : "waiting for first check…";

  drawSpark(state.livePrice != null ? [...(state.sparkline || []), state.livePrice] : state.sparkline);

  document.getElementById("rsi-val").textContent = fmt(state.rsi, 1);
  document.getElementById("ema-fast").textContent = fmt(state.emaFast);
  document.getElementById("ema-slow").textContent = fmt(state.emaSlow);
  document.getElementById("atr-val").textContent = fmt(state.atr);

  const sigWord = document.getElementById("signal-word");
  const sigTargets = document.getElementById("signal-targets");
  const activeSignal = state.lastSignal;
  sigWord.textContent = activeSignal || "NONE";
  sigWord.className = "signal" + (activeSignal === "BUY" ? " is-buy" : activeSignal === "SELL" ? " is-sell" : "");

  if (activeSignal) {
    sigTargets.innerHTML =
      `Entry zone <span>${fmt(state.lastSignalPrice)}</span><br>` +
      `Strategy <span>${state.lastSignalStrategy || "—"}</span><br>` +
      `Fired <span>${formatDateTime(state.lastSignalTime)}</span> (${timeAgo(state.lastSignalTime)})`;
  } else {
    sigTargets.textContent = "No active setup — watching for the next one.";
  }

  const list = document.getElementById("history-list");
  if (!state.history || state.history.length === 0) {
    list.innerHTML = `<li class="history__empty">No signals fired yet.</li>`;
  } else {
    list.innerHTML = state.history
      .map((h) => `<li><span class="history__signal is-${h.signal.toLowerCase()}">${h.signal}${h.strategy ? ` · ${h.strategy}` : ""}</span><span>${fmt(h.price)} · ${formatDateTime(h.time)}</span></li>`)
      .join("");
  }

  if (state.competition) renderCompetition(state.competition);
}

function renderCompetition(c) {
  const banner = document.getElementById("comp-banner");
  if (c.halted) {
    banner.style.display = "block";
    banner.textContent =
      c.haltReason === "max"
        ? `Max loss limit reached ($${c.maxLossLimit}) — stop trading on this account per the rules.`
        : `Daily loss limit reached ($${c.dailyLossLimit}) — trading restricted on this account today.`;
  } else {
    banner.style.display = "none";
  }

  document.getElementById("comp-daily-limit").textContent = `/ -$${c.dailyLossLimit}`;
  document.getElementById("comp-total-limit").textContent = `/ -$${c.maxLossLimit}`;

  const dailyPct = Math.min(100, (Math.abs(c.dailyPnL) / c.dailyLossLimit) * 100);
  const dailyFill = document.getElementById("comp-daily-fill");
  dailyFill.style.width = `${c.dailyPnL < 0 ? dailyPct : 0}%`;
  dailyFill.className = "riskbar__fill" + (c.dailyPnL < 0 ? " is-loss" : "");
  document.getElementById("comp-daily-value").textContent = `${c.dailyPnL >= 0 ? "+" : ""}$${c.dailyPnL.toFixed(2)}`;

  const totalPct = Math.min(100, (Math.abs(c.totalPnL) / c.maxLossLimit) * 100);
  const totalFill = document.getElementById("comp-total-fill");
  totalFill.style.width = `${totalPct}%`;
  totalFill.className = "riskbar__fill" + (c.totalPnL < 0 ? " is-loss" : "");
  document.getElementById("comp-total-value").textContent = `${c.totalPnL >= 0 ? "+" : ""}$${c.totalPnL.toFixed(2)}`;

  document.getElementById("comp-meta").innerHTML =
    `Trades today: ${c.tradesToday}/${c.maxTradesPerDay} &middot; Open positions: ${c.openPositions.length}/${c.maxOpenPositions} &middot; ` +
    `Trading days: ${c.tradingDays.length}/${c.minTradingDays} &middot; $${c.riskPerTrade} risked per trade &middot; $${c.commissionPerLot}/lot commission`;

  const posList = document.getElementById("positions-list");
  if (!c.openPositions || c.openPositions.length === 0) {
    posList.innerHTML = `<li class="positions__empty">No open positions.</li>`;
  } else {
    posList.innerHTML = c.openPositions
      .map(
        (p, idx) => `
        <li>
          <span><span class="is-${p.signal.toLowerCase()}">${p.signal}</span> from ${fmt(p.entryPrice)} · lot ${fmt(p.lot)} · SL ${fmt(p.sl)} / TP ${fmt(p.tp)}${p.beMoved ? " · BE" : ""} <span style="color:var(--text-muted);">(${p.strategy})</span></span>
          <span class="positions__actions">
            <button class="is-win" onclick="closePosition(${idx},'win')">Mark Win</button>
            <button class="is-loss" onclick="closePosition(${idx},'loss')">Mark Loss</button>
            <button onclick="closePosition(${idx},'breakeven')">Mark BE</button>
          </span>
        </li>`
      )
      .join("");
  }

  const log = document.getElementById("comp-log");
  if (!c.log || c.log.length === 0) {
    log.innerHTML = `<li class="history__empty">No trades logged yet.</li>`;
  } else {
    log.innerHTML = c.log
      .map(
        (l) =>
          `<li><span class="is-${l.result}">${l.result.toUpperCase()}${l.strategy ? ` · ${l.strategy}` : ""}</span><span>${l.amount >= 0 ? "+" : ""}$${l.amount.toFixed(2)} · ${timeAgo(l.time)}</span></li>`
      )
      .join("");
  }
}

async function closePosition(index, result) {
  await postJSON("/api/close-position", { index, result });
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

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-reset-day").addEventListener("click", async () => {
    if (confirm("Reset today's P&L and trade count?")) await postJSON("/api/reset-day");
  });
  document.getElementById("btn-reset-competition").addEventListener("click", async () => {
    if (confirm("Reset the ENTIRE competition tracker (daily + total P&L, log, open positions)? This can't be undone.")) {
      await postJSON("/api/reset-competition");
    }
  });
});

poll();
