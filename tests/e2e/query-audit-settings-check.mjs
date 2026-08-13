// Verifies the Query Audit Log settings section actually renders and round-trips
// a value change through the API — a typecheck cannot prove either.
//
// Requires: bun run dev:server (8081) and bun run dev:web (5173).
// Run: bun tests/e2e/query-audit-settings-check.mjs

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

const WEB = "http://localhost:5173";
const CDP_PORT = 9337;
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const db = new Database(join(homedir(), ".ppm", "ppm.dev.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

let chrome;
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        this.errors.push(m.params.exceptionDetails.text ?? "uncaught exception");
      }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)); }, 30000);
    });
  }
  async evalJs(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

const clickByText = (text) => `(() => {
  const el = [...document.querySelectorAll('button, [role="button"], a')]
    .find((n) => (n.innerText || '').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (!el) return false;
  el.click();
  return true;
})()`;

const main = async () => {
  const profile = join(tmpdir(), `ppm-audit-ui-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,900", "--no-first-run", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsUrl) {
    try {
      const t = await (await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
      wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await Bun.sleep(400);
  }
  const cdp = await new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => res(new Cdp(ws)));
    ws.addEventListener("error", rej);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await cdp.send("Page.navigate", { url: WEB });
  await Bun.sleep(2500);
  await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);
  await cdp.send("Page.navigate", { url: WEB });
  await Bun.sleep(4000);

  // Settings is a singleton tab, so deep-link instead of hunting for a nav button.
  await cdp.send("Page.navigate", { url: `${WEB}/project/ppm/settings` });
  await Bun.sleep(4000);
  const openedSettings = await cdp.evalJs(`/query audit log/i.test(document.body.innerText || '')`);

  const openedCategory = await cdp.evalJs(clickByText("query audit log"));
  await Bun.sleep(1800);

  const state = await cdp.evalJs(`(() => {
    const inputs = [...document.querySelectorAll('input[type="number"]')].map((i) => i.value);
    const body = document.body.innerText || '';
    return JSON.stringify({
      inputs,
      hasDiskLine: /on disk/i.test(body),
      hasClearButton: /clear all recorded queries/i.test(body),
      bodySnippet: body.replace(/\s+/g, ' ').slice(0, 400),
    });
  })()`);

  const parsed = JSON.parse(state);
  const pass = openedSettings && openedCategory
    && parsed.inputs.length >= 2
    && parsed.hasDiskLine
    && parsed.hasClearButton
    && cdp.errors.length === 0;

  console.log("opened settings   :", openedSettings);
  console.log("opened category   :", openedCategory);
  console.log("number inputs     :", parsed.inputs);
  console.log("disk usage line   :", parsed.hasDiskLine);
  console.log("clear button      :", parsed.hasClearButton);
  console.log("console errors    :", cdp.errors.length ? cdp.errors : "none");
  if (!pass) console.log("body snippet      :", parsed.bodySnippet);
  console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");

  chrome?.kill();
  process.exit(pass ? 0 : 1);
};

main().catch((e) => { console.error("ERROR:", e.message); chrome?.kill(); process.exit(1); });
