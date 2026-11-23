// GitHub Actions entry point: runs one scan using the same logic as the Cloudflare Worker.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { run } from "./worker.js";

mkdirSync("data", { recursive: true });
const stateFile = "data/state.json";
const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8") || "{}") : {};
for (const k of Object.keys(st)) if (k.startsWith("day:") && k < "day:" + new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)) delete st[k];

const DEF = { TF: "15m", HL_COIN: "xyz:GOLD", SYMBOL: "XAUUSD", MIN_CONF: "70", RISK_MODE: "pct", RISK_VALUE: "1", MAX_LOT: "1",
  MAX_TRADES_PER_DAY: "3", COOLDOWN_MIN: "30", CONTRACT_OZ: "100", EXECUTE: "off", MODEL: "claude-sonnet-5-5",
  METAAPI_URL: "https://mt-client-api-v1.new-york.agiliumtrade.ai" };
const given = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));   // empty repo variables fall back to defaults
const env = { ...DEF, ...given, STATE: {
  async get(k) { return k === "paused" ? (given.PAUSED === "1" ? "1" : null) : (st[k] ?? null); },
  async put(k, v) { if (k === "latest") writeFileSync("data/latest.json", v); else st[k] = v; },
} };

let code = 0;
try { await run(env); }
catch (e) { code = 1; writeFileSync("data/latest.json", JSON.stringify({ error: String(e.message || e), time: new Date().toISOString() }, null, 2)); console.error(e); }
if (!existsSync("data/latest.json")) writeFileSync("data/latest.json", JSON.stringify({ status: "paused", time: new Date().toISOString() }));
writeFileSync(stateFile, JSON.stringify(st, null, 2));
process.exit(code);
