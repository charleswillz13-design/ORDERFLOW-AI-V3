// XAUUSD Cloud AI Orderflow Scanner (Cloudflare Worker). Runs on a cron, no PC or VPS.
// Data: Hyperliquid public API (xyz:GOLD perp, tracks XAUUSD). Brain: Claude. Alerts: Telegram. Execution: MetaApi (optional).
// Safety: EXECUTE must be "on" to place orders, otherwise it only scans and alerts (dry run).

const HL = "https://api.hyperliquid.xyz/info";
const TF_MS = { "5m": 3e5, "15m": 9e5, "1h": 36e5 };
const f2 = v => +(+v).toFixed(2);

async function hl(body) {
  const r = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Hyperliquid " + r.status);
  return r.json();
}

async function getData(env) {
  const coin = env.HL_COIN || "xyz:GOLD", tf = env.TF || "15m";
  const [raw, book] = await Promise.all([
    hl({ type: "candleSnapshot", req: { coin, interval: tf, startTime: Date.now() - 96 * TF_MS[tf] } }),
    hl({ type: "l2Book", coin }),
  ]);
  const c = raw.map(k => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c })); // USD volume
  const m = a => a.map(x => ({ p: +x.px, s: +x.sz, n: x.n }));
  if (c.length < 20) throw new Error("Not enough candles");
  return { c, bids: m(book.levels[0]), asks: m(book.levels[1]), tf };
}

// ---- Orderflow engine: VWAP, volume profile, estimated footprint, heat map walls ----
function engine({ c, bids, asks }) {
  const tp = c.map(x => (x.h + x.l + x.c) / 3), vv = c.reduce((s, x) => s + x.v, 0);
  const vwap = c.reduce((s, x, i) => s + tp[i] * x.v, 0) / vv;
  const sd = Math.sqrt(c.reduce((s, x, i) => s + x.v * (tp[i] - vwap) ** 2, 0) / vv);
  const lo = Math.min(...c.map(x => x.l)), hi = Math.max(...c.map(x => x.h)), N = 40, st = (hi - lo) / N || 1, bins = Array(N).fill(0);
  c.forEach(x => {
    const a = Math.max(0, Math.floor((x.l - lo) / st)), b = Math.min(N - 1, Math.floor((x.h - lo) / st)), k = b - a + 1;
    for (let i = a; i <= b; i++) bins[i] += x.v / k;
  });
  let pi = 0; bins.forEach((v, i) => { if (v > bins[pi]) pi = i; });
  const tot = bins.reduce((a, b) => a + b, 0); let a = pi, b = pi, acc = bins[pi];
  while (acc < 0.7 * tot && (a > 0 || b < N - 1)) {
    const u = b < N - 1 ? bins[b + 1] : -1, d = a > 0 ? bins[a - 1] : -1;
    if (u >= d) { b++; acc += bins[b]; } else { a--; acc += bins[a]; }
  }
  const mv = vv / c.length, avgRange = c.reduce((s, x) => s + (x.h - x.l), 0) / c.length;
  const fp = c.slice(-12).map(x => {
    const r = x.h - x.l || 1e-9, d = x.v * ((x.c - x.l) - (x.h - x.c)) / r;
    return { t: new Date(x.t).toISOString().slice(11, 16), close: x.c, vol: Math.round(x.v), est_delta: Math.round(d),
      imbalance_pct: Math.round(d / x.v * 100), high_volume: x.v > 1.8 * mv, absorption_like: x.v > 1.5 * mv && r < 0.7 * avgRange };
  });
  const atr = c.slice(-14).reduce((s, x) => s + (x.h - x.l), 0) / 14;
  const sz = [...bids, ...asks].map(x => x.s).sort((p, q) => p - q), med = sz[Math.floor(sz.length / 2)] || 1;
  const B = bids.reduce((s, x) => s + x.s, 0), A = asks.reduce((s, x) => s + x.s, 0);
  return {
    last: c[c.length - 1], atr,
    vwap: f2(vwap), vwap_1sd: [f2(vwap - sd), f2(vwap + sd)], poc: f2(lo + (pi + 0.5) * st), value_area: [f2(lo + a * st), f2(lo + (b + 1) * st)],
    footprint_estimated: fp,
    liquidity: { bid_walls: bids.filter(x => x.s >= 2.5 * med).map(x => x.p), ask_walls: asks.filter(x => x.s >= 2.5 * med).map(x => x.p), book_imbalance: f2((B - A) / (B + A)) },
    recent_candles: c.slice(-20).map(x => [x.o, x.h, x.l, x.c, Math.round(x.v)]),
  };
}

