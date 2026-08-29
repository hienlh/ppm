// Chat composer must appear even when the draft request never settles.
//
// Repro this guards against: a `GET /chat/drafts/:id` that stalls leaves
// `draftLoading` stuck true, and chat-tab gates MessageInput on it — so a new
// chat tab renders the transcript with NO input box until a page reload.
//
// The stub here returns a promise that never settles AND ignores abort, so it
// also defeats the api-client request timeout. Only the draft-gate release can
// make this pass.
//
// Run:
//   bun tests/e2e/chat-composer-stalled-draft-e2e.mjs
//
// Env:
//   PPM_E2E_NO_SERVERS=1  assume dev servers already running; don't spawn/kill
//   CHROME_PATH=...       override Chrome executable path

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const REPO = process.cwd();
const AUTH_TOKEN = "123123";
const TOKEN_KEY = "ppm-auth-token";
const API = "http://localhost:8081";
const WEB = "http://localhost:5173";
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent("ppm")}`;
const CDP_PORT = 9223;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NO_SERVERS = !!process.env.PPM_E2E_NO_SERVERS;

// The composer must show up well inside this budget; the gate releases at 3s.
const COMPOSER_BUDGET_MS = 8_000;

const started = { server: null, web: null, chrome: null };
const log = (m) => console.log(m);

async function isUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function waitUp(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await Bun.sleep(500);
  }
  throw new Error(`${label} never came up at ${url}`);
}

function spawnBg(cmd, args, name) {
  const child = spawn(cmd, args, { cwd: REPO, stdio: "ignore", shell: true });
  child.on("error", (e) => log(`  ${name} spawn error: ${e.message}`));
  return child;
}

async function ensureServers() {
  if (NO_SERVERS) return;
  if (!(await isUp(`${API}/api/health`)) && !(await isUp(API))) {
    log("  starting bun dev:server (8081)");
    started.server = spawnBg("bun", ["run", "dev:server"], "dev:server");
  }
  if (!(await isUp(WEB))) {
    log("  starting bun dev:web (5173)");
    started.web = spawnBg("bun", ["run", "dev:web"], "dev:web");
  }
  await waitUp(WEB, "dev:web");
  await waitUp(API, "dev:server");
}

async function launchChrome() {
  const profile = join(tmpdir(), `ppm-composer-e2e-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  started.chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=390,844",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, {
        signal: AbortSignal.timeout(1500),
      });
      const page = (await r.json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await Bun.sleep(500);
  }
  throw new Error("Chrome DevTools endpoint never became ready");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const entry = msg.id && this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP ws error")), { once: true });
    });
    return new Cdp(ws);
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

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "evaluate threw: " +
          (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
      );
    }
    return r.result?.value;
  }
}

/**
 * Runs before any app code on every navigation: seeds auth, then either stalls
 * the draft load forever or delays it by `delayMs`.
 */
const initScript = (delayMs) => `
  localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)});
  window.__stalledDrafts = 0;
  window.__draftUrls = [];
  const origFetch = window.fetch;
  const delayMs = ${delayMs === null ? "null" : delayMs};
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/chat/drafts/") && (!init || init.method === undefined || init.method === "GET")) {
      window.__stalledDrafts++;
      window.__draftUrls.push(url);
      // Never settles and deliberately ignores init.signal — the worst case.
      if (delayMs === null) return new Promise(function () {});
      // Issue the request NOW and hold the answer back, so the response
      // reflects server state at request time, not after the user typed.
      const inFlight = origFetch.apply(this, arguments);
      return new Promise(function (resolve, reject) {
        setTimeout(function () { inFlight.then(resolve, reject); }, delayMs);
      });
    }
    return origFetch.apply(this, arguments);
  };
`;

const COMPOSER_PROBE = `(() => {
  const tas = Array.from(document.querySelectorAll("textarea"));
  const composer = tas.find((t) => /ask anything|follow-up/i.test(t.placeholder || ""));
  return {
    visible: !!(composer && composer.offsetParent !== null),
    value: composer ? composer.value : null,
    intercepted: window.__stalledDrafts || 0,
    urls: window.__draftUrls || [],
  };
})()`;

/** Poll the page until `done(probe)` or the budget runs out. */
async function pollComposer(cdp, done, budgetMs) {
  const t0 = Date.now();
  let last = { visible: false, value: null, intercepted: 0 };
  while (Date.now() - t0 < budgetMs) {
    await Bun.sleep(250);
    try {
      last = await cdp.evaluate(COMPOSER_PROBE);
    } catch {
      continue; // page still loading
    }
    if (done(last)) break;
  }
  return { ...last, elapsed: Date.now() - t0 };
}

