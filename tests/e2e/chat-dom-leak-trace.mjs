// Trace where a streaming chat turn leaves DOM nodes behind.
//
// Background: a production PPM window reached 3.9 GB with ~2M DOM nodes reported by the
// Performance monitor while only ~65k elements were attached to the page, and a forced GC
// reclaimed none of them. This harness reproduces one streaming turn under instrumentation
// and reports, per React owner component, how many nodes were created through
// `innerHTML` (the dominant creation path measured in production), how many of the removed
// nodes survive a forced GC, and how the renderer-wide node counter moves against the
// attached-element count.
//
// It attaches to an already-running backend (default: production on 3214) but never touches
// the developer's workspace: it adds a scratch project of its own, opens one chat tab there,
// and deletes the project again. The web side is a vite dev build so component names are
// readable; the backend, streaming protocol and message rendering are the production ones.
//
// Run:
//   PPM_DEV_API=http://localhost:3214 PPM_DB=~/.ppm/ppm.db bun tests/e2e/chat-dom-leak-trace.mjs
//
// Env:
//   PPM_DEV_API           backend origin (default http://localhost:3214)
//   PPM_DB                database that backend uses — the auth token must match it
//   PPM_E2E_WEB           "prod" = use the backend's own bundle instead of a vite dev build
//   PPM_E2E_WEB_PORT      vite port (default 5177)
//   PPM_E2E_CDP_PORT      Chrome remote-debugging port (default 9243)
//   PPM_E2E_PROMPT        override the prompt sent to the model
//   PPM_E2E_TURN_TIMEOUT  seconds to wait for the turn (default 240)
//   PPM_E2E_HIDE          "1" = once streaming starts, open a second tab so the streaming
//                         one is hidden by TabPool (display:none) for the rest of the turn
//   PPM_E2E_KEEP          keep Chrome, vite and the scratch project for manual inspection
//   CHROME_PATH           Chrome executable
//   PPM_E2E_CHROME_ARGS   extra Chrome flags, space-separated (e.g. --force-renderer-accessibility)
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

const REPO = process.cwd();
const API = process.env.PPM_DEV_API || "http://localhost:3214";
const WEB_PORT = Number(process.env.PPM_E2E_WEB_PORT || 5177);
// PPM_E2E_WEB=prod loads the bundle the backend itself serves (minified names, exactly what
// users run) instead of a vite dev build; the chat tab is then opened through the URL route.
const PROD_WEB = process.env.PPM_E2E_WEB === "prod";
const WEB = PROD_WEB ? API : `http://localhost:${WEB_PORT}`;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9243);
const DB = (process.env.PPM_DB || join(homedir(), ".ppm", "ppm.db")).replace(/^~(?=[/\\])/, homedir());
const CHROME = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
const KEEP = !!process.env.PPM_E2E_KEEP;
const HIDE = process.env.PPM_E2E_HIDE === "1";
const TURN_TIMEOUT_MS = Number(process.env.PPM_E2E_TURN_TIMEOUT || 240) * 1000;
const TOKEN_KEY = "ppm-auth-token";
// Unique per run: the server keeps a workspace per project *name*, so reusing one would
// restore the tabs of every earlier run into this one.
const PROJECT = `leak-trace-${Date.now().toString(36)}`;
const SHOTS = join(REPO, "plans", "reports", "screenshots");

// A turn that exercises the two innerHTML paths in the transcript: many small Edit tool
// calls (highlight.js diff preview) and a few fenced code blocks (Shiki).
const PROMPT = process.env.PPM_E2E_PROMPT ||
  "In app.ts, make 8 separate small edits using the Edit tool, one Edit call each " +
  "(rename a variable, add a comment, change a constant, add a parameter, and so on). " +
  "Do not batch them into one edit and do not use MultiEdit. When done, reply with three " +
  "short TypeScript code blocks summarising what changed. Do not ask questions.";

