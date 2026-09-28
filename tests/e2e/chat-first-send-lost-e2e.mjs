// The first message of a new chat tab must never vanish silently.
//
// Repro this guards against: a new (draft) chat tab has no session and no
// WebSocket. Its first send first has to POST /chat/sessions and then wait
// for the fresh socket's `session_state` before the message is actually sent.
// The composer used to clear its textarea and DELETE the server draft *before*
// any of that had succeeded, so when the create call failed, hung, or the socket
// never said hello, the text was gone, nothing rendered and nothing was said.
//
// Three failure shapes are simulated at the network boundary, and for each the
// user must get the text back in the composer, a toast saying so, and the saved
// draft must survive:
//   [1] POST /chat/sessions rejects (network error)
//   [2] POST /chat/sessions never settles      (create timeout, ~30 s)
//   [3] POST succeeds, but the chat WebSocket never opens (pending-send watchdog, ~45 s)
//   [4] as [1], but the composer was prefilled from a saved draft and sent unedited
//   [5] control: nothing fails — the message goes out, the draft is cleared, and the
//       sent text is NOT re-saved as the new session's draft
//
// Run:
//   bun tests/e2e/chat-first-send-lost-e2e.mjs
//
// Env:
//   PPM_E2E_NO_SERVERS=1  assume dev servers already running; don't spawn/kill
//   PPM_E2E_API_PORT=8082 dev server on an alternative port (default 8081)
//   CHROME_PATH=...       override Chrome executable path

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const REPO = process.cwd();
const AUTH_TOKEN = "123123";
const TOKEN_KEY = "ppm-auth-token";
// Alt-port dev stack (see memory: 8081 zombie) — the app's dev WS URL is hard-coded to
// 8081, so the init script rewrites socket URLs to this port as well.
const API_PORT = process.env.PPM_E2E_API_PORT || "8081";
const API = `http://localhost:${API_PORT}`;
const WEB = "http://localhost:5173";
const WEB_PROJECT = `${WEB}/project/${encodeURIComponent("ppm")}`;
const CDP_PORT = 9224;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NO_SERVERS = !!process.env.PPM_E2E_NO_SERVERS;

const COMPOSER_BUDGET_MS = 15_000;
/** Covers the pending-send watchdog (45 s) with margin; a reaction sooner ends the wait. */
const REACTION_BUDGET_MS = 70_000;

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
  const profile = join(tmpdir(), `ppm-first-send-e2e-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  started.chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1280,900",
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
 * Runs before any app code on every navigation: seeds auth and installs the
 * chosen fault at the network boundary. `mode` is one of:
 *   "reject"  — POST /chat/sessions rejects with a TypeError (network failure)
 *   "stall"   — POST /chat/sessions never settles
 *   "no-ws"   — POST goes through; the chat WebSocket never opens
 */
const initScript = (mode) => `
  localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(AUTH_TOKEN)});
  window.__e2e = { mode: ${JSON.stringify(mode)}, sessionPosts: 0, draftDeletes: 0, draftDeleteUrls: [], draftPuts: [], chatSockets: 0, swallowedMessages: 0, consoleErrors: [] };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || "GET";
    if (/\\/chat\\/sessions(\\?|$)/.test(url) && method === "POST") {
      window.__e2e.sessionPosts++;
      if (window.__e2e.mode === "reject") return Promise.reject(new TypeError("Failed to fetch"));
      if (window.__e2e.mode === "stall") {
        // Never answers, but honours abort the way a real fetch does — the caller's
        // own timeout is the only thing that may end this wait.
        return new Promise(function (_, reject) {
          const sig = init && init.signal;
          if (sig) sig.addEventListener("abort", function () { reject(sig.reason || new DOMException("Aborted", "AbortError")); });
        });
      }
    }
    if (url.includes("/chat/drafts/") && method === "DELETE") { window.__e2e.draftDeletes++; window.__e2e.draftDeleteUrls.push(url); }
    if (url.includes("/chat/drafts/") && method === "PUT") {
      let content = null;
      try { content = JSON.parse(init.body).content; } catch {}
      window.__e2e.draftPuts.push({ url, content, at: Date.now() });
    }
    return origFetch.apply(this, arguments);
  };
  const OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    url = String(url).replace(":8081/", ":" + ${JSON.stringify(API_PORT)} + "/");
    if (url.includes("/chat/") && window.__e2e.mode === "no-ws") {
      window.__e2e.chatSockets++;
      // A socket that never opens and never errors: the shape of a tunnel that
      // accepted the TCP connection and then went quiet.
      const dead = new OrigWS("ws://127.0.0.1:9/never");
      Object.defineProperty(dead, "readyState", { get: function () { return OrigWS.CONNECTING; } });
      dead.send = function () {};
      dead.close = function () {};
      return dead;
    }
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    if (url.includes("/chat/") && window.__e2e.mode === "happy") {
      // Real socket, real handshake — but the user message itself is swallowed so the
      // happy path can be exercised without spending a model turn on the dev server.
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try { if (JSON.parse(data).type === "message") { window.__e2e.swallowedMessages++; return; } } catch {}
        return origSend(data);
      };
    }
    return ws;
  }
  PatchedWS.prototype = OrigWS.prototype;
  PatchedWS.CONNECTING = 0; PatchedWS.OPEN = 1; PatchedWS.CLOSING = 2; PatchedWS.CLOSED = 3;
  window.WebSocket = PatchedWS;
  const origError = console.error;
  console.error = function () {
    window.__e2e.consoleErrors.push(Array.from(arguments).map(String).join(" "));
    return origError.apply(this, arguments);
  };
