// The PPM Assistant, end to end, on the production Vite bundle against a disposable API/ws server
// whose only providers are scripted (tests/e2e/fixtures/assistant-server.ts): each turn calls the
// real /api/assistant-mcp endpoint with the token the turn was handed, the server asks this
// browser over the chat socket, and approval cards are answered by clicking them. Runs every
// scenario on a desktop and a phone viewport: separate sessions, the chatting device's screen,
// navigation across projects, reading tabs, a real SQLite database behind approval cards, cards
// that survive a reload / give way to a new message / time out / do not survive a server restart,
// sending into another chat, a Codex-style session rename, external images and WebFetch.
// No live credentials, no real PPM data.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/e2e/assistant-e2e.mjs
//
// Needs Node 22.5+ (global WebSocket, node:sqlite). PPM_ASSISTANT_WEB_DIR=<dir> reuses a scratch
// build (with Monaco staged under assets/monaco/vs); PPM_PLAYWRIGHT_CHANNEL=chrome runs the
// installed Chrome; PPM_ASSISTANT_SCREENSHOTS=<dir> keeps the step screenshots there;
// PPM_ASSISTANT_E2E_ONLY=s1,s5 runs a subset while developing.
//
// A check the product fails because of a reported, not-yet-fixed bug prints BLOCKED-BY-BUG (see
// KNOWN_BUGS) instead of failing the run; any other outcome of that check fails as usual.
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-assistant-e2e-"));
const artifacts = process.env.PPM_ASSISTANT_ARTIFACTS ? resolve(process.env.PPM_ASSISTANT_ARTIFACTS) : join(sandbox, "artifacts");
const shots = process.env.PPM_ASSISTANT_SCREENSHOTS ? resolve(process.env.PPM_ASSISTANT_SCREENSHOTS) : join(artifacts, "screenshots");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta"), outside = join(sandbox, "outside");
await Promise.all([artifacts, shots, ppm, home, alpha, beta, outside, join(alpha, "data")].map((p) => mkdir(p, { recursive: true })));
const ONLY = new Set((process.env.PPM_ASSISTANT_E2E_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const wanted = (id) => ONLY.size === 0 || ONLY.has(id);

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

let webDir = process.env.PPM_ASSISTANT_WEB_DIR;
if (!webDir) {
  webDir = join(sandbox, "web");
  await writeFile(join(artifacts, "build.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
  cpSync(resolve("node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), "Monaco is not staged in the web build");

// ------------------------------------------------------------------ fixtures on disk
await writeFile(join(alpha, "README.md"), "# Alpha\n\nThe alpha project.\n");
await writeFile(join(alpha, "notes.txt"), "saved line one\n");
await writeFile(join(beta, "README.md"), "# Beta\n\nBETA-README-CONTENT\n");
const OUTSIDE_FILE = join(outside, "private-notes.txt");
await writeFile(OUTSIDE_FILE, "OUTSIDE-FILE-CONTENT\n");
for (const dir of [alpha, beta]) await command("git", ["init", "-q", dir]);
const SHOP_DB = join(alpha, "data", "shop.sqlite");
{
  const db = new DatabaseSync(SHOP_DB);
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, qty INTEGER NOT NULL)");
  db.exec("INSERT INTO orders (id, item, qty) VALUES (1, 'apples', 3), (2, 'pears', 5), (3, 'plums', 8)");
  db.close();
}
/** Reads the shop database directly, outside PPM: what really changed. */
function shop(sql) {
  const db = new DatabaseSync(SHOP_DB, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
const qty = (id) => shop(`SELECT qty FROM orders WHERE id = ${id}`)[0].qty;
const userVersion = () => shop("PRAGMA user_version")[0].user_version;

// An image host the agent's markdown points at; anything reaching it is a leak.
const imageHits = [];
const imageServer = createHttpServer((req, res) => { imageHits.push(req.url); res.writeHead(204).end(); });
await new Promise((r) => imageServer.listen(0, "127.0.0.1", r));
const IMAGE_URL = `http://127.0.0.1:${imageServer.address().port}/x.png`;

// ------------------------------------------------------------------ fixture server
const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const APPROVAL_TIMEOUT_MS = 60_000;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
  PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
  PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: String(APPROVAL_TIMEOUT_MS),
};
delete env.PPM_ALLOW_PROD_DB;
delete env.PPM_ASSISTANT_FIXTURE_RESUME;
let serverLog = "";
let backend;
function startBackend(resume) {
  const child = spawn("bun", ["tests/e2e/fixtures/assistant-server.ts"], {
    env: resume ? { ...env, PPM_ASSISTANT_FIXTURE_RESUME: "1" } : env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  });
  serverLog += `\n===== fixture pid ${child.pid}${resume ? " (resumed)" : ""} =====\n`;
  child.stdout.on("data", (s) => serverLog += s); child.stderr.on("data", (s) => serverLog += s);
  return child;
}
/** Ends the fixture through its own exit route (its shells go with it), then by PID if it lingers. */
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((r) => backend.once("exit", r));
  await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
  const timer = setTimeout(() => backend.kill(), 5000);
  await exited;
  clearTimeout(timer);
}

async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 500)})`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ scripted turns
const fixtureState = () => api("/__assistant-test/calls");
/** Queues the ops the next turn of `sessionId` (or, without one, the next new session) runs. */
const script = (label, ops, sessionId) => api("/__assistant-test/script", { method: "POST", body: JSON.stringify({ label, ops, ...(sessionId ? { sessionId } : {}) }) });
const recordsOf = async (label) => (await fixtureState()).calls.filter((c) => c.label === label);
const turnOf = async (label) => (await fixtureState()).turns.find((t) => t.label === label);
/** Every call of the turn, once each has its answer. */
async function answered(label, count, timeout = 30000) {
  return until(`${label}: ${count} call(s) answered`, async () => {
    const mine = await recordsOf(label);
    return mine.length === count && mine.every((c) => c.done) ? mine : null;
  }, timeout);
}
const parse = (record) => JSON.parse(record.text);

const results = [];
const record = (id, dev, name, detail = {}) => {
  results.push({ id, viewport: dev, name, passed: true, ...detail });
  console.log(`PASS [${dev}] ${id} ${name}`);
};
const failures = [];
/**
 * Checks the product fails today because of a reported bug that is not fixed in this branch.
 * Only the exact symptom is recorded as blocked; anything else fails, and once the bug is fixed
 * the check's ordinary assertions run and pass, so the marker cannot outlive the bug.
 */
const blocked = [];
const KNOWN_BUGS = {};
function blockedBy(bug, id, viewport, observed) {
  blocked.push({ id, viewport, bug, description: KNOWN_BUGS[bug], observed });
  console.log(`BLOCKED-BY-BUG [${viewport}] ${id} ${bug}: ${observed.split("\n")[0].slice(0, 160)}`);
}

// ------------------------------------------------------------------ browser helpers
const COMPOSER = ['Ask anything...', 'Follow-up...', 'Follow-up or Stop...'].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
/**
 * Where a device's chat is: the Assistant's body (its window on a desktop, its tab on a phone),
 * or — for the device showing an ordinary project chat — the page. Scoped, because a project's
 * own chat can be on screen beside the Assistant with a composer and cards of its own.
 */
const ASSISTANT_BODY = '[class*="@container/assistant"]';
const chatRoot = (dev) => (dev.plain ? dev.page.locator("body") : dev.page.locator(`${ASSISTANT_BODY}:visible`).first());
const composer = (dev) => chatRoot(dev).locator(COMPOSER).first();
const card = (dev) => chatRoot(dev).locator("[data-approval-request]:visible").last();

async function shot(dev, name) {
  const path = join(shots, `${dev.name}-${name}.png`);
  await dev.page.screenshot({ path });
  dev.shots.push(path);
}

/**
 * Brings the Assistant back on a phone, where a tab it opened takes the whole screen: through the
 * bottom bar's current-tab button and the tab switcher, as a user would.
 */
async function showAssistant(dev) {
  if (dev.kind !== "phone" || await composer(dev).isVisible()) return;
  await dev.page.locator("nav button.border-primary").first().click();
  await dev.page.getByText("PPM Assistant", { exact: true }).last().click();
  await composer(dev).waitFor({ timeout: 15000 });
}

/** Types `message` into the Assistant's composer and sends it, the next turn running `ops`. */
async function send(dev, label, ops, message, sessionId) {
  await script(label, ops, sessionId);
  await showAssistant(dev);
  const box = composer(dev);
  await box.waitFor({ timeout: 30000 });
  await box.fill(message);
  await box.press("Enter");
  await until(`${label}: turn started`, () => turnOf(label), 30000);
}
/** The turn's closing words in the chat, on screen or not (a phone may be showing a tab the turn opened). */
async function turnDone(dev, label) {
  const root = dev.plain ? dev.page.locator("body") : dev.page.locator(ASSISTANT_BODY);
  await root.getByText(`Turn "${label}" done.`).first().waitFor({ state: "attached", timeout: 30000 });
}
/** A whole turn: sent, every call answered, the closing words on screen. */
async function turn(dev, label, ops, message, sessionId) {
  await send(dev, label, ops, message, sessionId);
  const calls = await answered(label, ops.filter((o) => !("text" in o)).length);
  await turnDone(dev, label);
  return calls;
}

async function openAssistant(dev, project = "alpha") {
  await dev.page.goto(`${web}/project/${project}/assistant`);
  await composer(dev).waitFor({ timeout: 30000 });
}
/** The Assistant's session list: a sidebar on a wide window, a drawer (sheet on a phone) otherwise. */
async function sessionsPane(dev) {
  if (await dev.page.locator('aside:visible button[aria-label^="New Assistant session"]').count()) return dev.page.locator("aside:visible");
  await dev.page.locator('button[aria-label="Assistant sessions"]:visible').click();
  await dev.page.locator('button[aria-label^="New Assistant session"]:visible').first().waitFor();
  return dev.page;
}
/** Starts a new Assistant session on `provider`; its first message creates it. */
async function newSession(dev, provider = "Claude") {
  const pane = await sessionsPane(dev);
  await pane.locator(`button[aria-label="New Assistant session with ${provider}"]:visible`).click();
  await composer(dev).waitFor({ timeout: 30000 });
  await until("new session's chat is empty", async () => (await chatRoot(dev).getByText(/^Turn ".*" done\.$/).count()) === 0, 10000);
}
async function openSessionFromList(dev, title) {
  const pane = await sessionsPane(dev);
  await pane.locator('ul[aria-label="Assistant sessions"] button:visible', { hasText: title }).first().click();
  await composer(dev).waitFor({ timeout: 30000 });
}

async function waitCard(dev, timeout = 30000) {
  const c = card(dev);
  await c.waitFor({ timeout });
  return { requestId: await c.getAttribute("data-approval-request"), text: await c.innerText() };
}
async function answerCard(dev, verb) {
  const button = card(dev).getByRole("button", { name: verb, exact: true });
  const box = await button.boundingBox();
  if (dev.name === "phone") assert.ok(box.height >= 44, `${verb} is a 44px touch target on a phone (${box.height})`);
  await button.click();
}
const assistantUiFrames = (dev) => dev.frames.filter((f) => f.type === "assistant_ui");
/** A terminal's output as text: escape sequences (colours, cursor moves, titles) taken out. */
const terminalText = (dev, from = 0) => dev.terminalOut.slice(from)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][0-9A-B]|\x1b[=>]/g, "");

let browser;
const devices = {};
async function openDevice(name, kind, opts = {}) {
  const context = await browser.newContext(kind === "phone"
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" }
    : { viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  });
  const dev = { name, kind, context, page: null, frames: [], errors: [], shots: [], terminalOut: "", plain: opts.plain === true };
  await newPage(dev);
  devices[name] = dev;
  return dev;
}
/** A fresh page for the device, watched for page errors and for what its chat sockets receive. */
async function newPage(dev) {
  const page = await dev.context.newPage();
  page.on("pageerror", (e) => dev.errors.push(`${e}\n${e.stack ?? ""}`));
  page.on("websocket", (ws) => {
    // A terminal's output, as its socket delivered it: readable whatever renders the terminal.
    if (ws.url().includes("/terminal/")) ws.on("framereceived", (f) => { dev.terminalOut += String(f.payload); });
    if (!ws.url().includes("/chat/")) return;
    ws.on("framereceived", (f) => { try { const data = JSON.parse(String(f.payload)); dev.frames.push({ type: data.type, at: Date.now(), data }); } catch { /* not JSON */ } });
  });
  dev.page = page;
}
const layoutOf = (dev, project) => dev.page.evaluate((p) => JSON.parse(localStorage.getItem(`ppm-panels-${p}`) ?? "null"), project);
const tabsOf = (layout) => Object.values(layout?.panels ?? {}).flatMap((p) => p.tabs);

/**
 * Answers an approval from a bare chat socket, as a device holding an old card would; resolves
 * with the server's first answer to it and everything the socket heard.
 */
async function answerOverSocket(sessionId, requestId, approved) {
  const socket = new WebSocket(`${web.replace("http", "ws")}/ws/project/__assistant__/chat/${sessionId}?providerId=claude`);
  const seen = [];
  try {
    await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
    const answer = new Promise((done) => {
      socket.onmessage = (m) => {
        const data = JSON.parse(String(m.data));
        seen.push(data);
        if (data.requestId === requestId) done(data);
      };
    });
    socket.send(JSON.stringify({ type: "approval_response", requestId, approved }));
    return { answer: await Promise.race([answer, sleep(10000).then(() => ({ type: "no answer" }))]), seen };
  } finally {
    socket.close();
  }
}

// ------------------------------------------------------------------ scenarios
const WRITE = (n) => `UPDATE orders SET qty = ${n} WHERE id = 1`;
const DB = () => ({ connectionId: "shop" });

/** 1. Two Assistant sessions, kept out of the projects' chats; the Assistant project has no terminal. */
async function s1(dev) {
  await openAssistant(dev);
  await newSession(dev);
  const [list] = await turn(dev, `s1-first-${dev.name}`, [{ mcp: "projects_list" }], `First Assistant session (${dev.name})`);
  const projects = parse(list).projects.map((p) => p.name);
  assert.deepEqual(projects.sort(), ["alpha", "beta"], "projects_list names the user's projects only");
  await newSession(dev);
  await turn(dev, `s1-second-${dev.name}`, [], `Second Assistant session (${dev.name})`);
  const first = await turnOf(`s1-first-${dev.name}`), second = await turnOf(`s1-second-${dev.name}`);
  assert.notEqual(first.sessionId, second.sessionId, "two sessions");
  assert.ok(first.assistant && second.assistant, "both ran as Assistant sessions");
  const listed = (await api("/api/project/__assistant__/chat/sessions")).data.sessions.map((s) => s.id);
  assert.ok(listed.includes(first.sessionId) && listed.includes(second.sessionId), "both are the Assistant's");
  for (const project of ["alpha", "beta"]) {
    const ids = (await api(`/api/project/${project}/chat/sessions`)).data.sessions.map((s) => s.id);
    assert.ok(!ids.includes(first.sessionId) && !ids.includes(second.sessionId), `neither is in ${project}'s chats`);
  }
  const pane = await sessionsPane(dev);
  for (const title of [`First Assistant session (${dev.name})`, `Second Assistant session (${dev.name})`]) {
    await pane.locator('ul[aria-label="Assistant sessions"] button:visible', { hasText: title }).first().waitFor();
  }
  await shot(dev, "s1-two-sessions");
  if (dev.kind === "phone") await dev.page.keyboard.press("Escape");

  // A terminal in the Assistant's project is refused at the socket, and the agent cannot ask for one.
  const socket = new WebSocket(`${web.replace("http", "ws")}/ws/project/__assistant__/terminal/new`);
  const shellAnswer = await new Promise((done, fail) => { socket.onmessage = (m) => done(String(m.data)); socket.onerror = fail; setTimeout(() => fail(new Error("no answer")), 10000); });
  socket.close();
  assert.deepEqual(JSON.parse(shellAnswer), { type: "error", message: "Project not found: __assistant__" });
  const [refused] = await turn(dev, `s1-terminal-${dev.name}`, [{ mcp: "ui_open_tab", args: { project: "__assistant__", kind: "terminal" } }], "Open a terminal in your own folder", second.sessionId);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /The Assistant's own chats are not a project/);
  record("s1", dev.name, "two Assistant sessions, listed only under the Assistant; __assistant__ gets no terminal", { sessions: [first.sessionId, second.sessionId] });
}

/** 2. The screen read is the sending device's; when it has gone, nothing else is touched. */
async function s2(desk, phone) {
  await openAssistant(desk);
  await newSession(desk);
  const title = "Read my screen from two devices";
  const [d] = await turn(desk, "s2-desktop", [{ mcp: "ui_get_state" }], title);
  const sessionId = (await turnOf("s2-desktop")).sessionId;
  assert.equal(parse(d).state.layout, "desktop");
  assert.equal(parse(d).state.currentProject, "alpha");

  await openAssistant(phone);
  await openSessionFromList(phone, title);
  const deskFramesBefore = assistantUiFrames(desk).length;
  /** What the desktop shows: where it is, its panels and their tabs, and its windows' tabs (a save time aside). */
  const deskScreen = () => desk.page.evaluate(() => {
    const { updatedAt: _saved, ...layout } = JSON.parse(localStorage.getItem("ppm-panels-alpha") ?? "{}");
    const windows = Object.values(JSON.parse(localStorage.getItem("ppm-window-panels") ?? "{}"))
      .map((p) => ({ id: p.id, active: p.activeTabId, tabs: p.tabs.map((t) => t.id) }));
    return { path: location.pathname, layout, windows };
  });
  const screenBefore = await deskScreen();
  const [p] = await turn(phone, "s2-phone", [{ mcp: "ui_get_state" }], "And now from my phone", sessionId);
  assert.equal(parse(p).state.layout, "phone", "the phone, which sent the message, answered");
  assert.equal(assistantUiFrames(desk).length, deskFramesBefore, "the desktop was not asked");
  await shot(phone, "s2-same-session");

  // The phone sends, then goes before the agent reads the screen.
  try {
    await send(phone, "s2-gone", [{ mcp: "ui_get_state", wait: 4000 }], "Read it again in a moment", sessionId);
  } finally {
    await phone.page.close();
  }
  try {
    const [gone] = await answered("s2-gone", 1, 30000);
    assert.equal(gone.isError, true);
    assert.match(gone.text, /^no-device: No device is chatting in this Assistant session right now/);
    assert.equal(assistantUiFrames(desk).length, deskFramesBefore, "the desktop still was not asked");
    await turnDone(desk, "s2-gone");
    assert.deepEqual(await deskScreen(), screenBefore, "the desktop's screen did not change");
    await shot(desk, "s2-no-device");
    record("s2", "desktop+phone", "ui_get_state reads the sending device's layout; with that device gone it answers no-device and the other is untouched", { ms: gone.ms });
  } finally {
    // The phone page is gone: the phone pass opens a new one.
    await newPage(phone);
  }
}

/** 3. Opening a tab in another project switches to it and reports where the screen was. */
async function s3(dev) {
  await openAssistant(dev);
  await newSession(dev);
  const [opened] = await turn(dev, `s3-open-${dev.name}`, [{ mcp: "ui_open_tab", args: { project: "beta", kind: "file", target: { path: "README.md" } } }], "Show me beta's readme");
  const sessionId = (await turnOf(`s3-open-${dev.name}`)).sessionId;
  const nav = parse(opened);
  assert.equal(nav.previousProject, "alpha");
  assert.equal(nav.project, "beta");
  assert.equal(nav.tabId, "editor:README.md");
  await until("beta's readme is in beta's layout", async () => tabsOf(await layoutOf(dev, "beta")).some((t) => t.type === "editor" && t.metadata?.filePath === "README.md"));
  await dev.page.getByText("BETA-README-CONTENT").first().waitFor({ timeout: 30000 });
  await shot(dev, "s3-beta-readme");
  if (dev.kind === "phone") {
    // The file took the screen; the Assistant came along to beta and opens again from the tab switcher.
    assert.equal(await composer(dev).count(), 0, "the file took the phone's screen");
    await showAssistant(dev);
  } else {
    assert.ok(await composer(dev).isVisible(), "the Assistant's window stayed on screen");
  }
  const [state] = await turn(dev, `s3-after-${dev.name}`, [{ mcp: "ui_get_state" }], "Where am I now?", sessionId);
  assert.equal(parse(state).state.currentProject, "beta");
  await shot(dev, "s3-assistant-after-switch");
  record("s3", dev.name, "ui_open_tab into another project shows the tab and reports previousProject; the Assistant is still there after the switch", { nav });
}

/** 4. Reading a terminal and an editor's unsaved text; a file tab names its path, and reading a file outside every project is the provider's Read, which asks. */
async function s4(dev) {
  await openAssistant(dev);
  await newSession(dev);
  const [term] = await turn(dev, `s4-terminal-${dev.name}`, [{ mcp: "ui_open_tab", args: { project: "alpha", kind: "terminal" } }], "Open a terminal in alpha");
  const sessionId = (await turnOf(`s4-terminal-${dev.name}`)).sessionId;
  const terminalTab = parse(term).tabId;
  assert.match(terminalTab, /^terminal/);
  const marker = `PPM-TERMINAL-MARK-${dev.name.toUpperCase()}`;
  await dev.page.locator(".xterm-helper-textarea").first().waitFor({ state: "attached", timeout: 30000 });
  // The shell has started once its prompt, which names the project folder, has arrived.
  const outputBefore = dev.terminalOut.length;
  await until("terminal prompt", () => /alpha[>$]/.test(terminalText(dev, outputBefore)), 30000);
  await dev.page.locator(".xterm-helper-textarea").first().focus();
  await dev.page.keyboard.type(`echo ${marker}`);
  await dev.page.keyboard.press("Enter");
  try {
    // The typed command and the line it prints.
    await until("terminal echoed", () => (terminalText(dev, outputBefore).match(new RegExp(marker, "g")) ?? []).length >= 2, 15000);
  } catch (e) {
    await writeFile(join(artifacts, `terminal-${dev.name}.txt`), JSON.stringify(dev.terminalOut.slice(outputBefore)));
    throw e;
  }
  const [readTerm] = await turn(dev, `s4-read-terminal-${dev.name}`, [{ mcp: "ui_read_tab", args: { tabId: terminalTab } }], "What does the terminal say?", sessionId);
  assert.equal(readTerm.isError, false, readTerm.text);
  assert.match(parse(readTerm).source, /^terminal output/);
  assert.ok(parse(readTerm).text.includes(marker), "the terminal's output came back");

  const [file] = await turn(dev, `s4-editor-${dev.name}`, [{ mcp: "ui_open_tab", args: { project: "alpha", kind: "file", target: { path: "notes.txt" } } }], "Open notes.txt", sessionId);
  const editorTab = parse(file).tabId;
  const unsaved = `UNSAVED-EDIT-${dev.name.toUpperCase()}`;
  await until("notes.txt in an editor", () => dev.page.evaluate(() => (window.monaco?.editor.getEditors() ?? []).some((e) => e.getModel()?.getValue().includes("saved line one"))), 30000);
  await dev.page.evaluate(() => window.monaco.editor.getEditors().find((e) => e.getModel()?.getValue().includes("saved line one")).focus());
  await dev.page.keyboard.press("Control+End");
  await dev.page.keyboard.type(unsaved);
  const [readEditor] = await turn(dev, `s4-read-editor-${dev.name}`, [{ mcp: "ui_read_tab", args: { tabId: editorTab } }], "What does notes.txt say now?", sessionId);
  assert.equal(readEditor.isError, false, readEditor.text);
  assert.match(parse(readEditor).source, /^the editor's unsaved text/);
  assert.equal(parse(readEditor).unsavedChanges, true);
  assert.equal(parse(readEditor).path, join(alpha, "notes.txt"), "the tab names its file by its absolute path");
  assert.ok(parse(readEditor).text.includes(unsaved), "the unsaved text came back");
  assert.ok(!readFileSync(join(alpha, "notes.txt"), "utf8").includes(unsaved), "nothing was saved");

  const [outsideTab] = await turn(dev, `s4-outside-${dev.name}`, [{ mcp: "ui_open_tab", args: { project: "alpha", kind: "file", target: { path: OUTSIDE_FILE } } }], "Open my private notes", sessionId);
  const outsideTabId = parse(outsideTab).tabId;
  // The tab answers with where its file is, without a card and without its content.
  const [named] = await turn(dev, `s4-name-outside-${dev.name}`, [{ mcp: "ui_read_tab", args: { tabId: outsideTabId } }], "Where are my private notes?", sessionId);
  assert.equal(named.isError, false, named.text);
  assert.equal(parse(named).path, OUTSIDE_FILE);
  assert.equal(parse(named).project, null);
  assert.ok(!named.text.includes("OUTSIDE-FILE-CONTENT"), "the file itself is not read by ui_read_tab");
  assert.equal(await card(dev).count(), 0, "naming the file asks nothing");
  // Reading it is the provider's own Read, which the Assistant policy puts to the user.
  for (const verb of ["Deny", "Allow"]) {
    const label = `s4-read-outside-${verb}-${dev.name}`;
    await send(dev, label, [{ builtin: "Read", input: { file_path: parse(named).path } }], `Read the private notes (${verb})`, sessionId);
    const shown = await waitCard(dev);
    assert.match(shown.text, /Tool Approval Required/);
    assert.ok(shown.text.includes("private-notes.txt"), "the card names the file");
    if (verb === "Deny") await shot(dev, "s4-outside-file-card");
    await answerCard(dev, verb);
    const [read] = await answered(label, 1);
    assert.equal(read.decision, "ask", "a Read outside every registered project asks");
    assert.equal(read.approved, verb === "Allow");
    assert.equal(read.isError, verb === "Deny");
    await turnDone(dev, label);
  }
  record("s4", dev.name, "ui_read_tab reads a terminal and an editor's unsaved text and names a file tab's path; reading a file outside every project is the provider's Read, which shows a card (Deny: not run, Allow: run)");
}

/** 5. A read runs unasked; a write and an unprovable statement ask; Deny changes nothing; Allow after 15 s writes and is audited. */
async function s5(dev, connId) {
  await openAssistant(dev);
  await newSession(dev);
  const [list, read] = await turn(dev, `s5-read-${dev.name}`, [
    { mcp: "db_list_connections" },
    { mcp: "db_query", args: { ...DB(), sql: "SELECT item, qty FROM orders ORDER BY id" } },
  ], "What is in the shop database?");
  const sessionId = (await turnOf(`s5-read-${dev.name}`)).sessionId;
  assert.ok(parse(list).connections.some((c) => c.name === "shop" && c.type === "sqlite"));
  assert.equal(read.isError, false, read.text);
  assert.deepEqual(parse(read).rows.map((r) => r[0]), ["apples", "pears", "plums"]);
  assert.equal(await card(dev).count(), 0, "a proven read shows no card");
  const before = qty(1), versionBefore = userVersion();

  for (const [label, sql, check] of [
    [`s5-write-deny-${dev.name}`, WRITE(11), () => assert.equal(qty(1), before, "the row did not change")],
    // SQLite's counterpart of pg_terminate_backend: a statement the safety check cannot prove reads.
    [`s5-pragma-deny-${dev.name}`, "PRAGMA user_version = 7", () => assert.equal(userVersion(), versionBefore, "user_version did not change")],
  ]) {
    await send(dev, label, [{ mcp: "db_query", args: { ...DB(), sql } }], `Run ${sql}`, sessionId);
    const shown = await waitCard(dev);
    assert.match(shown.text, /PPM Assistant asks for approval/);
    assert.match(shown.text, /Run 1 SQL statement that may change data on "shop"/);
    assert.ok(shown.text.includes(sql), "the card shows the SQL in full");
    if (label.startsWith("s5-write")) await shot(dev, "s5-write-card");
    await answerCard(dev, "Deny");
    const [denied] = await answered(label, 1);
    assert.equal(denied.isError, true);
    assert.match(denied.text, /^Not run: .*The user declined\./s);
    check();
    await turnDone(dev, label);
  }

  const label = `s5-write-allow-${dev.name}`;
  await send(dev, label, [{ mcp: "db_query", args: { ...DB(), sql: WRITE(42) } }], "Set apples to 42", sessionId);
  await waitCard(dev);
  await sleep(16_000);
  assert.equal(qty(1), before, "nothing ran while the card waited");
  await answerCard(dev, "Allow");
  const [allowed] = await answered(label, 1);
  assert.equal(allowed.isError, false, allowed.text);
  assert.equal(parse(allowed).rowsAffected, 1);
  assert.deepEqual(parse(allowed).columns, ["id", "item", "qty"]);
  assert.deepEqual(parse(allowed).oldRows, [[1, "apples", before]], "the write answers with the row as it was");
  assert.equal(parse(allowed).oldRowsCapped, false);
  assert.ok(allowed.ms >= 15_000, `the call stayed open past 15 s (${allowed.ms} ms)`);
  assert.equal(qty(1), 42, "the row changed");
  await turnDone(dev, label);
  const history = (await api(`/api/db/connections/${connId}/history`)).data.items;
  const agentRows = history.filter((h) => h.byAgent);
  assert.ok(agentRows.some((h) => h.sql === WRITE(42) && h.status === "ok"), "the approved write is audited as the agent's");
  assert.ok(agentRows.some((h) => h.sql === WRITE(11) && h.status === "blocked"), "the declined write is audited as blocked");
  assert.ok(agentRows.some((h) => h.sql === "PRAGMA user_version = 7" && h.status === "blocked"), "the declined PRAGMA is audited as blocked");
  await shot(dev, "s5-after-allow");
  record("s5", dev.name, "db_query: a read runs unasked; a write and PRAGMA ask, Deny leaves the data, Allow after >15 s writes, answers with the old row and is audited", { allowMs: allowed.ms });
}

/** 6. A waiting card: survives a reload, gives way to a new message, times out, and does not survive a restart. */
async function s6(dev) {
  await openAssistant(dev);
  await newSession(dev);
  await turn(dev, `s6-start-${dev.name}`, [], "Let's change the shop data");
  const sessionId = (await turnOf(`s6-start-${dev.name}`)).sessionId;
  const start = qty(1);

  // Reload: the same card comes back, and answering it still works.
  {
    const label = `s6-reload-${dev.name}`;
    await send(dev, label, [{ mcp: "db_query", args: { ...DB(), sql: WRITE(61) } }], "Set apples to 61", sessionId);
    const before = await waitCard(dev);
    await dev.page.reload();
    const after = await waitCard(dev);
    assert.equal(after.requestId, before.requestId, "the same card is back after the reload");
    await shot(dev, "s6-card-after-reload");
    await answerCard(dev, "Deny");
    const [r] = await answered(label, 1);
    assert.match(r.text, /The user declined/);
    assert.equal(qty(1), start);
  }

  // A new message while the card waits: the request is withdrawn and the next turn runs at once.
  {
    const label = `s6-supersede-${dev.name}`;
    await send(dev, label, [{ mcp: "db_query", args: { ...DB(), sql: WRITE(62) } }], "Set apples to 62", sessionId);
    await waitCard(dev);
    const typed = Date.now();
    await script(`s6-next-${dev.name}`, [], sessionId);
    await composer(dev).fill("Never mind, leave it");
    await composer(dev).press("Enter");
    const [r] = await answered(label, 1);
    assert.equal(r.isError, true);
    assert.match(r.text, /The user sent another message instead of answering; not run\./);
    await turnDone(dev, `s6-next-${dev.name}`);
    assert.ok(Date.now() - typed < 10_000, `the next turn ran at once (${Date.now() - typed} ms)`);
    assert.equal(await card(dev).count(), 0, "the card went");
    assert.equal(qty(1), start);
  }

  // Nobody answers: it times out, and nothing runs.
  {
    const label = `s6-timeout-${dev.name}`;
    await api("/__assistant-test/approval-timeout", { method: "POST", body: JSON.stringify({ ms: 3000 }) });
    try {
      await send(dev, label, [{ mcp: "db_query", args: { ...DB(), sql: WRITE(63) } }], "Set apples to 63", sessionId);
      await waitCard(dev);
      const [r] = await answered(label, 1, 20000);
      assert.equal(r.isError, true);
      assert.match(r.text, /did not answer within 3 seconds/);
      await until("the timed-out card went", async () => (await card(dev).count()) === 0, 10000);
      assert.equal(qty(1), start);
    } finally {
      await api("/__assistant-test/approval-timeout", { method: "POST", body: JSON.stringify({ ms: APPROVAL_TIMEOUT_MS }) });
    }
  }

  // The server restarts under a waiting card: whatever the device still shows, nothing runs.
  {
    const label = `s6-restart-${dev.name}`;
    await send(dev, label, [{ mcp: "db_query", args: { ...DB(), sql: WRITE(64) } }], "Set apples to 64", sessionId);
    const waiting = await waitCard(dev);
    const restartedAt = Date.now();
    await stopBackend();
    backend = startBackend(true);
    await until("fixture back", async () => (await fetch(`${web}/api/health`)).ok, 60000);
    // The chat socket reconnects by itself, and the restarted server says nothing is waiting.
    const fresh = await until("chat socket reconnected", () => dev.frames.find((f) => f.type === "session_state" && f.at > restartedAt), 60000);
    assert.equal(fresh.data.pendingApproval, null, "the restarted server holds no card");
    await until("reconnect overlay gone", async () => (await dev.page.getByText("Reconnecting...").count()) === 0, 30000);
    let outcome = "card gone";
    if (await card(dev).count()) {
      assert.equal(await card(dev).getAttribute("data-approval-request"), waiting.requestId);
      await answerCard(dev, "Allow");
      await dev.page.getByText(/no longer valid .*Nothing was run\./).first().waitFor({ timeout: 10000 });
      await until("the stale card went", async () => (await card(dev).count()) === 0, 10000);
      outcome = "stale card answered: no longer valid";
    }
    // A device still holding the old card (one that has not reconnected yet) answers it: the
    // server says the request is no longer valid and runs nothing.
    const stale = await answerOverSocket(sessionId, waiting.requestId, true);
    assert.equal(stale.answer.type, "approval_stale");
    assert.equal(stale.answer.message, "This approval request is no longer valid — it was already answered, timed out or withdrawn, or PPM restarted. Nothing was run.");
    assert.ok(!stale.seen.some((m) => m.type === "approval_resolved"), "nothing announced the card as answered");
    await sleep(1000);
    assert.equal(qty(1), start, "nothing ran");
    assert.equal((await recordsOf(label)).length, 0, "the restarted server ran no such call");
    assert.ok(!dev.frames.some((f) => f.type === "approval_resolved" && f.data.requestId === waiting.requestId && f.data.approved), "no card reported as approved");
    await shot(dev, "s6-after-restart");
    // The session carries on with the restarted server.
    const [state] = await turn(dev, `s6-after-restart-${dev.name}`, [{ mcp: "ui_get_state" }], "Are you still there?", sessionId);
    assert.equal(state.isError, false, state.text);
    record("s6", dev.name, "a card survives a reload, gives way to a new message, times out unrun, and after a restart nothing runs", { restart: outcome });
  }
}

/** 7. Sending into a project's chat: the card names its mode, the message arrives there; a chat waiting on its own card is refused. */
async function s7(dev, target) {
  await openAssistant(dev);
  await newSession(dev);
  const text = `Hello from the Assistant on the ${dev.name}`;
  await script(`t7-recv-${dev.name}`, [], target.sessionId);
  await send(dev, `s7-send-${dev.name}`, [{ mcp: "chat_send_message", args: { project: "alpha", sessionId: target.sessionId, providerId: "claude", text } }], "Tell the target chat hello");
  const sessionId = (await turnOf(`s7-send-${dev.name}`)).sessionId;
  const shown = await waitCard(dev);
  assert.match(shown.text, /Send a message to a Claude chat in "alpha"; it runs there as if you sent it/);
  assert.match(shown.text, /Accept edits — file edits run without asking/);
  // Where the mode came from: saved for the chat, or the run it would join, whichever holds now.
  assert.match(shown.text, /Mode from\n(the mode saved for this chat|the mode its running session started in)/);
  assert.ok(shown.text.includes(text), "the card shows the message in full");
  await shot(dev, "s7-send-card");
  await answerCard(dev, "Allow");
  const [sent] = await answered(`s7-send-${dev.name}`, 1);
  assert.equal(sent.isError, false, sent.text);
  assert.equal(parse(sent).sent, true);
  assert.equal(parse(sent).permissionMode, "acceptEdits");
  await chatRoot(target.dev).getByText(text).first().waitFor({ timeout: 15000 });
  await turnDone(target.dev, `t7-recv-${dev.name}`);
  await shot(target.dev, `s7-target-received-from-${dev.name}`);

  // The target chat asks its user something; a message from the Assistant now is refused.
  await script(`t7-ask-${dev.name}`, [{ builtin: "Bash", input: { command: "echo waiting" } }], target.sessionId);
  await composer(target.dev).fill("Run a command for me");
  await composer(target.dev).press("Enter");
  const targetCard = await waitCard(target.dev);
  assert.match(targetCard.text, /Tool Approval Required/);
  const [refused] = await turn(dev, `s7-refused-${dev.name}`, [{ mcp: "chat_send_message", args: { project: "alpha", sessionId: target.sessionId, text: "Another hello" } }], "Say hello again", sessionId);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /That chat is waiting for the user to answer an approval card/);
  assert.equal(await card(dev).count(), 0, "no card was shown for it");
  await answerCard(target.dev, "Deny");
  const [bash] = await answered(`t7-ask-${dev.name}`, 1);
  assert.equal(bash.approved, false);
  record("s7", dev.name, "chat_send_message: the card names the target's mode, the message arrives in the other browser; a chat waiting on a card is refused");
}

/** 8. A session the provider renames on its first turn stays an Assistant session; tools and cards work. */
async function s8(dev) {
  await openAssistant(dev);
  await newSession(dev, "Codex");
  const created = dev.page.waitForResponse((r) => r.request().method() === "POST" && /\/project\/__assistant__\/chat\/sessions$/.test(r.url()));
  const label = `s8-codex-${dev.name}`;
  const before = qty(2);
  // As Codex does: the rename comes as the thread starts, the agent's tool calls a moment later.
  await send(dev, label, [{ mcp: "ui_get_state", wait: 2000 }, { mcp: "db_query", args: { ...DB(), sql: "UPDATE orders SET qty = qty + 1 WHERE id = 2" } }], "Codex: read my screen and bump pears");
  const draftId = (await (await created).json()).data.id;
  await waitCard(dev);
  await shot(dev, "s8-card-after-rename");
  await answerCard(dev, "Allow");
  const [state, write] = await answered(label, 2);
  await turnDone(dev, label);
  const t = await turnOf(label);
  assert.notEqual(t.sessionId, draftId, "the session was renamed on its first turn");
  assert.equal(t.provider, "codex");
  assert.equal(t.assistant, true, "the renamed session still ran as an Assistant session");
  assert.equal(write.isError, false, write.text);
  assert.equal(qty(2), before + 1);
  // The screen read in the renamed session's first turn: the tab's reopened socket is the chatting device.
  assert.equal(state.isError, false, state.text);
  assert.equal(parse(state).state.layout, dev.kind);
  const listed = (await api("/api/project/__assistant__/chat/sessions")).data.sessions.map((s) => s.id);
  assert.ok(listed.includes(t.sessionId), "listed under the Assistant by its new id");
  assert.ok(!(await api("/api/project/alpha/chat/sessions")).data.sessions.some((s) => s.id === t.sessionId || s.id === draftId));
  const [again] = await turn(dev, `s8-again-${dev.name}`, [{ mcp: "ui_get_state" }], "And once more", t.sessionId);
  assert.equal(again.isError, false, again.text);
  assert.equal((await turnOf(`s8-again-${dev.name}`)).assistant, true);
  record("s8", dev.name, "session_migrated on the first turn: still an Assistant session; its UI tools, card and write work in that turn and the next", { draftId, threadId: t.sessionId });
}

/** 9. An image the agent writes is a link, and nothing fetches it. */
async function s9(dev) {
  await openAssistant(dev);
  await newSession(dev);
  const hitsBefore = imageHits.length;
  await turn(dev, `s9-image-${dev.name}`, [{ text: `Here is the chart: ![sales chart](${IMAGE_URL})` }], "Show me the chart");
  const link = dev.page.locator(`a[title="Not loaded automatically: ${IMAGE_URL}"]`).first();
  await link.waitFor();
  assert.equal(await link.innerText(), "Image: sales chart");
  assert.equal(await dev.page.locator(`img[src="${IMAGE_URL}"]`).count(), 0);
  await dev.page.reload();
  await dev.page.locator(`a[title="Not loaded automatically: ${IMAGE_URL}"]`).first().waitFor({ timeout: 30000 });
  await sleep(1000);
  assert.equal(imageHits.length, hitsBefore, `the image host got no request (${imageHits.slice(hitsBefore).join(", ")})`);
  await shot(dev, "s9-image-as-link");
  record("s9", dev.name, "an image in the Assistant's answer shows as a link and the host receives no request, live or after a reload");
}

/** 10. WebFetch in an Assistant session asks; a Read inside a project does not. */
async function s10(dev) {
  await openAssistant(dev);
  await newSession(dev);
  const label = `s10-webfetch-${dev.name}`;
  await send(dev, label, [
    { builtin: "Read", input: { file_path: join(alpha, "README.md") } },
    { builtin: "WebFetch", input: { url: "https://example.com/", prompt: "Summarise it" } },
  ], "Read the readme, then fetch example.com");
  const shown = await waitCard(dev);
  assert.match(shown.text, /Tool Approval Required/);
  assert.match(shown.text, /WebFetch/);
  assert.ok(shown.text.includes("https://example.com/"));
  await shot(dev, "s10-webfetch-card");
  await answerCard(dev, "Deny");
  const [read, fetchCall] = await answered(label, 2);
  await turnDone(dev, label);
  assert.equal(read.decision, "allow", "a Read inside a registered project runs unasked");
  assert.equal(fetchCall.decision, "ask", "WebFetch asks in an Assistant session");
  assert.equal(fetchCall.approved, false);
  record("s10", dev.name, "WebFetch in an Assistant session shows a card (the real Claude policy decides); a Read inside a project does not");
}

// ------------------------------------------------------------------ run
try {
  backend = startBackend(false);
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  for (const [name, path] of [["alpha", alpha], ["beta", beta]]) {
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name, path }) });
  }
  const conn = (await api("/api/db/connections", { method: "POST", body: JSON.stringify({ type: "sqlite", name: "shop", connectionConfig: { type: "sqlite", path: SHOP_DB }, readonly: false, aiAccess: true }) })).data;

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined });

  const desk = await openDevice("desktop", "desktop");
  const phone = await openDevice("phone", "phone");

  // The ordinary chat the Assistant sends into, open in a browser of its own. It ran one turn in
  // "acceptEdits", so a message joins that running session in that mode.
  let target;
  if (wanted("s7")) {
    const sessionId = (await api("/api/project/alpha/chat/sessions", { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Target chat" }) })).data.id;
    await script("t7-seed", [], sessionId);
    const socket = new WebSocket(`${web.replace("http", "ws")}/ws/project/alpha/chat/${sessionId}?providerId=claude`);
    await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
    socket.send(JSON.stringify({ type: "message", content: "Seed the target chat", permissionMode: "acceptEdits", clientMessageId: crypto.randomUUID() }));
    await until("target seeded", async () => (await fixtureState()).turns.some((t) => t.label === "t7-seed"));
    await sleep(500);
    socket.close();
    const other = await openDevice("other-desktop", "desktop", { plain: true });
    await other.page.goto(`${web}/project/alpha?openChat=${sessionId}`);
    await other.page.getByText("Seed the target chat").first().waitFor({ timeout: 30000 });
    target = { sessionId, dev: other };
  }

  const run = async (id, dev, fn) => {
    if (!wanted(id)) return;
    try { await fn(); } catch (error) {
      failures.push({ id, viewport: dev, error: String(error.stack ?? error) });
      console.error(`FAIL [${dev}] ${id} ${error.stack ?? error}`);
      const d = devices[dev] ?? devices.desktop;
      try { await d.page.screenshot({ path: join(artifacts, `failure-${dev}-${id}.png`) }); } catch { /* page gone */ }
    }
  };
  for (const dev of [desk, phone]) {
    await run("s1", dev.name, () => s1(dev));
    if (dev === desk) await run("s2", "desktop+phone", () => s2(desk, phone));
    await run("s3", dev.name, () => s3(dev));
    await run("s4", dev.name, () => s4(dev));
    await run("s5", dev.name, () => s5(dev, conn.id));
    await run("s6", dev.name, () => s6(dev));
    await run("s7", dev.name, () => s7(dev, target));
    await run("s8", dev.name, () => s8(dev));
    await run("s9", dev.name, () => s9(dev));
    await run("s10", dev.name, () => s10(dev));
  }
  // Expected: Playwright's service-worker blocking, which a sandboxed frame refuses.
  for (const dev of Object.values(devices)) {
    const unexpected = dev.errors.filter((e) => !/read the 'serviceWorker' property/.test(e));
    if (unexpected.length) failures.push({ id: "page-errors", viewport: dev.name, error: unexpected.join("\n") });
  }
} catch (error) {
  failures.push({ id: "setup", viewport: "-", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await browser?.close().catch(() => {});
  await stopBackend().catch(() => backend?.kill());
  imageServer.close();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ results, failures, blocked, screenshots: Object.values(devices).flatMap((d) => d.shots) }, null, 2));
  for (const f of failures) console.error(`FAILED [${f.viewport}] ${f.id}: ${f.error.split("\n")[0]}`);
  for (const b of blocked) console.log(`BLOCKED-BY-BUG [${b.viewport}] ${b.id} ${b.bug}`);
  console.log(`${results.length} passed, ${failures.length} failed, ${blocked.length} blocked by known product bugs; artifacts in ${artifacts}`);
  if (failures.length) process.exitCode = 1;
}
