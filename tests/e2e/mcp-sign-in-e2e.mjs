// MCP sign-in — real end-to-end check against a running backend (headless Chrome over raw
// CDP, no puppeteer; auth token read read-only from the PPM database and never printed).
//
// What it proves, in order:
//   1. GET /api/mcp-auth/status answers from a real Claude subprocess and lists a server
//      that needs a sign-in (PPM_E2E_MCP_SERVER, default "plugin:marketing:canva").
//   2. A real chat turn reports that server over the chat WebSocket (`mcp_status`) — the
//      provider's `init` handling and the WS forwarding, not a stub. This sends ONE short
//      message on the backend's configured account; the session is deleted afterwards.
//   3. Desktop: the chat shows the sign-in bar, and its button opens a dialog whose link
//      points at the server's authorization page, with the paste box a plain-http origin needs.
//   3b. Hiding the bar shows where to sign in instead, is remembered across a reload, and
//      the bar returns only for a server outside the hidden list (the pref is restored after).
//   4. Desktop: Settings → AI Provider lists the server under "MCP sign-in", and a
//      claude.ai connector opens the claude.ai hand-off instead of a local flow.
//   5. Desktop: the AI Resources sidebar lists it too.
//   6. Mobile (390x844): the same button opens a bottom sheet.
//   7. Closing the dialog cancels the flow, so no Claude subprocess is left waiting.
// It never completes a sign-in — that needs the user's own credentials.
//
// Run against a dev backend on 8082 with vite on 5174 already up:
//   PPM_DEV_API=http://127.0.0.1:8082 bun tests/e2e/mcp-sign-in-e2e.mjs
// Env: PPM_E2E_PROJECT (default "ppm"), PPM_E2E_WEB_PORT (5174), PPM_DB (~/.ppm/ppm.dev.db).

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";

const REPO = process.cwd();
const API = process.env.PPM_DEV_API || "http://127.0.0.1:8081";
const API_PORT = new URL(API).port || "80";
const WEB = `http://localhost:${process.env.PPM_E2E_WEB_PORT || 5174}`;
const PROJECT = process.env.PPM_E2E_PROJECT || "ppm";
// Any server that still needs a sign-in on the target backend.
const SERVER = process.env.PPM_E2E_MCP_SERVER || "plugin:marketing:canva";
/** The chat bar shows a plugin server by its last name segment (mcp-server-name.ts). */
const BAR_LABEL = SERVER.startsWith("plugin:") ? SERVER.slice(SERVER.lastIndexOf(":") + 1) : SERVER;
const CDP_PORT = Number(process.env.PPM_E2E_CDP_PORT || 9241);
const DB = (process.env.PPM_DB || join(homedir(), ".ppm", "ppm.dev.db")).replace(/^~(?=[/\\])/, homedir());
const SHOTS = process.env.PPM_E2E_SHOTS || join(REPO, "plans", "reports", "screenshots");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// Never log TOKEN's value.
const TOKEN = (() => {
  const db = new Database(DB, { readonly: true });
  try {
    const row = db.query("SELECT value FROM config WHERE key='auth'").get();
    return row ? (JSON.parse(row.value)?.token ?? "") : "";
  } finally { db.close(); }
})();
const auth = { Authorization: `Bearer ${TOKEN}` };

const results = [];
const log = (...a) => console.log(...a);
async function scenario(name, fn) {
  try { await fn(); results.push({ name, pass: true }); log(`  [PASS] ${name}`); }
  catch (e) { results.push({ name, pass: false }); log(`  [FAIL] ${name} — ${e?.message ?? e}`); }
}

