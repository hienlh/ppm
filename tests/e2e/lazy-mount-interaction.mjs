// Interaction check for lazy tab mounting: clicking a tab in the strip must
// mount it, and it must STAY mounted after switching away (keep-alive).
// Run: bun spike-lazy-mount-interaction.mjs [port]   (default 5173 = dev)

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

const PORT = process.argv.find((a) => /^\d+$/.test(a)) || "5173";
const ORIGIN = `http://localhost:${PORT}`;
const DEV = PORT === "5173";
const CDP_PORT = 9334;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const db = new Database(join(homedir(), ".ppm", DEV ? "ppm.dev.db" : "ppm.db"), { readonly: true });
const TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
db.close();

const log = (...a) => console.log(...a);
let chrome;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 30000);
    });
  }
  async evalJs(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + expression.slice(0, 120));
    return r.result.value;
  }
}

const main = async () => {
  const profile = join(tmpdir(), `ppm-lazymount-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });

  let wsUrl;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const t = await (await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
      const page = t.find((x) => x.type === "page");
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await Bun.sleep(400);
  }
  if (!wsUrl) throw new Error("Chrome CDP never ready");

  const cdp = await new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => res(new Cdp(ws)));
    ws.addEventListener("error", rej);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await cdp.send("Page.navigate", { url: ORIGIN });
  await Bun.sleep(2500);
  await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);
  await cdp.send("Page.reload");
  await Bun.sleep(9000);

  const mountedIds = () => cdp.evalJs(
    `JSON.stringify([...document.querySelectorAll('[data-tab-pool-id]')].map(e => e.dataset.tabPoolId))`
  ).then(JSON.parse);

  const boot = await mountedIds();
  log(`\n1. after boot: ${boot.length} mounted`);
  boot.forEach((i) => log(`     ${i}`));

  // Find chat tabs in the strip that are NOT mounted, via the panel store.
  const stripInfo = await cdp.evalJs(`(() => {
    const els = [...document.querySelectorAll('[data-tab-id]')];
    const mounted = new Set([...document.querySelectorAll('[data-tab-pool-id]')].map(e => e.dataset.tabPoolId));
    return JSON.stringify(els.map(e => ({ id: e.dataset.tabId, mounted: mounted.has(e.dataset.tabId) })));
  })()`).then(JSON.parse);
  log(`\n2. tabs in strip: ${stripInfo.length} (mounted: ${stripInfo.filter(t => t.mounted).length})`);

  const target = stripInfo.find((t) => !t.mounted && t.id.startsWith("chat:"));
  if (!target) {
    log("   !! no unmounted chat tab in the strip — cannot test click-to-mount");
    log(`   strip sample: ${stripInfo.slice(0, 6).map(t => t.id + (t.mounted ? "*" : "")).join(", ")}`);
    return;
  }

  log(`\n3. clicking unmounted tab: ${target.id}`);
  await cdp.evalJs(
    `document.querySelector('[data-tab-id="${target.id}"]').click(), null`
  );
  await Bun.sleep(4000);
  const afterClick = await mountedIds();
  const nowMounted = afterClick.includes(target.id);
  log(`   mounted after click: ${nowMounted ? "YES" : "NO !!"}  (total mounted: ${afterClick.length})`);

  // Switch back to the original tab; the clicked one must STAY mounted (keep-alive).
  const first = boot.find((i) => i.startsWith("chat:")) || boot[0];
  log(`\n4. switching back to ${first} — clicked tab must stay mounted`);
  await cdp.evalJs(`document.querySelector('[data-tab-id="${first}"]')?.click(), null`);
  await Bun.sleep(2500);
  const afterBack = await mountedIds();
  const stillMounted = afterBack.includes(target.id);
  log(`   ${target.id} still mounted: ${stillMounted ? "YES (keep-alive OK)" : "NO !! keep-alive broken"}`);
  log(`   total mounted now: ${afterBack.length}`);

  log(`\nRESULT: click-to-mount=${nowMounted ? "PASS" : "FAIL"} keep-alive=${stillMounted ? "PASS" : "FAIL"}`);
};

try { await main(); } finally { chrome?.kill(); }
process.exit(0);
