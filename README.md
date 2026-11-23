# Orderflow AI Scanner (GitHub version)

Two parts. You can use either one on its own.

1. **The app** (`docs/index.html`): a phone-friendly page with live candles, a countdown to bar close, order flow (heat map, DOM, real footprint, volume profile, VWAP), a multi-pair scan, a news calendar with alerts, signal history and risk settings. It runs in your browser and reads Hyperliquid's free public feed directly.
2. **The cloud scanner** (`.github/workflows/scan.yml`, `scan.mjs`, `worker.js`): runs every 5 minutes on GitHub, asks Claude for a signal, and can alert you on Telegram. MT5 execution is OFF by default.

## Put the app online (about 5 minutes)
1. On github.com create a **public** repository (for example `orderflow-scanner`).
2. Upload everything from this zip, keeping the folders. If your phone cannot upload the hidden `.github` folder, skip it for now: the app does not need it.
3. Repository **Settings > Pages**. Source: "Deploy from a branch". Branch: `main`, folder: `/docs`. Save.
4. After a minute your app is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.
5. Open it, go to **Settings > Claude API key** and paste your key from console.anthropic.com. It is stored only in your browser. Set a monthly spend limit on that key.

Everything except the AI scan and the calendar import works without a key.

## News calendar
Open the **News** tab. Paste a week of events from any economic calendar site, or upload a screenshot of one. Claude reads it into your calendar. Check the times against your broker. Alerts appear as a banner (15, 30 or 60 minutes before, set in Settings) while the app is open.

## Optional: cloud scanner with Telegram alerts
1. Create the file `.github/workflows/scan.yml` in your repo (**Add file > Create new file**, type the path with the folders, paste the contents of `scan.yml`). Also add `scan.mjs` and `worker.js` at the top level.
2. **Settings > Secrets and variables > Actions > Secrets**: `ANTHROPIC_API_KEY` (required), `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (optional), `METAAPI_TOKEN` and `METAAPI_ACCOUNT_ID` (only if you ever turn on execution).
3. **Variables** (all optional): `HL_COIN` (for example `BTC`), `SYMBOL`, `TF`, `RISK_MODE` (`pct` or `lot`), `RISK_VALUE`, `MAX_LOT`, `MIN_CONF`, `MAX_TRADES_PER_DAY`, `COOLDOWN_MIN`, `CONTRACT_OZ`, `PAUSED` (`1` pauses), `EXECUTE` (leave unset or `off` to only scan and alert).
4. **Actions > scan > Run workflow** once to test.

Notes: GitHub can delay scheduled runs by several minutes, so do not rely on it for fast automatic trading. Public repositories get free Actions minutes; private repositories may run out. Never commit keys to the repository.

## Markets
XAUUSD, BTCUSD, ETHUSD, silver, Brent oil, SOL, EURUSD and USDJPY. Other forex majors are not listed on Hyperliquid, so they need a different data source and are not included here.

Analytics only, not financial advice.
