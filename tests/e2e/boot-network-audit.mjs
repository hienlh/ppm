// Boot network audit — captures every HTTP request the web app fires on a cold
// page load / reload, with timings, failures, and how many tabs TabPool mounted.
//
// Run:
//   bun tests/e2e/boot-network-audit.mjs            # prod, port from ~/.ppm/status.json
//   bun tests/e2e/boot-network-audit.mjs 5173       # dev (vite, proxies /api to 8081)
//   bun tests/e2e/boot-network-audit.mjs --mobile   # 412x915 emulated viewport
//
// Reads the auth token from the matching database (ppm.db, or ppm.dev.db for dev).
// Clears cache and reloads with ignoreCache, so these are cold-load numbers.
//
// Reference points, measured against the saved `ppm` workspace (20 tabs: 18 chat +
// 2 group) so later runs stay comparable:
//   before lazy-mount (prod build): 423 API / 36.7 MB / 169 failures / slowest 16256ms
//   after (dev build, StrictMode):  desktop 174 API / 32.9 MB / 0 fail / slowest 553ms
//                                   mobile   87 API /  5.1 MB / 0 fail / slowest 595ms
// Dev numbers are not directly comparable to prod: vite serves unbundled ESM (asset
// count inflates) and StrictMode double-invokes effects (API count roughly doubles).
// The signals that compare cleanly across builds: failures, /versions count,
// slowest-API, and poolMounted.

import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

/** Prod port comes from the supervisor status file so it survives a port change. */
async function defaultPort() {
  try {
    const status = JSON.parse(await readFile(join(homedir(), ".ppm", "status.json"), "utf8"));
    if (status.port) return String(status.port);
  } catch { /* fall back below */ }
  return "3210";
}

const PORT = process.argv.find((a) => /^\d+$/.test(a)) || (await defaultPort());
const MOBILE = process.argv.includes("--mobile");
const ORIGIN = `http://localhost:${PORT}`;
const CDP_PORT = 9333;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TOKEN_KEY = "ppm-auth-token";

// Dev (vite on 5173, API proxied to 8081) uses a separate database + token.
const DEV = process.argv.includes("--dev") || PORT === "5173";
const db = new Database(join(homedir(), ".ppm", DEV ? "ppm.dev.db" : "ppm.db"), { readonly: true });
const AUTH_TOKEN = JSON.parse(db.query("SELECT value FROM config WHERE key='auth'").get().value)
  .token;
db.close();

const log = (...a) => console.log(...a);
let chrome, profile;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }
}