/** Set from scenario 1 — the draft path the app actually requests. */
let draftUrl = `${API}/api/project/ppm/chat/drafts/__new__`;
const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AUTH_TOKEN}`,
};

let injectedScriptId = null;

async function openApp(cdp, delayMs) {
  // Scripts accumulate per page, and a second one would wrap the first's fetch
  // patch instead of replacing it.
  if (injectedScriptId) {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injectedScriptId });
  }
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: initScript(delayMs),
  });
  injectedScriptId = identifier;
  // Hop through about:blank so re-running the same URL still yields a fresh
  // document (and therefore re-runs the injected script).
  await cdp.send("Page.navigate", { url: "about:blank" });
  await Bun.sleep(300);
  await cdp.send("Page.navigate", { url: WEB_PROJECT });
}

/** The reported bug: a draft load that never answers must not hide the input. */
async function scenarioStalled(cdp) {
  log("\n[1] draft request stalls forever");
  await fetch(draftUrl, { method: "DELETE", headers: authHeaders }).catch(() => {});
  await openApp(cdp, null);

  const r = await pollComposer(cdp, (p) => p.visible, COMPOSER_BUDGET_MS);
  log(`  intercepted=${r.intercepted} visible=${r.visible} after ${r.elapsed}ms`);

  if (r.intercepted === 0) throw new Error("FAIL [1] — repro did not arm; no draft GET intercepted");
  if (!r.visible) {
    throw new Error(`FAIL [1] — composer never rendered within ${COMPOSER_BUDGET_MS}ms`);
  }
  log(`  PASS [1] — composer rendered in ${r.elapsed}ms despite a permanently stalled draft load`);

  // Scenario 2 must seed the draft the app really asks for, not an assumed id.
  const observed = r.urls[0];
  if (observed) {
    draftUrl = observed.startsWith("http") ? observed : `${API}${observed}`;
    log(`  observed draft URL: ${draftUrl}`);
  }
}

/** Releasing the gate early must not cost the user their saved draft. */
async function scenarioLateDraft(cdp) {
  log("\n[2] draft answers late (5s), after the gate already released");
  const content = `restored-draft-${Date.now()}`;
  const seed = await fetch(draftUrl, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ content, attachments: "[]" }),
  });
  if (!seed.ok) throw new Error(`FAIL [2] — could not seed draft (HTTP ${seed.status})`);

  await openApp(cdp, 5_000);

  const shown = await pollComposer(cdp, (p) => p.visible, COMPOSER_BUDGET_MS);
  if (!shown.visible) throw new Error("FAIL [2] — composer never rendered");
  log(`  composer visible after ${shown.elapsed}ms, value=${JSON.stringify(shown.value)}`);
  if (shown.value === content) {
    throw new Error("FAIL [2] — draft arrived before the gate released; scenario did not exercise late restore");
  }

  const restored = await pollComposer(cdp, (p) => p.value === content, 12_000);
  await fetch(draftUrl, { method: "DELETE", headers: authHeaders }).catch(() => {});

  if (restored.value !== content) {
    throw new Error(`FAIL [2] — late draft never restored (value=${JSON.stringify(restored.value)})`);
  }
  log(`  PASS [2] — late draft restored into the already-mounted composer`);
}

/** A late draft must never overwrite text typed while it was still in flight. */
async function scenarioTypedWins(cdp) {
  log("\n[3] user types before a late draft lands");
  const content = `stale-draft-${Date.now()}`;
  const typed = "typed by the user";
  const seed = await fetch(draftUrl, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ content, attachments: "[]" }),
  });
  if (!seed.ok) throw new Error(`FAIL [3] — could not seed draft (HTTP ${seed.status})`);

  await openApp(cdp, 8_000);
  const shown = await pollComposer(cdp, (p) => p.visible, COMPOSER_BUDGET_MS);
  if (!shown.visible) throw new Error("FAIL [3] — composer never rendered");

  await cdp.evaluate(`(() => {
    const t = Array.from(document.querySelectorAll("textarea"))
      .find((t) => /ask anything|follow-up/i.test(t.placeholder || ""));
    t.focus();
    return true;
  })()`);
  await cdp.send("Input.insertText", { text: typed });
  log(`  typed at ${shown.elapsed}ms; waiting for the 8s draft response`);

  await Bun.sleep(9_000);
  const after = await pollComposer(cdp, () => true, 1_000);
  await fetch(draftUrl, { method: "DELETE", headers: authHeaders }).catch(() => {});

  if (after.value !== typed) {
    throw new Error(
      `FAIL [3] — typed text was clobbered; value=${JSON.stringify(after.value)}`,
    );
  }
  log(`  PASS [3] — typed text survived the late draft`);
}

async function main() {
  log("PPM chat composer — stalled/late draft e2e");
  await ensureServers();

  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await scenarioStalled(cdp);
  await scenarioLateDraft(cdp);
  await scenarioTypedWins(cdp);
  log("\nPASS — all scenarios");
}

function killStarted() {
  for (const [name, child] of Object.entries(started)) {
    if (!child?.pid) continue;
    try {
      // Exact PID only — never kill by image name; other bun/chrome processes
      // on this machine are unrelated (prod supervisor, user's browser).
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      log(`  stopped ${name} (pid ${child.pid})`);
    } catch {
      /* already gone */
    }
  }
}

try {
  await main();
  killStarted();
  process.exit(0);
} catch (e) {
  console.error(String(e.message || e));
  killStarted();
  process.exit(1);
}