// ---- Candlestick patterns (last 3 candles; age 0 = latest) ----
function pats(c) {
  const out = [], n = c.length, avg = c.slice(-14).reduce((s, x) => s + (x.h - x.l), 0) / 14;
  const B = x => Math.abs(x.c - x.o), R = x => x.h - x.l || 1e-9, U = x => x.h - Math.max(x.o, x.c), L = x => Math.min(x.o, x.c) - x.l, up = x => x.c > x.o, dn = x => x.c < x.o;
  for (let i = n - 3; i < n; i++) {
    const a = c[i], p = c[i - 1], q = c[i - 2], age = n - 1 - i, add = (name, bias) => out.push({ pattern: name, bias, age });
    if (B(a) < 0.1 * R(a)) add("Doji", "neutral");
    if (L(a) > 2 * B(a) && U(a) < 0.3 * R(a) && B(a) > 0) add("Hammer / bullish pin bar", "bull");
    if (U(a) > 2 * B(a) && L(a) < 0.3 * R(a) && B(a) > 0) add("Shooting star / bearish pin bar", "bear");
    if (B(a) > 0.9 * R(a) && R(a) > 1.2 * avg) add(up(a) ? "Bullish marubozu" : "Bearish marubozu", up(a) ? "bull" : "bear");
    if (dn(p) && up(a) && a.c >= p.o && a.o <= p.c && B(a) > B(p)) add("Bullish engulfing", "bull");
    if (up(p) && dn(a) && a.o >= p.c && a.c <= p.o && B(a) > B(p)) add("Bearish engulfing", "bear");
    if (a.h < p.h && a.l > p.l) add("Inside bar", "neutral");
    if (dn(q) && B(q) > 0.6 * avg && B(p) < 0.3 * avg && up(a) && a.c > (q.o + q.c) / 2) add("Morning star", "bull");
    if (up(q) && B(q) > 0.6 * avg && B(p) < 0.3 * avg && dn(a) && a.c < (q.o + q.c) / 2) add("Evening star", "bear");
    if (up(a) && up(p) && up(q) && a.c > p.c && p.c > q.c) add("Three white soldiers", "bull");
    if (dn(a) && dn(p) && dn(q) && a.c < p.c && p.c < q.c) add("Three black crows", "bear");
  }
  return out;
}

// ---- Claude ----
const SYS = `You are an institutional order-flow analyst for XAUUSD. You receive computed VWAP, volume profile (POC, value area), liquidity walls from an order-book snapshot, and an ESTIMATED footprint (delta inferred from candle shape, not true tick data).
Rules: signal BUY or SELL only if at least 3 of these agree: price vs VWAP, price vs POC/value area, candlestick patterns (patterns list, age 0 = latest candle), footprint delta/absorption/exhaustion, liquidity walls and book imbalance. Otherwise WAIT. Prefer pullbacks to VWAP/POC and breakouts with a first pullback. Stop beyond structure or the nearest wall. Minimum reward:risk 1.5.
Return ONLY JSON: {"signal":"BUY"|"SELL"|"WAIT","confidence":0-100,"stop_distance":number,"tp1_distance":number,"tp2_distance":number,"reasons":[string],"invalidation":string}. Distances are positive price units from entry.`;

async function askClaude(env, payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MODEL || "claude-sonnet-5-5", max_tokens: 1000, system: SYS, messages: [{ role: "user", content: JSON.stringify(payload) }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude " + r.status + " " + JSON.stringify(j).slice(0, 200));
  const t = j.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(t.replace(/```json|```/g, "").trim());
}

function validate(s, atr) {
  const bad = !["BUY", "SELL"].includes(s.signal) || !(s.stop_distance > 0) || s.stop_distance < 0.5 * atr || s.stop_distance > 3 * atr || s.tp1_distance < 1.5 * s.stop_distance;
  return bad ? { ...s, signal: "WAIT", reasons: [...(s.reasons || []), "Rejected by risk guard (stop size or reward:risk out of range)"] } : s;
}

// ---- MetaApi (cloud MT5 bridge) ----
const MA = (env, p, o = {}) => fetch(env.METAAPI_URL + "/users/current/accounts/" + env.METAAPI_ACCOUNT_ID + p,
  { ...o, headers: { "auth-token": env.METAAPI_TOKEN, "content-type": "application/json" } }).then(r => r.json());

async function trade(env, sig) {
  if (env.EXECUTE !== "on") return { status: "dry_run", note: "Set EXECUTE=on to place orders" };
  const sym = env.SYMBOL || "XAUUSD", day = new Date().toISOString().slice(0, 10);
  const n = +(await env.STATE.get("day:" + day) || 0);
  if (n >= (+env.MAX_TRADES_PER_DAY || 3)) return { status: "skipped", note: "Daily trade cap reached" };
  const last = +(await env.STATE.get("lastTrade") || 0);
  if (Date.now() - last < (+env.COOLDOWN_MIN || 30) * 6e4) return { status: "skipped", note: "Cooldown active" };
  const pos = await MA(env, "/positions");
  if (Array.isArray(pos) && pos.some(p => p.symbol === sym)) return { status: "skipped", note: "Position already open" };
  const info = await MA(env, "/account-information"), px = await MA(env, "/symbols/" + sym + "/current-price");
  const buy = sig.signal === "BUY", s = buy ? 1 : -1, entry = buy ? px.ask : px.bid;
  const maxLot = +env.MAX_LOT || 1;
  let lot = env.RISK_MODE === "lot" ? +env.RISK_VALUE : Math.floor((info.balance * (+env.RISK_VALUE || 1) / 100) / (sig.stop_distance * (+env.CONTRACT_OZ || 100)) * 100) / 100;
  lot = Math.min(maxLot, Math.max(0.01, lot));
  const risk = lot * sig.stop_distance * (+env.CONTRACT_OZ || 100);
  const body = { actionType: buy ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL", symbol: sym, volume: lot,
    stopLoss: f2(entry - s * sig.stop_distance), takeProfit: f2(entry + s * sig.tp1_distance), comment: "claude-scanner" };
  const res = await MA(env, "/trade", { method: "POST", body: JSON.stringify(body) });
  await env.STATE.put("day:" + day, String(n + 1), { expirationTtl: 172800 });
  await env.STATE.put("lastTrade", String(Date.now()));
  return { status: "sent", order: body, risk_usd: f2(risk), risk_pct: f2(risk / info.balance * 100), broker_response: res };
}

const tg = (env, text) => env.TELEGRAM_BOT_TOKEN && fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) });