async function launchChrome() {
  profile = join(tmpdir(), `ppm-netaudit-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const size = MOBILE ? "412,915" : "1440,900";
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${size}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (
        await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) })
      ).json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(400);
  }
  throw new Error("Chrome CDP never ready");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(new Cdp(ws)));
    ws.addEventListener("error", reject);
  });
}

const main = async () => {
  log(`\n=== Boot network audit — ${ORIGIN} ${MOBILE ? "(mobile 412x915)" : "(desktop)"} ===`);
  const cdp = await connect(await launchChrome());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  if (MOBILE) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 2,
      mobile: true,
    });
  }

  // Seed auth token on the origin, then do the measured reload.
  await cdp.send("Page.navigate", { url: ORIGIN });
  await Bun.sleep(3000);
  await cdp.send("Runtime.evaluate", {
    expression: `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)})`,
  });

  // ---- measured cold reload ----
  const reqs = new Map();
  const events = [];
  let t0 = 0;
  const rel = (ts) => (t0 ? Math.round((ts - t0) * 1000) : 0);

  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");

  cdp.on("Network.requestWillBeSent", (p) => {
    if (!t0) t0 = p.timestamp;
    reqs.set(p.requestId, {
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      start: rel(p.timestamp),
      initiator: p.initiator?.type,
      stack: p.initiator?.stack?.callFrames?.slice(0, 4).map((f) => `${f.functionName || "?"}@${(f.url || "").split("/").pop()}:${f.lineNumber}`),
    });
  });
  cdp.on("Network.responseReceived", (p) => {
    const r = reqs.get(p.requestId);
    if (r) {
      r.status = p.response.status;
      r.mime = p.response.mimeType;
      r.ttfb = rel(p.timestamp);
      r.fromCache = p.response.fromDiskCache || p.response.fromPrefetchCache;
    }
  });
  cdp.on("Network.loadingFinished", (p) => {
    const r = reqs.get(p.requestId);
    if (r) {
      r.end = rel(p.timestamp);
      r.bytes = p.encodedDataLength;
    }
  });
  cdp.on("Network.loadingFailed", (p) => {
    const r = reqs.get(p.requestId);
    if (r) {
      r.end = rel(p.timestamp);
      r.failed = p.errorText;
      r.canceled = p.canceled;
    }
  });
  cdp.on("Network.webSocketCreated", (p) => events.push({ t: 0, e: `WS created ${p.url}` }));
  cdp.on("Network.webSocketHandshakeResponseReceived", (p) =>
    events.push({ t: rel(p.timestamp), e: `WS handshake ok` })
  );

  log("\nreloading (cache cleared)...");
  await cdp.send("Page.reload", { ignoreCache: true });

  // Poll DOM for chat-content readiness markers while requests stream in.
  const marks = [];
  const pollStart = Date.now();
  const probe = `(() => {
    const q = (s) => !!document.querySelector(s);
    return JSON.stringify({
      root: !!document.querySelector('#root')?.children.length,
      // chat message bubbles / markdown blocks
      msgs: document.querySelectorAll('[data-message-id], [data-role], .prose').length,
      spinners: document.querySelectorAll('.animate-spin, [data-loading="true"]').length,
      tabs: document.querySelectorAll('[role="tab"], [data-tab-id]').length,
      // Tabs actually MOUNTED by TabPool (the lazy-mount metric) vs listed in the strip.
      poolMounted: document.querySelectorAll('[data-tab-pool-id]').length,
      text: (document.body.innerText || '').length,
    });
  })()`;
  // Fixed 20s window: long enough to also observe idle prefetch (which starts
  // ~2.5s after the visible tabs mount and then steps once per idle tick).
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    try {
      const r = await cdp.send("Runtime.evaluate", { expression: probe, returnByValue: true });
      const v = JSON.parse(r.result.value);
      marks.push({ t: Date.now() - pollStart, ...v });
    } catch {}
  }

  await Bun.sleep(1500);

  // ---- report ----
  const all = [...reqs.values()].sort((a, b) => a.start - b.start);
  const api = all.filter((r) => r.url.includes("/api/"));
  const assets = all.filter((r) => !r.url.includes("/api/"));
  const short = (u) => u.replace(ORIGIN, "").split("?")[0].slice(0, 62);

  log(`\n---- ASSETS: ${assets.length} req, ${(assets.reduce((s, r) => s + (r.bytes || 0), 0) / 1024).toFixed(0)} KB ----`);
  for (const r of assets.slice(0, 12))
    log(`  ${String(r.start).padStart(5)}ms +${String((r.end ?? r.start) - r.start).padStart(5)}ms  ${String(r.status ?? r.failed).padEnd(6)} ${(r.bytes / 1024).toFixed(0).padStart(5)}KB  ${short(r.url)}`);
  if (assets.length > 12) log(`  ... +${assets.length - 12} more`);

  log(`\n---- API CALLS: ${api.length} ----`);
  log(`  start   dur   status  bytes  endpoint`);
  for (const r of api) {
    const dur = (r.end ?? r.ttfb ?? r.start) - r.start;
    const flag = r.failed ? ` !! ${r.failed}` : r.status >= 400 ? ` !! HTTP ${r.status}` : "";
    log(
      `  ${String(r.start).padStart(5)}ms ${String(dur).padStart(5)}ms  ${String(r.status ?? "-").padEnd(6)} ${String(r.bytes ?? "-").padStart(6)}  ${r.method} ${short(r.url)}${flag}`
    );
    if (r.stack && (dur > 300 || flag)) log(`         stack: ${r.stack.join(" < ")}`);
  }

  const failed = api.filter((r) => r.failed || r.status >= 400);
  log(`\n---- FAILURES: ${failed.length} ----`);
  for (const r of failed)
    log(`  ${r.method} ${short(r.url)} → ${r.failed || "HTTP " + r.status}${r.canceled ? " (canceled)" : ""}`);

  log(`\n---- SLOWEST API (>200ms) ----`);
  for (const r of [...api].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 10)) {
    const dur = (r.end ?? r.ttfb) - r.start;
    if (dur > 200) log(`  ${String(dur).padStart(5)}ms  ${short(r.url)}`);
  }

  log(`\n---- DOM readiness timeline ----`);
  let prev = null;
  for (const m of marks) {
    const k = `${m.root}|${m.msgs}|${m.spinners}|${m.tabs}|${m.poolMounted}|${Math.floor(m.text / 200)}`;
    if (k !== prev) {
      log(`  ${String(m.t).padStart(5)}ms  root=${m.root} poolMounted=${m.poolMounted} tabsInStrip=${m.tabs} msgs=${m.msgs} spinners=${m.spinners} textLen=${m.text}`);
      prev = k;
    }
  }
  const lastReq = Math.max(...api.map((r) => r.end ?? r.start));
  log(`\nlast API finished: ${lastReq}ms | total requests: ${all.length}`);

  await writeFile(
    join(tmpdir(), `ppm-boot-audit-${MOBILE ? "mobile" : "desktop"}.json`),
    JSON.stringify({ api, assets, marks }, null, 2)
  );
  log(`raw: ${join(tmpdir(), `ppm-boot-audit-${MOBILE ? "mobile" : "desktop"}.json`)}`);
};

try {
  await main();
} finally {
  chrome?.kill();
}
process.exit(0);
