/**
 * Plumbing for `tests/e2e/new-chat-instant-e2e.mjs`: page instrumentation, a network log
 * with a switchable delay policy, and the few store calls a scenario needs.
 *
 * Nothing waits for "network idle" — the app holds WebSockets open for its whole life, so it
 * never is. Every wait is on an element, a response or a logged request.
 */

/** Installed with `context.addInitScript`; runs before any app code in every document. */
export function instantInstrumentation({ api, blockStorage }) {
  if (window.top !== window) return;
  const e2e = { framesSent: [], storageErrors: 0, deniedFrom: [] };
  window.__e2e = e2e;
  if (blockStorage) {
    // Chrome's own shape for "site data blocked": touching either global throws. Where each
    // access came from is kept, so an unguarded caller can be named.
    const deny = () => {
      e2e.storageErrors++;
      const frame = (new Error().stack || "").split("\n").slice(2, 4).map((l) => l.trim().replace(/\?[^:]*:/, ":")).join(" < ");
      if (!e2e.deniedFrom.includes(frame) && e2e.deniedFrom.length < 60) e2e.deniedFrom.push(frame);
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    // IndexedDB is used by nothing but the browser cache layer, so it is always fully blocked.
    Object.defineProperty(window, "indexedDB", { configurable: true, get: deny });
    if (blockStorage === "all") {
      Object.defineProperty(window, "localStorage", { configurable: true, get: deny });
    } else {
      // "cache": every localStorage key the cache layer owns throws on use; the rest of the
      // app (auth token, layout, settings) keeps its storage, so what is measured is the
      // cache layer falling back to the network rather than the app's boot.
      const owned = (key) => key === "ppm-chat-pref" || String(key).startsWith("ppm-chat-providers:");
      for (const name of ["getItem", "setItem", "removeItem"]) {
        const original = Storage.prototype[name];
        Storage.prototype[name] = function (key, ...rest) {
          if (owned(key)) deny();
          return original.call(this, key, ...rest);
        };
      }
    }
    try {
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({
        version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null,
      }));
    } catch { /* storage unavailable */ }
  } else {
    try {
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({
        version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null,
      }));
    } catch { /* storage unavailable */ }
  }
  // The dev client dials the backend on :8081 directly; point that at this run's server.
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(input, protocols) {
      const url = new URL(String(input), location.href);
      if (url.port === "8081") { url.hostname = "127.0.0.1"; url.port = new URL(api).port; }
      super(url.href, protocols);
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Logs every `/api/` request of a page with its send and response times, and holds matching
 * requests back by the current policy's delay. `release` times are when a held request was
 * let go — no response can arrive before its release.
 */
export async function instrumentNetwork(context, page) {
  const log = [];
  const releases = [];
  let policy = () => 0;
  // A predicate, not a glob: only the backend's own `/api/` path is held, never a Vite module.
  await context.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req = route.request();
    const ms = policy(req);
    if (ms > 0) await sleep(ms);
    releases.push({ path: new URL(req.url()).pathname, method: req.method(), at: Date.now(), heldMs: ms });
    try { await route.continue(); } catch { /* page navigated away meanwhile */ }
  });
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return;
    const entry = { method: req.method(), path: url.pathname, search: url.search, at: Date.now(), req, body: req.postData() };
    log.push(entry);
  });
  page.on("response", (res) => {
    const entry = log.find((e) => e.req === res.request());
    if (entry) { entry.respondedAt = Date.now(); entry.status = res.status(); entry.res = res; }
  });
  return {
    log, releases,
    setPolicy(fn) { policy = fn; },
    since(t) { return log.filter((e) => e.at >= t); },
    releasesSince(t) { return releases.filter((r) => r.at >= t && r.heldMs > 0); },
  };
}

