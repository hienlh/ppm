// Measures what happens when a user opens a NOT-yet-mounted chat tab:
// every request it fires, and when the chat input + slash suggestions become usable.
//
// Run: bun tests/e2e/tab-open-latency.mjs [origin] [token]
//   bun tests/e2e/tab-open-latency.mjs                      # dev on localhost:5173
//   bun tests/e2e/tab-open-latency.mjs https://<tunnel-host>
// The token defaults to the auth token in the matching database.
//
// NOTE: do not benchmark through a cloudflared quick tunnel — one degraded
// mid-session to 250-750 ms per request (localhost server time is <1 ms), which
// inflated a single /messages to 24 s and looked like a code regression.

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

const ORIGIN = process.argv[2] || "http://localhost:5173";

/** Auth token from the database this origin is backed by (dev vs prod). */
function dbToken(origin) {
  const dev = origin.includes("localhost:5173") || origin.includes("localhost:8081");
  const db = new Database(join(homedir(), ".ppm", dev ? "ppm.dev.db" : "ppm.db"), { readonly: true });
  try {
    return JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value).token;
  } finally {
    db.close();
  }
}

const TOKEN = process.argv[3] || dbToken(ORIGIN);
const CDP_PORT = 9336;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let chrome;
const log = (...a) => console.log(...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method) {
        for (const cb of this.listeners.get(m.method) || []) cb(m.params);
      }
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)); }, 45000);
    });
  }
  async evalJs(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

const main = async () => {
  const profile = join(tmpdir(), `ppm-tabopen-${Date.now()}`);
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
  await cdp.send("Network.enable");

  log(`\n=== tab-open latency vs ${ORIGIN} ===`);
  await cdp.send("Page.navigate", { url: ORIGIN });
  await Bun.sleep(3000);
  await cdp.evalJs(`localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)})`);
  await cdp.send("Page.reload");

  // Let boot + idle prefetch fully settle so we measure ONLY the tab-open cost.
  log("waiting 22s for boot + prefetch to settle...");
  await Bun.sleep(22000);

  const strip = await cdp.evalJs(`(() => {
    const mounted = new Set([...document.querySelectorAll('[data-tab-pool-id]')].map(e => e.dataset.tabPoolId));
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId);
    return JSON.stringify({ mounted: [...mounted], unmountedChat: tabs.filter(t => t.startsWith('chat:') && !mounted.has(t)) });
  })()`).then(JSON.parse);

  log(`mounted after settle: ${strip.mounted.length}`);
  const target = strip.unmountedChat[0];
  if (!target) { log("!! no unmounted chat tab left to test"); return; }
  log(`target (unmounted): ${target}\n`);

  // ---- record only what the tab-open causes ----
  const reqs = new Map();
  let t0 = 0;
  const rel = (ts) => Math.round((ts - t0) * 1000);
  cdp.on("Network.requestWillBeSent", (p) => {
    if (!t0) t0 = p.timestamp;
    reqs.set(p.requestId, { url: p.request.url, method: p.request.method, start: rel(p.timestamp) });
  });
  cdp.on("Network.loadingFinished", (p) => {
    const r = reqs.get(p.requestId);
    if (r) { r.end = rel(p.timestamp); r.bytes = p.encodedDataLength; }
  });
  cdp.on("Network.responseReceived", (p) => {
    const r = reqs.get(p.requestId);
    if (r) { r.status = p.response.status; }
  });

  const clickAt = Date.now();
  await cdp.evalJs(`document.querySelector('[data-tab-id="${target}"]').click(), null`);

  // Poll for the two milestones the user complained about.
  let inputAt = null, slashReadyAt = null;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(250);
    const st = await cdp.evalJs(`(() => {
      const w = document.querySelector('[data-tab-pool-id="${target}"]');
      if (!w) return JSON.stringify({ mounted: false });
      const tas = [...w.querySelectorAll('textarea')];
      const usable = tas.find((t) => t.clientHeight > 0);
      return JSON.stringify({
        mounted: true,
        textareas: tas.length,
        inputVisible: !!usable,
        msgs: w.querySelectorAll('[data-msg-index]').length,
      });
    })()`).then(JSON.parse);
    if (st.inputVisible && inputAt === null) inputAt = Date.now() - clickAt;
    if (i === 59 && !st.inputVisible) log(`  debug (input never found): ${JSON.stringify(st)}`);
    if (inputAt !== null) break;
  }

  // Now type "/" and time until the slash picker actually lists items.
  const typeAt = Date.now();
  await cdp.evalJs(`(() => {
    const w = document.querySelector('[data-tab-pool-id="${target}"]');
    const ta = w && w.querySelector('textarea');
    if (!ta) return null;
    ta.focus();
    return null;
  })()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "/", key: "/", code: "Slash" });
  await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "/" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "/", code: "Slash" });

  for (let i = 0; i < 60; i++) {
    await Bun.sleep(250);
    // slash-command-picker.tsx renders `div.max-h-52.overflow-y-auto` and
    // returns null until filtered.length > 0 — i.e. until slash-items loaded.
    const n = await cdp.evalJs(`(() => {
      const w = document.querySelector('[data-tab-pool-id="${target}"]');
      if (!w) return 0;
      const panel = w.querySelector('div.max-h-52.overflow-y-auto');
      return panel ? panel.querySelectorAll('div[class*="cursor"], div > div > div').length : 0;
    })()`);
    if (n > 0) { slashReadyAt = Date.now() - typeAt; break; }
  }

  await Bun.sleep(2000);

  // ---- report ----
  const all = [...reqs.values()].filter((r) => r.url.includes("/api/")).sort((a, b) => a.start - b.start);
  const short = (u) => u.split("/api/")[1]?.split("?")[0] ?? u;
  log(`---- requests caused by opening ONE tab: ${all.length} ----`);
  log(`  start   dur    size  endpoint`);
  for (const r of all) {
    const dur = (r.end ?? r.start) - r.start;
    log(`  ${String(r.start).padStart(5)}ms ${String(dur).padStart(5)}ms ${String(r.bytes ?? 0).padStart(7)}B  ${short(r.url)}`);
  }
  const bytes = all.reduce((s, r) => s + (r.bytes || 0), 0);
  log(`\n  total payload: ${(bytes / 1024).toFixed(0)} KB`);

  log(`\n---- user-visible milestones ----`);
  log(`  chat input usable after click : ${inputAt ?? ">15000"} ms`);
  log(`  slash suggestions after "/"   : ${slashReadyAt ?? ">15000"} ms`);

  await writeFile(join(tmpdir(), "ppm-tab-open.json"), JSON.stringify({ all, inputAt, slashReadyAt }, null, 2));
  log(`\nraw: ${join(tmpdir(), "ppm-tab-open.json")}`);
};

try { await main(); } finally { chrome?.kill(); }
process.exit(0);