// ---- News filter and alerts (economic calendar feed) ----
// Feed: Forex Factory weekly JSON via faireconomy.media (unofficial, free). Set NEWS_URL to use another feed with the same fields.
async function news(env) {
  if (env.NEWS_FILTER === "off") return null;
  let ev;
  try { const r = await fetch(env.NEWS_URL || "https://nfs.faireconomy.media/ff_calendar_thisweek.json"); if (!r.ok) return null; ev = await r.json(); } catch { return null; }
  const ccy = (env.NEWS_CCY || "USD").split(","), win = +env.NEWS_WINDOW_MIN || 30, now = Date.now();
  let block = null;
  for (const e of ev) {
    if (e.impact !== "High" || !ccy.includes(e.country)) continue;
    const m = (new Date(e.date) - now) / 6e4;
    if (m > win || m < -15) continue;
    block = e.title + (m > 0 ? " in " + Math.round(m) + " min" : " just released");
    const key = "al:" + e.date + e.title;
    if (m > 0 && !(await env.STATE.get(key))) {
      await env.STATE.put(key, "1", { expirationTtl: 172800 });
      await tg(env, "High-impact " + e.country + " news in " + Math.round(m) + " min: " + e.title + (e.forecast ? " (forecast " + e.forecast + ", previous " + e.previous + ")" : ""));
    }
  }
  return block;
}

async function run(env) {
  const nb = await news(env);
  if ((await env.STATE.get("paused")) === "1") return { status: "paused" };
  const d = await getData(env), e = engine(d);
  const { last, atr, ...ctx } = e;
  const ai = nb ? { signal: "WAIT", confidence: 0, reasons: ["News filter: " + nb], news_block: nb }
    : validate(await askClaude(env, { price: last.c, atr: f2(atr), timeframe: d.tf, patterns: pats(d.c), ...ctx }), atr);
  const out = { time: new Date().toISOString(), symbol: "XAUUSD", source: "Hyperliquid xyz:GOLD", timeframe: d.tf, price: last.c,
    ...ai, levels: { vwap: e.vwap, poc: e.poc, value_area: e.value_area }, liquidity: e.liquidity, patterns: pats(d.c), disclaimer: "Analytics only, not financial advice." };
  if (out.signal !== "WAIT" && out.confidence >= (+env.MIN_CONF || 70)) {
    out.execution = await trade(env, out).catch(x => ({ status: "error", note: String(x.message || x) }));
    await tg(env, JSON.stringify(out, null, 2));
  }
  await env.STATE.put("latest", JSON.stringify(out));
  return out;
}

export default {
  async scheduled(_ev, env, ctx) { ctx.waitUntil(run(env).catch(x => env.STATE.put("latest", JSON.stringify({ error: String(x.message || x), time: new Date().toISOString() })))); },
  async fetch(req, env) {
    const u = new URL(req.url), key = u.searchParams.get("key") || (req.headers.get("authorization") || "").replace("Bearer ", "");
    if (!env.ADMIN_TOKEN || key !== env.ADMIN_TOKEN) return new Response("Unauthorized", { status: 401 });
    const json = o => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/pause") { await env.STATE.put("paused", "1"); return json({ paused: true }); }
    if (u.pathname === "/resume") { await env.STATE.put("paused", "0"); return json({ paused: false }); }
    if (u.pathname === "/scan") return json(await run(env).catch(x => ({ error: String(x.message || x) })));
    return json(JSON.parse((await env.STATE.get("latest")) || "{}"));
  },
};

export { run };