/** Frames the page sends on chat sockets. */
export function recordChatFrames(page) {
  const frames = [];
  page.on("websocket", (ws) => {
    if (!/\/ws\/project\/[^/]+\/chat\//.test(ws.url())) return;
    ws.on("framesent", (f) => {
      let parsed = null;
      try { parsed = JSON.parse(String(f.payload)); } catch { /* not JSON */ }
      frames.push({ url: ws.url(), at: Date.now(), data: parsed });
    });
  });
  return frames;
}

export async function until(what, fn, { timeout = 15000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** Loads the project route and waits until the project list (with paths) is in the store. */
export async function bootProject(page, web, project, { reload = false } = {}) {
  // The server-synced layout lands after the project list and replaces the tab set, so a tab
  // opened before it arrives is thrown away. With storage blocked the app never asks for it
  // (it reads the auth token from localStorage first), hence the bounded wait.
  const workspace = page.waitForResponse((r) => r.request().method() === "GET" &&
    new URL(r.url()).pathname === `/api/project/${encodeURIComponent(project)}/workspace`, { timeout: 15000 }).catch(() => null);
  if (reload) await page.reload();
  else await page.goto(`${web}/project/${encodeURIComponent(project)}`);
  // Not page.waitForFunction: an async predicate returns a Promise, which it takes as truthy.
  await until("the project list in the store", () => page.evaluate(async (name) => {
    const { useProjectStore } = await import("/stores/project-store.ts");
    const s = useProjectStore.getState();
    return s.activeProject?.name === name && s.projects.some((p) => p.name === name && p.path);
  }, project), { timeout: 30000, interval: 100 });
  await workspace;
  // Two frames for the layout the response carried to be applied.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Opens a chat tab exactly the way the app's own "new chat" actions do, and returns the tab
 * metadata as `openTab` wrote it. Also starts an in-page per-frame probe recording when each
 * part of the tab was first on screen (`window.__e2e.firstSeen`), so a late element can be
 * named rather than guessed.
 */
export async function openChatTab(page, project) {
  return page.evaluate(async (projectName) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    const at = Date.now();
    const tabId = usePanelStore.getState().openTab({ type: "chat", title: "Chat", projectId: projectName, closable: true, metadata: { projectName } });
    const tab = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === tabId);
    const seen = { at };
    window.__e2e.firstSeen = seen;
    const visible = (el) => el && el.offsetParent !== null;
    const tick = () => {
      const root = document.querySelector(`[data-tab-pool-id="${tabId}"]`);
      const mark = (k, ok) => { if (ok && !seen[k]) seen[k] = Date.now() - at; };
      mark("root", !!root);
      if (root) {
        mark("textarea", [...root.querySelectorAll('textarea[placeholder="Ask anything..."]')].some(visible));
        mark("modeChip", [...root.querySelectorAll('button[aria-label^="Permission mode:"]')].some(visible));
        mark("providerChip", [...root.querySelectorAll('button[aria-label^="AI Provider:"]')].some(visible));
      }
      if (Date.now() - at < 20000 && !(seen.textarea && seen.modeChip && seen.providerChip)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { tabId, at, metadataAtOpen: JSON.parse(JSON.stringify(tab?.metadata ?? {})) };
  }, project);
}

export const firstSeen = (page) => page.evaluate(() => window.__e2e.firstSeen);

export async function tabMetadata(page, tabId) {
  return page.evaluate(async (id) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    const tab = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === id);
    return tab ? JSON.parse(JSON.stringify(tab.metadata ?? {})) : null;
  }, tabId);
}

/**
 * Closes every tab. With `save`, also waits for the debounced `PUT /workspace` that stores
 * the empty layout, so a later load (or another browser context) restores nothing.
 */
export async function closeAllTabs(page, { save = false } = {}) {
  const saved = save
    ? page.waitForResponse((r) => r.request().method() === "PUT" && /\/workspace$/.test(new URL(r.url()).pathname), { timeout: 5000 }).catch(() => null)
    : null;
  const closed = await page.evaluate(async () => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    const store = usePanelStore.getState();
    let n = 0;
    for (const panel of Object.values(store.panels)) for (const tab of [...panel.tabs]) { usePanelStore.getState().closeTab(tab.id, panel.id); n++; }
    return n;
  });
  if (saved && closed > 0) await saved;
}

export const tabRoot = (tabId) => `[data-tab-pool-id="${tabId}"]`;

/**
 * Waits, inside the page, for the tab's visible permission and provider chips and returns
 * their labels plus the page clock when they were first seen.
 */
export async function waitForChips(page, tabId, timeout = 15000) {
  const handle = await page.waitForFunction((root) => {
    const el = document.querySelector(root);
    if (!el) return false;
    const visible = (b) => b && b.offsetParent !== null;
    const mode = [...el.querySelectorAll('button[aria-label^="Permission mode:"]')].find(visible);
    const provider = [...el.querySelectorAll('button[aria-label^="AI Provider:"]')].find(visible);
    const box = [...el.querySelectorAll('textarea[placeholder="Ask anything..."]')].find(visible);
    if (!mode || !provider || !box) return false;
    return { at: Date.now(), mode: mode.getAttribute("aria-label"), provider: provider.getAttribute("aria-label") };
  }, tabRoot(tabId), { timeout, polling: "raf" });
  return handle.jsonValue();
}

export function composer(page, tabId) {
  return page.locator(`${tabRoot(tabId)} textarea[placeholder="Ask anything..."]:visible`).first();
}

/** Types "/" into the tab's composer and waits for the picker to list `skill`. */
export async function openSlashPicker(page, tabId, skill, timeout = 15000) {
  const box = composer(page, tabId);
  const t0 = Date.now();
  // focus(), not click(): a click waits for actionability (stable box, no overlay), and that
  // wait would be charged to the picker.
  await box.focus();
  await page.keyboard.type("/");
  const typedAt = Date.now();
  const handle = await page.waitForFunction(({ root, skill }) => {
    const el = document.querySelector(root);
    const panel = el && el.querySelector("div.max-h-52.overflow-y-auto");
    if (!panel || !panel.textContent.includes(skill)) return false;
    return { at: Date.now(), items: panel.querySelectorAll("button:not([aria-label])").length };
  }, { root: tabRoot(tabId), skill }, { timeout, polling: "raf" });
  const seen = { ...(await handle.jsonValue()), typedAt, typedAfterMs: typedAt - t0 };
  await page.keyboard.press("Escape");
  await box.fill("");
  return seen;
}

/** `/api/project/<p>/chat/<rest>` requests in a log slice. */
export function chatCalls(entries, project, method, rest) {
  const prefix = `/api/project/${encodeURIComponent(project)}/chat/`;
  return entries.filter((e) => e.method === method && e.path === `${prefix}${rest}`);
}