async function api(path, init = {}) {
  // No keep-alive: after the minute this script spends in the browser, Bun reused a pooled
  // socket the server had already closed and the request never reached it (the server log
  // showed no sign of it) — a harness failure that read as a hung sign-in.
  const r = await fetch(`${API}${path}`, { keepalive: false, ...init, headers: { ...auth, "Content-Type": "application/json", Connection: "close", ...(init.headers ?? {}) } });
  const body = await r.json();
  if (!body.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${body.error}`);
  return body.data;
}

// ---------------------------------------------------------------- CDP driver
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const path = join(SHOTS, `mcp-sign-in-${name}.png`);
    await writeFile(path, Buffer.from(r.data, "base64"));
    log(`    screenshot -> ${path}`);
  }
}

async function waitFor(cdp, expr, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await cdp.eval(`Boolean(${expr})`)) return; } catch { /* navigating */ }
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const VISIBLE = `((el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")`;
/** A visible button (or link) whose own text is exactly `text`. */
const byText = (text, tags = "button,a") =>
  `[...document.querySelectorAll(${JSON.stringify(tags)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)} && ${VISIBLE}(el))`;
const hasText = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const dialogRoot = `(document.querySelector('[role="dialog"]') ?? document.querySelector('.popover-solid'))`;

async function click(cdp, expr, label) {
  await waitFor(cdp, expr, label);
  await cdp.eval(`(${expr}).click()`);
}

// ---------------------------------------------------------------- run
let chrome, profile, sessionId, chatWs;
try {
  await mkdir(SHOTS, { recursive: true });

  log("\n=== 1. status probe");
  await scenario(`status lists ${SERVER} as needs-auth`, async () => {
    const servers = await api(`/api/mcp-auth/status?project=${encodeURIComponent(PROJECT)}&fresh=1`);
    const s = servers.find((x) => x.name === SERVER);
    if (s?.status !== "needs-auth") throw new Error(`${SERVER} is ${s?.status ?? "missing"}`);
  });

  log("\n=== 2. chat turn reports it over the WebSocket");
  await scenario("chat WS delivers mcp_status with the server", async () => {
    const session = await api(`/api/project/${encodeURIComponent(PROJECT)}/chat/sessions`, {
      method: "POST", body: JSON.stringify({ providerId: "claude", title: "mcp sign-in e2e" }),
    });
    sessionId = session.id;
    chatWs = new WebSocket(`${API.replace(/^http/, "ws")}/ws/project/${encodeURIComponent(PROJECT)}/chat/${sessionId}?token=${encodeURIComponent(TOKEN)}`);
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no mcp_status within 120s")), 120_000);
      chatWs.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "mcp_status") { clearTimeout(timer); resolve(m.needsAuth); }
      });
    });
    await new Promise((res) => chatWs.addEventListener("open", res, { once: true }));
    chatWs.send(JSON.stringify({ type: "ready" }));
    chatWs.send(JSON.stringify({ type: "message", content: "Reply with just the word ok." }));
    const needsAuth = await got;
    if (!needsAuth.includes(SERVER)) throw new Error(`mcp_status was [${needsAuth.join(", ")}]`);
  });

  log("\n=== browser");
  profile = join(tmpdir(), `ppm-e2e-mcp-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1280,900", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; }
    catch { await Bun.sleep(500); }
  }
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  // The dev client dials the backend's WebSocket on :8081 directly; point it at API_PORT.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    localStorage.setItem("ppm-auth-token", ${JSON.stringify(TOKEN)});
    const Native = window.WebSocket;
    window.WebSocket = class extends Native { constructor(u, p) { super(String(u).replace(":8081/", ":${API_PORT}/"), p); } };
  ` });
  const chatUrl = `${WEB}/project/${encodeURIComponent(PROJECT)}/chat/claude/${sessionId}`;

  log("\n=== 3. desktop chat bar");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: chatUrl });
  // The onboarding card of a fresh dev database sits above every sheet; dismiss it once.
  await waitFor(cdp, `${byText("Maybe later")} || ${byText(BAR_LABEL, "button")}`, "app shell", 30_000).catch(() => {});
  await cdp.eval(`(${byText("Maybe later")})?.click()`);
  await scenario("chat shows the sign-in bar with the server", async () => {
    await waitFor(cdp, `${hasText("need sign-in")} || ${hasText("needs sign-in")}`, "sign-in bar", 30_000);
    await waitFor(cdp, byText(BAR_LABEL, "button"), `${SERVER} button`);
    await cdp.shot("desktop-chat-bar");
  });
  await scenario("bar button opens a dialog with the authorization link and paste box", async () => {
    await click(cdp, byText(BAR_LABEL, "button"), `${SERVER} button`);
    await waitFor(cdp, byText("Open sign-in page", "a"), "sign-in link", 30_000);
    const href = await cdp.eval(`(${byText("Open sign-in page", "a")}).href`);
    if (!/^https:\/\//.test(href) || !href.includes("redirect_uri=")) throw new Error(`unexpected link ${href.slice(0, 60)}`);
    await waitFor(cdp, `document.querySelector('input[placeholder^="http://localhost"]')`, "paste box");
    await cdp.shot("desktop-dialog");
  });
  await scenario("closing the dialog cancels the flow", async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `!${byText("Open sign-in page", "a")}`, "dialog closed");
    // A second start must be the only open flow: if the first were still open it would be
    // cancelled here and report so; a fresh start reporting "waiting" proves nothing lingers.
    const t0 = Date.now();
    const flow = await api("/api/mcp-auth/start", {
      method: "POST", body: JSON.stringify({ server: SERVER, project: PROJECT }), signal: AbortSignal.timeout(120_000),
    });
    log(`    fresh start answered in ${Date.now() - t0}ms`);
    await api(`/api/mcp-auth/flows/${flow.id}`, { method: "DELETE" }).catch(() => {});
    if (flow.status !== "waiting") throw new Error(`fresh flow was ${flow.status}`);
  });

  log("\n=== 3b. hiding the bar");
  // The hidden list is a synced UI pref on the target backend: remember it and put it back.
  const prevPrefs = await api("/api/settings/ui-prefs");
  const prevDismissed = Array.isArray(prevPrefs.mcpSignInDismissed) ? prevPrefs.mcpSignInDismissed : [];
  const putDismissed = (list) => api("/api/settings/ui-prefs", { method: "PUT", body: JSON.stringify({ mcpSignInDismissed: list }) });
  try {
    await scenario("hiding the bar explains where to sign in, and survives a reload", async () => {
      await click(cdp, `document.querySelector('button[aria-label="Hide these servers"]')`, "hide button");
      await waitFor(cdp, hasText("AI Resources → MCP"), "hint toast");
      await Bun.sleep(800); // let the toast finish sliding in before the picture
      await cdp.shot("desktop-bar-hidden-toast");
      await waitFor(cdp, `!document.querySelector('button[aria-label="Hide these servers"]')`, "bar gone");
      await Bun.sleep(800); // the pref is pushed to the server debounced
      const saved = (await api("/api/settings/ui-prefs")).mcpSignInDismissed ?? [];
      if (!saved.includes(SERVER)) throw new Error("the hidden list was not saved");
      await cdp.send("Page.navigate", { url: chatUrl });
      await waitFor(cdp, hasText("Reply with just the word ok."), "chat reloaded", 30_000);
      await Bun.sleep(3000);
      if (await cdp.eval(`Boolean(document.querySelector('button[aria-label="Hide these servers"]'))`)) {
        throw new Error("the bar came back for servers that were hidden");
      }
    });
    await scenario("the bar comes back only for a server outside the hidden list", async () => {
      const saved = (await api("/api/settings/ui-prefs")).mcpSignInDismissed ?? [];
      await putDismissed(saved.filter((n) => n !== SERVER));
      await cdp.send("Page.navigate", { url: chatUrl });
      await waitFor(cdp, byText(BAR_LABEL, "button"), `${SERVER} back in the bar`, 30_000);
      const shown = await cdp.eval(`[...document.querySelector('button[aria-label="Hide these servers"]').parentElement.querySelectorAll('button[title^="Sign in to "]')].map((b) => b.title.slice(11))`);
      if (shown.length !== 1 || shown[0] !== SERVER) throw new Error(`bar shows [${shown.join(", ")}]`);
      await cdp.shot("desktop-bar-new-server-only");
    });
  } finally {
    await putDismissed(prevDismissed).catch((e) => log(`  could not restore the hidden list: ${e.message}`));
  }

  log("\n=== 4. settings");
  await cdp.send("Page.navigate", { url: `${WEB}/project/${encodeURIComponent(PROJECT)}/settings` });
  await scenario("Settings → AI Provider lists the server under MCP sign-in", async () => {
    await click(cdp, `document.querySelector('[data-testid="settings-rail-ai-provider"]')`, "AI Provider rail item");
    await waitFor(cdp, hasText("MCP sign-in"), "MCP sign-in section");
    await waitFor(cdp, `[...document.querySelectorAll('span')].some((s) => s.textContent.trim() === ${JSON.stringify(SERVER)} && ${VISIBLE}(s))`, "server row", 30_000);
    await cdp.eval(`[...document.querySelectorAll('label')].find((l) => l.textContent.trim() === "MCP sign-in")?.scrollIntoView({ block: "start" })`);
    await cdp.shot("desktop-settings");
  });
  await scenario("a claude.ai connector hands off to claude.ai", async () => {
    const hasConnector = await cdp.eval(`Boolean(${byText("Connect", "button")})`);
    if (!hasConnector) { log("    no claude.ai connector needs a sign-in here — skipped"); return; }
    await click(cdp, byText("Connect", "button"), "Connect button");
    await waitFor(cdp, byText("Open claude.ai connectors", "a"), "claude.ai link");
    await cdp.shot("desktop-claude-ai-connector");
    await click(cdp, `[...(${dialogRoot})?.querySelectorAll("button") ?? []].find((b) => b.textContent.trim() === "Close")`, "Close");
  });
  // The settings window is persisted; left open it covers the sidebar below and would
  // also come back in the user's own session.
  await cdp.eval(`document.querySelector('button[aria-label="Close window"]')?.click()`);
  await waitFor(cdp, `!document.querySelector('[data-testid="settings-window"]')`, "settings window closed");

  log("\n=== 5. AI Resources sidebar");
  await cdp.send("Page.navigate", { url: chatUrl });
  await scenario("AI Resources lists the server under Needs sign-in", async () => {
    // The rail's items carry their name only in a hover label inside the button.
    const tab = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === "AI Resources")`;
    try {
      await waitFor(cdp, tab, "AI Resources sidebar tab", 40_000);
    } catch (e) {
      const labels = await cdp.eval(`[...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).slice(0, 40).join(" | ")`);
      throw new Error(`${e.message}; buttons: ${labels}`);
    }
    // Scoped to the sidebar: the Settings pane has the same heading.
    const inSidebar = (text) => `[...document.querySelectorAll('aside')].some((a) => ${VISIBLE}(a) && a.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))`;
    // Clicking the active tab collapses the sidebar, and the last run may have left it there.
    await Bun.sleep(1500);
    if (!(await cdp.eval(inSidebar("AI Resources")))) await cdp.eval(`(${tab}).click()`);
    await waitFor(cdp, inSidebar("Needs sign-in"), "Needs sign-in group in the sidebar", 30_000);
    await waitFor(cdp, inSidebar(SERVER), `${SERVER} in the sidebar`);
    await cdp.shot("desktop-ai-resources");
  });

  log("\n=== 6. mobile");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp.send("Page.navigate", { url: chatUrl });
  await scenario("mobile: the bar button opens a bottom sheet", async () => {
    await waitFor(cdp, byText(BAR_LABEL, "button"), `${SERVER} button`, 30_000);
    await cdp.shot("mobile-chat-bar");
    await click(cdp, byText(BAR_LABEL, "button"), `${SERVER} button`);
    await waitFor(cdp, byText("Open sign-in page", "a"), "sign-in link", 30_000);
    const inSheet = await cdp.eval(`Boolean(document.querySelector('.popover-solid')?.textContent.includes("Open sign-in page"))`);
    if (!inSheet) throw new Error("the sign-in did not open in the bottom sheet");
    await cdp.shot("mobile-sheet");
  });
} finally {
  log("\n=== cleanup");
  try { chatWs?.close(); } catch {}
  if (sessionId) await api(`/api/project/${encodeURIComponent(PROJECT)}/chat/sessions/${sessionId}`, { method: "DELETE" }).then(() => log("  deleted e2e session")).catch((e) => log(`  session delete failed: ${e.message}`));
  if (chrome) spawn("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  await Bun.sleep(500);
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