`;

// Every composer mounted BEFORE the new tab opened is stamped `data-e2e-old`; the new
// tab's composer is the unstamped one. Sorting by visibility alone picked another
// panel's live session in a split layout and sent a real message into it.
const composerExpr = `Array.from(document.querySelectorAll("textarea"))
  .filter((t) => /ask anything|follow-up/i.test(t.placeholder || ""))
  .sort((a, b) => Number(!!a.dataset.e2eOld) - Number(!!b.dataset.e2eOld)
    || Number(b.offsetParent !== null) - Number(a.offsetParent !== null))[0]`;

const probeExpr = (marker) => `(() => {
  const composer = ${composerExpr};
  const toasts = Array.from(document.querySelectorAll("[data-sonner-toast]")).map((t) => t.textContent);
  return {
    composerVisible: !!(composer && composer.offsetParent !== null),
    composerValue: composer ? composer.value : null,
    bubbleRendered: document.body.innerText.includes(${JSON.stringify(marker)}),
    toasts,
    e2e: window.__e2e,
  };
})()`;

async function poll(cdp, expr, done, budgetMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    await Bun.sleep(250);
    try {
      last = await cdp.evaluate(expr);
    } catch {
      continue; // page still loading
    }
    if (done(last)) break;
  }
  return { ...last, elapsed: Date.now() - t0 };
}

let injectedScriptId = null;

async function openApp(cdp, mode) {
  if (injectedScriptId) {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injectedScriptId });
  }
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: initScript(mode),
  });
  injectedScriptId = identifier;
  // Page.navigate's reply can be held back by the page being left (open sockets, a
  // stalled fetch); the navigation itself still happens, so don't wait on the reply.
  const navigate = (url) => Promise.race([cdp.send("Page.navigate", { url }), Bun.sleep(5_000)]);
  await navigate("about:blank");
  await Bun.sleep(300);
  await navigate(WEB_PROJECT);
}

/** Open a *new* chat tab so the composer belongs to a draft (no session yet). Mod+L = "open-chat". */
async function openNewChatTab(cdp) {
  // A synthetic KeyboardEvent on `document`, as chat-account-claim-e2e does: CDP key
  // injection lands wherever focus happens to be and the global handler may not see it.
  // Success is read from the persisted layout (a chat tab with no sessionId), because
  // the composer count says nothing — keep-alive caps how many stay mounted.
  return cdp.evaluate(`(() => {
    const draftTabs = () => {
      let n = 0;
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o.type === "chat" && o.metadata && !o.metadata.sessionId) n++;
        Object.values(o).forEach(walk);
      };
      for (const k of Object.keys(localStorage)) {
        if (!/"type":"chat"/.test(localStorage.getItem(k) || "")) continue;
        try { walk(JSON.parse(localStorage.getItem(k))); } catch {}
      }
      return n;
    };
    const before = draftTabs();
    document.querySelectorAll("textarea").forEach((t) => { t.dataset.e2eOld = "1"; });
    document.querySelectorAll("[data-tab-id]").forEach((t) => { t.dataset.e2eOld = "1"; });
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l", code: "KeyL", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    // The new tab's composer is gated on its draft load (up to 3 s) — poll for it.
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const composer = ${composerExpr};
        const composerIsNew = !!composer && !composer.dataset.e2eOld && composer.offsetParent !== null;
        if (composerIsNew || Date.now() - t0 > 8000) {
          resolve({
            before,
            after: draftTabs(),
            composerEmpty: !!composer && composer.value === "",
            composerIsNew,
          });
        } else setTimeout(tick, 200);
      };
      setTimeout(tick, 300);
    });
  })()`);
}

/** Close the tab this scenario opened, so runs don't pile draft tabs into the saved layout. */
async function closeNewChatTab(cdp) {
  return cdp.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll("[data-tab-id]")).find((t) => !t.dataset.e2eOld);
    const close = tab && tab.querySelector("[role=button]");
    if (!close) return false;
    close.click();
    return true;
  })()`).catch(() => false);
}