// Never log TOKEN's value.
const TOKEN = (() => {
  try {
    const db = new Database(DB, { readonly: true });
    try {
      const row = db.query("SELECT value FROM config WHERE key='auth'").get();
      return row ? (JSON.parse(row.value)?.token ?? null) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
})();

const log = (...a) => console.log(...a);
const step = (t) => log("\n=== " + t + " ===");
const started = { web: null, chrome: null, chromeProfile: null, scratchDir: null, projectAdded: false };

// ---------------------------------------------------------------------------
// Backend helpers
// ---------------------------------------------------------------------------
async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(20_000),
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok && r.status !== 409) throw new Error(`${init.method || "GET"} ${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

async function isUp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

async function waitUp(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await Bun.sleep(1000);
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms (${url})`);
}

async function makeScratchProject() {
  const dir = join(tmpdir(), `ppm-leak-scratch-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  started.scratchDir = dir;
  const lines = [
    "// Scratch file for the DOM leak trace. Safe to edit freely.",
    "export const RETRY_LIMIT = 3;",
    "export const TIMEOUT_MS = 5000;",
    "",
    "export interface Job {",
    "  id: string;",
    "  attempts: number;",
    "  payload: Record<string, unknown>;",
    "}",
    "",
    "export function shouldRetry(job: Job): boolean {",
    "  return job.attempts < RETRY_LIMIT;",
    "}",
    "",
    "export function nextDelay(attempt: number): number {",
    "  return Math.min(TIMEOUT_MS, 250 * 2 ** attempt);",
    "}",
    "",
    "export function describe(job: Job): string {",
    "  return `${job.id} (${job.attempts} attempts)`;",
    "}",
    "",
  ];
  await writeFile(join(dir, "app.ts"), lines.join("\n"));
  await writeFile(join(dir, "README.md"), "# leak trace scratch\n\nTemporary project created by tests/e2e/chat-dom-leak-trace.mjs.\n");
  const res = await api("/api/projects", { method: "POST", body: JSON.stringify({ path: dir, name: PROJECT }) });
  started.projectAdded = true;
  log(`  scratch project '${PROJECT}' -> ${dir} (${res?.ok === false ? res.error : "added"})`);
}

// ---------------------------------------------------------------------------
// vite (dev web against the target backend) — never dev:server
// ---------------------------------------------------------------------------
function spawnBg(cmd, args, name, env) {
  const child = spawn(cmd, args, {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  child.stdout.on("data", (d) => { const s = String(d); if (/error|Error/.test(s)) process.stdout.write(`[${name}] ${s}`); });
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

async function ensureWeb() {
  if (!(await isUp(`${API}/api/health`))) throw new Error(`No backend at ${API}.`);
  if (PROD_WEB) { log(`  using the backend's own bundle at ${WEB}`); return; }
  if (await isUp(WEB)) { log(`  web already up: ${WEB}`); return; }
  log(`  starting vite on ${WEB_PORT} (api ${API})`);
  started.web = spawnBg("bun", ["run", "vite", "--config", "vite.config.ts", "--port", String(WEB_PORT), "--strictPort"], "vite", { PPM_DEV_API: API });
  await waitUp(WEB, "vite");
}

// ---------------------------------------------------------------------------
// Raw CDP driver
// ---------------------------------------------------------------------------
async function launchChrome() {
  if (await isUp(`http://localhost:${CDP_PORT}/json/version`)) {
    throw new Error(`Port ${CDP_PORT} already has a DevTools endpoint (leftover Chrome?). Stop it by PID or set PPM_E2E_CDP_PORT.`);
  }
  const profile = join(tmpdir(), `ppm-e2e-leak-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  started.chromeProfile = profile;
  started.chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1400,1000", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    ...(process.env.PPM_E2E_CHROME_ARGS || "").split(/\s+/).filter(Boolean),
    "about:blank",
  ], { stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) });
      const page = (await r.json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await Bun.sleep(500);
  }
  throw new Error("Chrome DevTools endpoint never became ready");
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const redact = (t) => String(t).replace(/token=[^&\s'"]+/g, "token=***");
      if (msg.method === "Runtime.consoleAPICalled" && /error|warning/.test(msg.params.type)) {
        this.console.push(redact(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)));
      } else if (msg.method === "Log.entryAdded" && /error|warning/.test(msg.params.entry.level)) {
        this.console.push(redact(`[${msg.params.entry.source}] ${msg.params.entry.text.slice(0, 300)} ${msg.params.entry.url || ""}`));
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.console.push(redact("[exception] " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).slice(0, 300)));
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }
  /** Console errors/warnings and browser log entries seen so far (for failure diagnostics). */
  console = [];
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP ws error")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, timeoutMs = 60_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, timeoutMs);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async navigate(url) { await this.send("Page.navigate", { url }); await Bun.sleep(300); }
  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(r.data, "base64"));
    log(`  screenshot -> ${path}`);
  }
  /** Same counters the DevTools Performance monitor shows: renderer-wide, detached included. */
  async domCounters() { return this.send("Memory.getDOMCounters"); }
  async gc() { await this.send("HeapProfiler.collectGarbage"); }
  async pressEnter() {
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

async function waitFor(cdp, expr, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(`Boolean(${expr})`)) return true; } catch { /* mid-navigation */ }
    await Bun.sleep(300);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// In-page probes (installed before the turn starts)
// ---------------------------------------------------------------------------
const PROBES = `
(() => {
  const owner = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$"));
    const names = [];
    for (let f = el[k]; f && names.length < 4; f = f.return) {
      const t = f.type;
      if (!t || typeof t === "string") continue;
      const n = t.displayName || t.name || t.type?.displayName || t.type?.name || t.render?.displayName || t.render?.name;
      if (n) names.push(n);
    }
    return names.join(" < ") || "?";
  };
  const cls = (el) => (el.getAttribute?.("class") || "").split(/\\s+/).filter(Boolean).slice(0, 2).join(".");

  // 1) innerHTML sets: who, on attached or fresh elements, how many nodes replaced/created.
  const ih = new Map();
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...d,
    set(v) {
      const before = this.childElementCount;
      // A set whose markup equals what is already there rebuilds the subtree for nothing.
      const noop = before > 0 && d.get.call(this) === String(v);
      d.set.call(this, v);
      const key = (this.isConnected ? "UPDATE" : "MOUNT") + " | <" + this.tagName.toLowerCase() + (cls(this) ? "." + cls(this) : "") + "> | " + owner(this);
      const e = ih.get(key) ?? { key, calls: 0, identical: 0, replaced: 0, created: 0 };
      e.calls++; e.identical += noop ? 1 : 0; e.replaced += before; e.created += this.querySelectorAll("*").length; ih.set(key, e);
    },
  });

  // 2) Every element root removed from the document, with a weak handle to test survival after GC.
  const removed = [];
  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of r.removedNodes) {
      if (n.nodeType !== 1) continue;
      removed.push({ ref: new WeakRef(n), desc: "<" + n.tagName.toLowerCase() + (cls(n) ? "." + cls(n) : "") + "> | " + owner(n), nodes: 1 + n.querySelectorAll("*").length });
    }
  });
  mo.observe(document, { childList: true, subtree: true });

  window.__trace = {
    innerHtml: () => [...ih.values()].sort((a, b) => b.created - a.created),
    removed: () => {
      const groups = new Map();
      let total = 0;
      for (const x of removed) {
        total += x.nodes;
        const g = groups.get(x.desc) ?? { desc: x.desc, roots: 0, nodes: 0 };
        g.roots++; g.nodes += x.nodes; groups.set(x.desc, g);
      }
      return { total, groups: [...groups.values()].sort((a, b) => b.nodes - a.nodes) };
    },
    // Only meaningful right after a forced GC.
    survivors: () => {
      const groups = new Map();
      let total = 0;
      for (const x of removed) {
        const el = x.ref.deref();
        if (!el || el.isConnected) continue;
        total += x.nodes;
        const g = groups.get(x.desc) ?? { desc: x.desc, roots: 0, nodes: 0 };
        g.roots++; g.nodes += x.nodes; groups.set(x.desc, g);
      }
      return { total, groups: [...groups.values()].sort((a, b) => b.nodes - a.nodes) };
    },
    live: () => document.querySelectorAll("*").length,
    tabs: () => [...document.querySelectorAll("[data-tab-pool-id]")].map((el) => ({ tab: el.dataset.tabPoolId, elements: el.querySelectorAll("*").length })),
  };
  return "probes installed";
})()
`;

function table(rows, cols) {
  if (!rows.length) { log("  (empty)"); return; }
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (r) => cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  ");
  log("  " + line(Object.fromEntries(cols.map((c) => [c, c]))));
  for (const r of rows) log("  " + line(r));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!TOKEN) throw new Error(`No auth token in ${DB} (config key 'auth'). Set PPM_DB to the database the backend uses.`);
  await mkdir(SHOTS, { recursive: true });

  step("scratch project");
  await makeScratchProject();

  step("servers");
  await ensureWeb();

  step("chrome");
  const cdp = await Cdp.connect(await launchChrome());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  // The dev web opens its sockets straight at ws://<host>:8081 (src/web/lib/ws-client.ts) to
  // dodge vite's ws proxy, so under a vite build pointed at another backend every socket
  // would refuse. Rewrite that port to the target backend's before the app boots.
  const apiPort = new URL(API).port || (API.startsWith("https") ? "443" : "80");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const Orig = window.WebSocket;
    const from = "ws://" + location.hostname + ":8081";
    const to = "ws://" + location.hostname + ":${apiPort}";
    window.WebSocket = new Proxy(Orig, { construct(target, args) {
      if (typeof args[0] === "string" && args[0].startsWith(from)) args[0] = to + args[0].slice(from.length);
      return new target(...args);
    } });
  })()` });
  await cdp.navigate(WEB);
  await waitFor(cdp, `document.readyState === "complete"`, "web loaded");
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(TOKEN)})`);
  await cdp.navigate(`${WEB}/project/${encodeURIComponent(PROJECT)}`);
  await waitFor(cdp, `document.querySelector("#root")?.children.length`, "app mounted");
  await Bun.sleep(2500);

  step("open one chat tab in the scratch project");
  let tabId;
  if (PROD_WEB) {
    // No module imports in the built bundle — a non-UUID identifier in the chat route opens a
    // fresh draft tab (use-url-sync.ts, buildMetadataFromUrl).
    // No provider prefix in the identifier: "x/y" is read as provider "x", and a provider
    // named "default" does not exist.
    const ident = Math.random().toString(16).slice(2, 10);
    tabId = `chat:${ident}`;
    await cdp.navigate(`${WEB}/project/${encodeURIComponent(PROJECT)}/chat/${ident}`);
    await waitFor(cdp, `document.querySelector("#root")?.children.length`, "app mounted");
  } else {
    tabId = await cdp.evaluate(`(async () => {
      const tabs = (await import('/stores/tab-store.ts')).useTabStore.getState();
      return tabs.openTab({ type: "chat", title: "leak trace", projectId: ${JSON.stringify(PROJECT)},
        metadata: { projectName: ${JSON.stringify(PROJECT)}, permissionMode: "bypassPermissions" }, closable: true });
    })()`);
  }
  log(`  tab ${tabId}`);
  // The composer renders a desktop and a mobile textarea; only the visible one takes input.
  const VISIBLE_TA = `[...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null && /^(Ask|Follow-up)/.test(t.placeholder))`;
  await waitFor(cdp, VISIBLE_TA, "composer visible", 40_000);
  await Bun.sleep(1500);
  // The pool id the app actually assigned (the URL route derives its own), read off the
  // wrapper that holds the visible composer — that is the tab whose stream we follow.
  tabId = await cdp.evaluate(`(${VISIBLE_TA}).closest('[data-tab-pool-id]').dataset.tabPoolId`);
  log(`  streaming tab wrapper: ${tabId}`);

  step("baseline");
  log("  " + await cdp.evaluate(PROBES));
  const base = await cdp.domCounters();
  const baseLive = await cdp.evaluate(`window.__trace.live()`);
  log(`  DOM counters: nodes=${base.nodes} listeners=${base.jsEventListeners} documents=${base.documents} | attached elements=${baseLive}`);

  step("send the turn");
  // Headless pages do not reliably hold focus, so CDP Input events can land nowhere. Drive the
  // controlled textarea the way React expects instead: native value setter + input event,
  // then a bubbling keydown that React's root listener turns into the composer's onKeyDown.
  const typed = await cdp.evaluate(`(() => {
    const t = ${VISIBLE_TA};
    if (!t) return "no textarea";
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(PROMPT)});
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return t.value.length;
  })()`);
  log(`  typed ${typed} chars`);
  await Bun.sleep(400);
  await cdp.evaluate(`(() => {
    const t = ${VISIBLE_TA};
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  })()`);
  try {
    await waitFor(cdp, `(${VISIBLE_TA})?.placeholder.startsWith("Follow-up")`, "turn started (composer shows Follow-up)", 30_000);
  } catch (e) {
    // Show what the composer and the transcript look like before giving up.
    const state = await cdp.evaluate(`(() => {
      const t = ${VISIBLE_TA};
      const msgs = [...document.querySelectorAll('[data-msg-index]')].map((m) => (m.textContent || "").slice(0, 160));
      const errs = [...document.querySelectorAll('[class*="text-error"], [role="alert"]')].map((x) => (x.textContent || "").trim().slice(0, 200)).filter(Boolean);
      return { textareaValue: t?.value?.slice(0, 80), placeholder: t?.placeholder, msgs, errs };
    })()`);
    log("  composer state: " + JSON.stringify(state, null, 2));
    const sessions = await api(`/api/projects/${encodeURIComponent(PROJECT)}/chat/sessions`).catch((e) => ({ error: e.message }));
    log("  sessions on server: " + JSON.stringify(sessions).slice(0, 400));
    log("  page console (errors/warnings):\n    " + (cdp.console.slice(-15).join("\n    ") || "(none)"));
    await cdp.screenshot(join(SHOTS, `chat-dom-leak-trace-send-failed-${Date.now()}.png`));
    throw e;
  }
  log("  streaming…");
  if (HIDE) {
    if (PROD_WEB) throw new Error("PPM_E2E_HIDE needs the vite build (store import) — unset PPM_E2E_WEB=prod");
    await cdp.evaluate(`(async () => {
      const tabs = (await import('/stores/tab-store.ts')).useTabStore.getState();
      return tabs.openTab({ type: "chat", title: "cover", projectId: ${JSON.stringify(PROJECT)},
        metadata: { projectName: ${JSON.stringify(PROJECT)} }, closable: true });
    })()`);
    const hidden = await cdp.evaluate(`document.querySelector('[data-tab-pool-id=${JSON.stringify(tabId)}]')?.style.display === "none"`);
    log(`  opened a cover tab — streaming tab hidden: ${hidden}`);
    // Adjust the visible-textarea probe: the cover tab's composer says "Ask", the hidden one "Follow-up".
  }

  const samples = [];
  const t0 = Date.now();
  let streaming = true;
  while (streaming && Date.now() - t0 < TURN_TIMEOUT_MS) {
    await Bun.sleep(3000);
    const c = await cdp.domCounters();
    const live = await cdp.evaluate(`window.__trace.live()`);
    streaming = await cdp.evaluate(`[...document.querySelector('[data-tab-pool-id=${JSON.stringify(tabId)}]')?.querySelectorAll('textarea') ?? []].some((t) => t.placeholder.startsWith("Follow-up"))`);
    samples.push({ t: Math.round((Date.now() - t0) / 1000), nodes: c.nodes, live, listeners: c.jsEventListeners });
    log(`  +${String(samples.at(-1).t).padStart(3)}s  nodes=${c.nodes}  attached=${live}  listeners=${c.jsEventListeners}`);
  }
  log(streaming ? "  turn still running at timeout — measuring anyway" : "  turn finished");
  await Bun.sleep(2000);

  step("after turn, before GC");
  const pre = await cdp.domCounters();
  const preLive = await cdp.evaluate(`window.__trace.live()`);
  log(`  nodes=${pre.nodes} (+${pre.nodes - base.nodes})  attached=${preLive} (+${preLive - baseLive})  listeners=${pre.jsEventListeners}`);

  step("forced GC");
  await cdp.gc(); await Bun.sleep(500); await cdp.gc();
  const post = await cdp.domCounters();
  const postLive = await cdp.evaluate(`window.__trace.live()`);
  log(`  nodes=${post.nodes} (+${post.nodes - base.nodes} vs baseline)  attached=${postLive}  listeners=${post.jsEventListeners}`);
  log(`  => unattached nodes still alive after GC ≈ ${post.nodes - base.nodes - (postLive - baseLive)} (nodes gained minus attached gained; text nodes included)`);

  step("innerHTML sets during the turn (by owner)");
  table((await cdp.evaluate(`window.__trace.innerHtml()`)).slice(0, 15), ["calls", "identical", "created", "replaced", "key"]);

  step("element roots removed from the document during the turn");
  const rem = await cdp.evaluate(`window.__trace.removed()`);
  log(`  total nodes in removed roots: ${rem.total}`);
  table(rem.groups.slice(0, 12), ["roots", "nodes", "desc"]);

  step("removed roots still alive after GC (= retained)");
  const sur = await cdp.evaluate(`window.__trace.survivors()`);
  log(`  total nodes in surviving roots: ${sur.total}`);
  table(sur.groups.slice(0, 12), ["roots", "nodes", "desc"]);

  step("mounted tabs");
  table(await cdp.evaluate(`window.__trace.tabs()`), ["tab", "elements"]);

  await cdp.screenshot(join(SHOTS, `chat-dom-leak-trace-${Date.now()}.png`));

  return { base, pre, post, baseLive, preLive, postLive, samples, tabId };
}

/** PID listening on a local port, or null. Windows-only fallback for processes spawned through a shell. */
async function listenerPid(port) {
  if (process.platform !== "win32") return null;
  // No `-p tcp`: vite and Chrome bind [::1], which that filter hides.
  const out = await new Response(Bun.spawn(["netstat", "-ano"], { stdout: "pipe" }).stdout).text();
  const m = out.split("\n").find((l) => l.includes(`:${port} `) && l.includes("LISTENING"));
  return m ? Number(m.trim().split(/\s+/).at(-1)) : null;
}

async function cleanup() {
  if (KEEP) { log("\nPPM_E2E_KEEP set — leaving Chrome, vite and the scratch project in place."); return; }
  if (started.chrome) {
    // Chrome's browser process shrugs off a plain kill on Windows and keeps the debugging port,
    // which then hands the next run a dead page endpoint. Tree-kill the PID we spawned.
    try { started.chrome.kill(); } catch { /* gone */ }
    if (process.platform === "win32") {
      // The chrome.exe we spawned is only a launcher that re-execs the real browser, so its
      // PID is already dead by now; the browser is the process holding our debugging port.
      const pid = await listenerPid(CDP_PORT);
      if (pid) Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    }
  }
  if (started.web) {
    // The child we hold is a cmd.exe shell on Windows; vite's node process outlives a plain
    // kill of it, so target the process that actually owns our port. Never a port sweep or
    // an image-name kill — exactly one PID, and only because this harness started that port.
    try { started.web.kill(); } catch { /* gone */ }
    const pid = await listenerPid(WEB_PORT);
    if (pid) Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  }
  await Bun.sleep(800);
  // After Chrome is gone: with the page's chat socket still open the DELETE stalls.
  for (let attempt = 1; started.projectAdded && attempt <= 3; attempt++) {
    try { await api(`/api/projects/${encodeURIComponent(PROJECT)}`, { method: "DELETE" }); break; }
    catch (e) { log(`  project delete attempt ${attempt} failed: ${e.message}`); await Bun.sleep(5000); }
  }
  for (const dir of [started.chromeProfile, started.scratchDir]) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then(() => cleanup())
  .then(() => process.exit(0))
  .catch(async (e) => { console.error("\nFAILED:", e?.message || e); await cleanup(); process.exit(1); });
