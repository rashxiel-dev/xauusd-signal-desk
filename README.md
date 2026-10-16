# XAUUSD Signal Desk (web version)

A single Node.js server that:
- keeps checking XAU/USD for an EMA9/21 + RSI crossover on its own schedule
- sends you a Telegram alert the moment one fires — **whether or not the
  dashboard is open in a browser**
- serves a live dashboard page so you can glance at price/signal/history
  from your phone or PC

## Important: this needs to live on a server, not just open in a tab

A browser tab stops running the moment you close it or your laptop
sleeps — so for alerts to keep firing "even when I'm not looking," the
Node process has to run on something that's on 24/7. A free/cheap
persistent host works well for this; static site hosts (Netlify, GitHub
Pages, Vercel's default mode) do **not**, since they don't keep a
background process alive.

## 1. Get your keys (same as the script version)
- **Telegram bot token + chat id** — via @BotFather, see the script
  version's README if you built that first.
- **Twelve Data API key** — free at https://twelvedata.com.

## 2. Run it locally first (sanity check)
```bash
cd forex_signal_website
npm install
cp .env.example .env     # fill in your real keys
npm start
```
Open http://localhost:3000 — you should see the dashboard, with "live"
in the top corner once the first check completes.

## 3. Deploy so it runs 24/7
Pick one:

**Render.com (easiest, has a free web service tier)**
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add the four env vars from `.env.example` in Render's dashboard.
5. Deploy — Render gives you a public URL for the dashboard.
   Note: free instances sleep after inactivity and wake on the next
   HTTP request, which can delay a check cycle — fine for casual use,
   but for zero-gap monitoring use a paid instance or a VPS instead.

**Railway.app / Fly.io**
Similar flow: connect the repo, set the env vars, deploy. Both support
always-on Node processes on low-cost plans.

**Your own VPS (DigitalOcean, Vultr, etc.)**
```bash
git clone <your-repo>
cd forex_signal_website
npm install
cp .env.example .env   # fill in keys
npm install -g pm2
pm2 start server.js --name signal-desk
pm2 save
```
`pm2` keeps it running and restarts it on crash/reboot.

## Customizing
Env vars in `.env`: `SYMBOL`, `INTERVAL`. Strategy constants
(EMA periods, RSI thresholds, SL/TP multipliers) are in `server.js`.

### Signal grades
Every signal still fires, but gets a grade from 4 checks: H4 trend agrees,
regime suits the strategy, another strategy signals the same direction on
the same candle (confluence), and London/New York hours (07:00–20:00 UTC).
A = 3–4 checks, B = 2, C = 0–1. The grade shows in the Telegram alert and
signal history, and the dashboard tallies win rate per grade so you can see
which grades are actually profitable and take only those.

### Breakeven
The stop moves to entry once a trade is `BREAKEVEN_R` times its original
stop distance in profit (default `1.0` = 1R), instead of a flat $2 that
normal gold noise reaches constantly. Set `BREAKEVEN_R=0` to use the old
flat `BREAKEVEN_TRIGGER_PIPS` trigger. Every closed trade logs its peak
favorable move ("peak +$x (yR)") so you can check whether breakeven is
cutting off winners.

### Scale-in rule
If a strategy fires the same direction again while a trade is already open,
it's treated as an **add** to that trade rather than a fresh signal — but
only once the open trade already has a leg at breakeven. The add is sized
at a smaller fixed risk (0.5% of account by default, vs. the full
`RISK_PER_TRADE` on the original entry), and each trade is capped at 1 add
by default. Telegram alerts for an add are labeled `SCALE-IN ADD #1`.
Tune with `SCALE_IN_ENABLED` (`true`/`false`), `SCALE_IN_RISK_PCT`, and
`SCALE_IN_MAX_ADDS`.

## Notes
- This is a technical-indicator signal generator, not financial advice —
  confirm against your own analysis and risk plan before trading.
- EMA crossovers lag and can whipsaw in ranging markets; consider adding
  a longer-timeframe trend filter if you're seeing too many false signals.
- The dashboard shows the same state the server just alerted on — it's a
  window onto the bot, not a second source of truth.