async function typeAndSend(cdp, marker) {
  await cdp.evaluate(`(() => { const t = ${composerExpr}; t.focus(); return true; })()`);
  if (marker) await cdp.send("Input.insertText", { text: marker });
  await Bun.sleep(200);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** One fresh page per scenario — a page left with a stalled fetch wedged Page.navigate. */
async function newPage() {
  const r = await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const target = await r.json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const close = () => fetch(`http://localhost:${CDP_PORT}/json/close/${target.id}`).catch(() => {});
  return { cdp, close };
}

const NEW_DRAFT_URL = `${API}/api/project/ppm/chat/drafts/__new__`;
const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` };

/**
 * `mode` is the fault injected (see initScript). `prefill` seeds the marker as the
 * new-tab draft instead of typing it, so the composer starts already holding the text
 * and the send goes out unedited — the case where the restored value equals the one
 * the composer was prefilled with, and a value-keyed restore silently does nothing.
 */
async function scenario(mode, label, { prefill = false } = {}) {
  const name = prefill ? `${mode}+prefill` : mode;
  log(`\n[${name}] ${label}`);
  // The previous scenario deliberately left its text as the new-tab draft; a fresh
  // tab would restore it, and the composer must start from a known state here.
  await fetch(NEW_DRAFT_URL, { method: "DELETE", headers: authHeaders }).catch(() => {});
  const marker = `long-message-${name}-${Date.now()}`;
  if (prefill) {
    const seed = await fetch(NEW_DRAFT_URL, {
      method: "PUT", headers: authHeaders,
      body: JSON.stringify({ content: marker, attachments: "[]" }),
    });
    if (!seed.ok) throw new Error(`FAIL [${name}] — could not seed the new-tab draft (HTTP ${seed.status})`);
  }
  const { cdp, close } = await newPage();
  try {
    return await runScenario(cdp, mode, name, marker, prefill);
  } finally {
    await close();
  }
}

async function runScenario(cdp, mode, name, marker, prefill) {
  injectedScriptId = null; // fresh page, nothing injected yet
  await openApp(cdp, mode);
  let shown = await poll(cdp, probeExpr("__none__"), (p) => p.composerVisible, COMPOSER_BUDGET_MS);
  if (!shown.composerVisible) throw new Error(`FAIL [${name}] — composer never rendered`);
  await Bun.sleep(1_000); // let the layout settle before adding a tab
  const tabs = await openNewChatTab(cdp);
  log(`  new chat tab via Ctrl+L (draft tabs ${tabs.before} → ${tabs.after}, composer empty=${tabs.composerEmpty}, new=${tabs.composerIsNew})`);
  // Refuse to type into an existing session's composer — that would send a real message.
  if (tabs.after <= tabs.before || !tabs.composerIsNew || (!prefill && !tabs.composerEmpty)) {
    throw new Error(`FAIL [${name}] — no new draft tab opened; not sending into an existing session`);
  }
  shown = await poll(cdp, probeExpr("__none__"), (p) => p.composerVisible, COMPOSER_BUDGET_MS);
  if (!shown.composerVisible) throw new Error(`FAIL [${name}] — composer of the new tab never rendered`);
  await Bun.sleep(1_500); // draft load + account claim settle

  if (prefill) {
    const before = await cdp.evaluate(probeExpr(marker));
    if (before.composerValue !== marker) {
      throw new Error(`FAIL [${name}] — seeded draft did not prefill the composer (value=${JSON.stringify(before.composerValue)})`);
    }
    await typeAndSend(cdp, ""); // Enter only — send the prefilled draft unedited
  } else {
    await typeAndSend(cdp, marker);
  }

  // Wait for the fault to have been exercised, then for any reaction.
  const reacted = await poll(
    cdp,
    probeExpr(marker),
    (p) => p.e2e.sessionPosts > 0 && (p.bubbleRendered || p.toasts.length > 0 || p.composerValue === marker),
    REACTION_BUDGET_MS,
  );
  // Let the composer's 1 s draft debounce settle so stray or missing saves are visible.
  await Bun.sleep(1_800);
  const r = { ...(await cdp.evaluate(probeExpr(marker))), elapsed: reacted.elapsed };

  const lastPut = r.e2e.draftPuts[r.e2e.draftPuts.length - 1] ?? null;
  const outcome = {
    faultArmed: r.e2e.sessionPosts > 0,
    chatSockets: r.e2e.chatSockets,
    textKeptInComposer: r.composerValue === marker,
    bubbleRendered: r.bubbleRendered,
    toastShown: r.toasts.some((t) => /not sent/i.test(t)),
    draftDeletes: r.e2e.draftDeleteUrls.map((u) => u.slice(u.lastIndexOf("/") + 1)),
    lastDraftPut: lastPut && { id: lastPut.url.slice(lastPut.url.lastIndexOf("/") + 1), isMarker: lastPut.content === marker },
    consoleErrors: r.e2e.consoleErrors.filter((e) => /session/i.test(e)),
    elapsedMs: r.elapsed,
  };
  log(`  ${JSON.stringify(outcome)}`);
  const closed = await closeNewChatTab(cdp);
  if (!closed) log(`  (could not close the scenario's tab — one draft tab left in the layout)`);
  if (!outcome.faultArmed) throw new Error(`FAIL [${name}] — repro did not arm; no POST /chat/sessions observed`);

  const problems = [];
  if (mode === "happy") {
    // Control: with nothing in the way, the message goes out and the new-tab draft
    // goes with it — by its own id — and nothing re-saves the sent text as the new
    // session's draft, which is what a debounce left armed at Enter used to do.
    if (!outcome.bubbleRendered) problems.push("no user bubble rendered");
    if (r.e2e.swallowedMessages !== 1) problems.push(`expected 1 message frame on the socket, saw ${r.e2e.swallowedMessages}`);
    if (!outcome.draftDeletes.includes("__new__")) problems.push("new-tab draft not cleared after the send");
    if (r.e2e.draftPuts.some((p) => p.content === marker && !p.url.endsWith("/__new__"))) problems.push("sent message re-saved as the new session's draft");
    if (outcome.textKeptInComposer || outcome.toastShown) problems.push("send reported as failed");
    if (problems.length) { log(`  FAIL [${name}] — ${problems.join("; ")}`); return false; }
    log(`  PASS [${name}] — message sent, __new__ draft cleared, no stray save (${r.elapsed}ms)`);
    return true;
  }

  if (!outcome.textKeptInComposer) problems.push("text not back in the composer");
  if (!outcome.toastShown) problems.push("no 'Message not sent' toast");
  if (!outcome.lastDraftPut?.isMarker) problems.push("restored text not re-saved as the draft");
  if (outcome.bubbleRendered) problems.push("a bubble was rendered for a message that never left");
  if (mode === "no-ws") {
    // The tab is on its new session now; the composer re-saves there and the stale
    // __new__ row must go, or the next new tab inherits this message.
    if (!outcome.draftDeletes.includes("__new__")) problems.push("stale __new__ draft left behind after the tab moved to its session");
  } else if (outcome.draftDeletes.length) {
    problems.push("server draft deleted although nothing was sent");
  }
  if (problems.length) {
    log(`  FAIL [${name}] — ${problems.join("; ")}`);
    return false;
  }
  log(`  PASS [${name}] — text restored, failure announced, draft kept (${r.elapsed}ms)`);
  return true;
}

async function main() {
  log("PPM chat — first send of a new tab must not be lost silently");
  await ensureServers();

  await launchChrome();

  const results = [];
  results.push(await scenario("reject", "POST /chat/sessions fails with a network error"));
  results.push(await scenario("stall", "POST /chat/sessions never answers"));
  results.push(await scenario("no-ws", "session created, chat WebSocket never opens"));
  results.push(await scenario("reject", "composer prefilled from a saved draft, sent unedited, create fails", { prefill: true }));
  results.push(await scenario("happy", "control — nothing fails, message is sent and the draft cleared"));
  await fetch(NEW_DRAFT_URL, { method: "DELETE", headers: authHeaders }).catch(() => {});

  if (results.every(Boolean)) log("\nPASS — every failure shape hands the text back, and the happy path still sends");
  else throw new Error(`FAIL — ${results.filter((r) => !r).length}/${results.length} scenarios failed`);
}

function killStarted() {
  for (const [name, child] of Object.entries(started)) {
    if (!child?.pid) continue;
    try {
      // Exact PID only — never kill by image name.
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
