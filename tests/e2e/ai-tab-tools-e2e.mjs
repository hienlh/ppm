// The AI's tab tools, end to end, on the production Vite bundle against a disposable API/ws
// server whose only provider is scripted (tests/e2e/fixtures/tab-tools-server.ts): each turn
// calls the real /api/tab-tools-mcp endpoint with the token the turn was handed, the server
// asks this browser over the chat socket, and the browser opens the tab beside the chat, loads
// and checks the page, and answers. Covers where the tab lands (desktop and phone), reloading a
// tab that is already open, a line in code view, the card's Open button, the setting turned off
// and a chat with no browser. Needs internet for the dashboard's CDNs. No live credentials, no
// real PPM data.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/e2e/ai-tab-tools-e2e.mjs
//
// PPM_TAB_TOOLS_WEB_DIR=<dir> reuses a scratch build (with Monaco staged under assets/monaco/vs).
// PPM_PLAYWRIGHT_CHANNEL=chrome runs the installed Chrome instead of Playwright's own build.
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-tab-tools-e2e-"));
const artifacts = process.env.PPM_TAB_TOOLS_ARTIFACTS ? resolve(process.env.PPM_TAB_TOOLS_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
await Promise.all([artifacts, ppm, home, project].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

let webDir = process.env.PPM_TAB_TOOLS_WEB_DIR;
if (!webDir) {
  webDir = join(sandbox, "web");
  await writeFile(join(artifacts, "build.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
  cpSync(resolve("node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), "Monaco is not staged in the web build");

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port), PPM_TAB_TOOLS_WEB_DIR: webDir };
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/tab-tools-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body;
}

const NAME = "tabs";
const DASHBOARD = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>Sales</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
</head><body class="bg-slate-900 p-6">
<h1 id="title" class="text-3xl font-bold text-emerald-400">${title}</h1>
<div class="w-full max-w-[600px] h-[300px]"><canvas id="chart"></canvas></div>
<script>
new Chart(document.getElementById("chart"), { type: "bar", data: { labels: ["Q1", "Q2", "Q3"],
  datasets: [{ label: "Revenue", data: [3, 5, 2], backgroundColor: "#34d399" }] }, options: { animation: false, maintainAspectRatio: false } });
window.__chartDrawn = true;
</script></body></html>`;
const BROKEN = `<!doctype html><html><head><meta charset="utf-8"><title>Broken</title>
<script src="https://esm.sh/canvas-confetti@1.9.3"></script>
<script src="missing.js"></script>
</head><body><p>Broken page</p><script>window.notDefinedFunction();</script></body></html>`;
const CONFIG = Array.from({ length: 80 }, (_, i) => i === 41 ? "export const TARGET_LINE = 42; // the line the AI points at" : `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";

await mkdir(join(project, "site"), { recursive: true });
await mkdir(join(project, "src"), { recursive: true });
await writeFile(join(project, "site/dashboard.html"), DASHBOARD("Sales"));
await writeFile(join(project, "site/broken.html"), BROKEN);
await writeFile(join(project, "src/config.ts"), CONFIG);
await writeFile(join(project, "README.md"), "# Tab tools\n\nA readme the AI opens.\n");
await command("git", ["init", "-q", project]);

const results = [];
const record = (name, detail = {}) => { results.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser, current;

/** The workspace layout as the panel store last persisted it. */
const layoutOf = (page) => page.evaluate((name) => JSON.parse(localStorage.getItem(`ppm-panels-${name}`) ?? "null"), NAME);
const panelOf = (layout, pred) => Object.values(layout.panels).find((p) => p.tabs.some(pred));
const isChat = (sessionId) => (t) => t.type === "chat" && t.metadata?.sessionId === sessionId;
const isFile = (filePath) => (t) => t.type === "editor" && t.metadata?.filePath === filePath;

let turns = 0;
/** Sends one message whose scripted turn makes `ops` calls; resolves with their records. */
async function turn(page, ops, message) {
  const before = (await api("/__tab-test/calls")).calls.length;
  await api("/__tab-test/script", { method: "POST", body: JSON.stringify({ ops }) });
  const box = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
  await box.fill(message);
  await box.press("Enter");
  const calls = await until(`${message}: answered`, async () => {
    const mine = (await api("/__tab-test/calls")).calls.slice(before);
    return mine.length === ops.length && mine.every((c) => c.text !== undefined) ? mine : null;
  }, 60000);
  turns++;
  await page.locator(`text=Turn ${turns}:`).first().waitFor({ state: "attached", timeout: 15000 });
  return calls;
}

const iframeFor = (page, file) => page.locator(`iframe[title="HTML preview"][src*="/${file}?"]:visible`);

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: NAME, path: project }) });
  const created = await api(`/api/project/${NAME}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Tab tools test" }) });
  const sessionId = created.data.id;
  const chatTab = { id: `chat-${sessionId}`, type: "chat", title: "Tab tools test", projectId: NAME, closable: true, metadata: { projectName: NAME, sessionId, providerId: "claude" } };
  const seedChatOnly = () => api(`/api/project/${NAME}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [chatTab], activeTabId: chatTab.id, tabHistory: [chatTab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });
  await seedChatOnly();

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined });
  // Init scripts run in every frame, the sandboxed previews too, where storage throws.
  const onboarding = () => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  };

  // ---------------------------------------------------------------- desktop
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(onboarding);
  const page = current = await desktop.newPage();
  const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${web}/project/${NAME}`);
  await page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 30000 });

  {
    const [call] = await turn(page, [{ tool: "open_preview", args: { path: "site/dashboard.html" } }], "show me the dashboard");
    assert.equal(call.status, 200);
    assert.equal(call.isError, false, call.text);
    assert.match(call.text, /^Opened site\/dashboard\.html in a PPM tab on the user's device and checked it at \d+x\d+ CSS px/);
    assert.ok(call.image && call.image.bytes > 1000, `a screenshot came back: ${JSON.stringify(call.image)}`);
    const frame = await (await iframeFor(page, "dashboard.html").elementHandle()).contentFrame();
    await frame.waitForFunction(() => window.__chartDrawn === true, null, { timeout: 30000 });
    const layout = await layoutOf(page);
    assert.equal(layout.grid.length, 1);
    assert.equal(layout.grid[0].length, 2, "the chat's only panel was split");
    const chatPanel = panelOf(layout, isChat(sessionId)), filePanel = panelOf(layout, isFile("site/dashboard.html"));
    assert.notEqual(chatPanel.id, filePanel.id, "the page opened beside the chat, not over it");
    assert.equal(chatPanel.activeTabId, chatTab.id, "the chat is still on screen");
    assert.equal(layout.grid[0].indexOf(filePanel.id), layout.grid[0].indexOf(chatPanel.id) + 1, "to the chat's right");
    assert.ok(await page.locator('textarea[placeholder="Ask anything..."]:visible').count(), "the composer is still visible");
    const card = page.locator("[data-tool-ref]", { hasText: "Preview" }).filter({ hasText: "dashboard.html" }).first();
    await card.waitFor();
    assert.match(await card.innerText(), /no problems|\d+ problems?/);
    await page.screenshot({ path: join(artifacts, "desktop-preview.png") });
    record("open_preview: the page opens beside the chat (one panel → split right), loads, and is checked", { ms: call.ms, image: call.image, card: await card.innerText() });
  }

  {
    const [call] = await turn(page, [{ tool: "open_preview", args: { path: "site/broken.html" } }], "show me the broken page");
    assert.equal(call.isError, false, call.text);
    assert.match(call.text, /\d+ problems? found\. Fix each one/);
    assert.match(call.text, /esm\.sh/);
    assert.match(call.text, /missing\.js/);
    assert.match(call.text, /notDefinedFunction/);
    const layout = await layoutOf(page);
    assert.equal(layout.grid[0].length, 2, "no third panel");
    assert.equal(panelOf(layout, isFile("site/broken.html")).id, panelOf(layout, isFile("site/dashboard.html")).id, "it went to the panel beside the chat");
    const card = page.locator("[data-tool-ref]", { hasText: "broken.html" }).first();
    await card.locator("text=/\\d+ problems?/").waitFor();
    record("open_preview: a broken page's CSP, missing file and script error reach the AI; the card counts them", { ms: call.ms });
  }

  {
    await writeFile(join(project, "site/dashboard.html"), DASHBOARD("Sales v2"));
    const [call] = await turn(page, [{ tool: "open_preview", args: { path: "site/dashboard.html" } }], "I fixed it, look again");
    assert.equal(call.isError, false, call.text);
    assert.match(call.text, /checked it at/);
    const layout = await layoutOf(page);
    const tabs = Object.values(layout.panels).flatMap((p) => p.tabs).filter(isFile("site/dashboard.html"));
    assert.equal(tabs.length, 1, "the open tab was reused");
    const frame = await (await iframeFor(page, "dashboard.html").elementHandle()).contentFrame();
    await frame.locator("#title", { hasText: "Sales v2" }).waitFor({ timeout: 15000 });
    record("open_preview again: the tab already open comes to the front and reloads the changed page", { ms: call.ms });
  }

  {
    const [call] = await turn(page, [{ tool: "open_file", args: { path: "src/config.ts", line: 42 } }], "where is TARGET_LINE");
    assert.equal(call.text, "Opened src/config.ts at line 42 in a PPM tab on the user's device.");
    // The editor mounts with the cursor on line 1 and reveals the line right after.
    const position = await until("cursor on line 42", () => page.evaluate(() => {
      const editor = window.monaco?.editor.getEditors().find((e) => e.getModel()?.getValue().includes("TARGET_LINE") && e.getDomNode()?.offsetParent);
      const at = editor?.getPosition();
      return at?.lineNumber === 42 ? at : null;
    }), 30000);
    assert.equal(position.lineNumber, 42);
    const layout = await layoutOf(page);
    assert.equal(layout.grid[0].length, 2);
    assert.notEqual(panelOf(layout, isFile("src/config.ts")).id, panelOf(layout, isChat(sessionId)).id);
    record("open_file with a line: the file opens beside the chat with the cursor on that line", { ms: call.ms });
  }

  {
    const [call] = await turn(page, [{ tool: "open_file", args: { path: "site/dashboard.html", line: 5 } }], "show me the dashboard's code");
    assert.equal(call.isError, false, call.text);
    const shown = await until("dashboard code visible at line 5", () => page.evaluate(() => {
      const editor = window.monaco?.editor.getEditors().find((e) => e.getModel()?.getValue().includes('id="title"') && e.getDomNode()?.offsetParent);
      return editor?.getPosition()?.lineNumber === 5 ? { fresh: editor.getModel().getValue().includes("Sales v2") } : null;
    }), 30000);
    assert.equal(shown.fresh, true, "the code shows the file as it is now, not as the tab first loaded it");
    assert.equal(await iframeFor(page, "dashboard.html").count(), 0, "the preview gave way to the code");
    record("open_file with a line on a page: the open tab switches to its code at that line");
  }

  {
    const [call] = await turn(page, [{ tool: "open_file", args: { path: "README.md" }, as: "codex" }], "open the readme");
    assert.equal(call.text, "Opened README.md in a PPM tab on the user's device.");
    const card = page.locator("[data-tool-ref]", { hasText: "Opened" }).filter({ hasText: "README.md" }).first();
    await card.waitFor();
    await page.locator("text=A readme the AI opens.").first().waitFor();
    record("a Codex-named call gets the same card; a Markdown file opens in its preview");
  }

  {
    // Close the page's tab, then bring it back from the first card.
    await page.locator('[data-tab-id="editor:site/dashboard.html"]').first().click({ button: "middle" });
    await until("dashboard tab closed", async () => !Object.values((await layoutOf(page)).panels).some((p) => p.tabs.some(isFile("site/dashboard.html"))), 5000);
    const before = (await layoutOf(page)).grid[0].length;
    await page.locator("[data-tool-ref]", { hasText: "Preview" }).filter({ hasText: "dashboard.html" }).first().getByRole("button", { name: "Open", exact: true }).click();
    await iframeFor(page, "dashboard.html").waitFor({ timeout: 15000 });
    const layout = await layoutOf(page);
    assert.equal(layout.grid[0].length, before, "it went to the existing panel beside the chat");
    assert.equal(panelOf(layout, isChat(sessionId)).activeTabId, chatTab.id, "the chat is still on screen");
    record("the card's Open button brings a closed tab back beside the chat");
  }

  {
    const [missing] = await turn(page, [{ tool: "open_preview", args: { path: "site/nope.html" } }], "show a page that is not there");
    assert.equal(missing.isError, true);
    // The absolute path, in the host's own separators: backslashes on Windows.
    assert.match(missing.text, /There is no file at .*site[\\/]nope\.html\. Write the file first/);
    record("a file that does not exist is refused before any tab opens", { text: missing.text });
  }

  {
    const res = await fetch(`${web}/api/settings/ai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tab_tools: false }) });
    assert.ok(res.ok, await res.text());
    const [call] = await turn(page, [{ tool: "open_preview", args: { path: "site/dashboard.html" } }], "setting is off now");
    assert.equal(call.handed, false, "a turn started with the setting off is not given the tools");
    assert.equal(call.isError, true);
    assert.match(call.text, /turned off "Let the AI open tabs in PPM"/);
    const back = await fetch(`${web}/api/settings/ai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tab_tools: true }) });
    assert.ok(back.ok);
    record("setting off: the next turn has no tools, and a token kept from before is refused", { text: call.text });
  }

  // Expected, and inside the previews: the broken page's own error, and Playwright's
  // service-worker blocking (`serviceWorkers: "block"`), which a sandboxed frame refuses.
  const unexpected = pageErrors.filter((e) => !/notDefinedFunction/.test(e) && !/read the 'serviceWorker' property/.test(e));
  assert.deepEqual(unexpected, [], `page errors: ${unexpected.join("\n")}`);
  await desktop.close();

  // ---------------------------------------------------------------- no browser
  /** A turn sent from a bare socket, which never answers `tab_open`; `stay` keeps it connected. */
  async function socketTurn(op, stay) {
    const before = (await api("/__tab-test/calls")).calls.length;
    await api("/__tab-test/script", { method: "POST", body: JSON.stringify({ ops: [op] }) });
    const socket = new WebSocket(`${web.replace("http", "ws")}/ws/project/${NAME}/chat/${sessionId}`);
    const seen = [];
    socket.onmessage = (m) => { try { seen.push(JSON.parse(String(m.data)).type); } catch {} };
    await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
    socket.send(JSON.stringify({ type: "message", content: stay ? "a device that never answers" : "nobody is watching", clientMessageId: crypto.randomUUID() }));
    if (!stay) { await new Promise((r) => setTimeout(r, 100)); socket.close(); }
    const [call] = await until("answered", async () => {
      const mine = (await api("/__tab-test/calls")).calls.slice(before);
      return mine.length === 1 && mine[0].text !== undefined ? mine : null;
    }, 30000);
    turns++;
    if (stay) socket.close();
    return { call, seen };
  }

  {
    // The agent calls the tool a second after the only socket has gone.
    const { call } = await socketTurn({ tool: "open_preview", args: { path: "site/dashboard.html" }, wait: 1000 }, false);
    assert.equal(call.isError, true);
    assert.match(call.text, /No PPM window has this chat open, so nothing was shown\. The file is at site\/dashboard\.html/);
    assert.ok(call.ms < 2000, `answered at once (${call.ms} ms)`);
    record("no browser has the chat open: the tool answers at once with where the file is", { ms: call.ms });
  }

  {
    // An older bundle, say: the request reaches the device, which never says the tab opened.
    const { call, seen } = await socketTurn({ tool: "open_file", args: { path: "README.md" } }, true);
    assert.ok(seen.includes("tab_open"), `the request reached the socket: ${seen.join(", ")}`);
    assert.equal(call.isError, true);
    assert.match(call.text, /did not confirm within 8 s; the tab may or may not have opened/);
    assert.ok(call.ms >= 7500 && call.ms < 12000, `gave up after the wait (${call.ms} ms)`);
    record("a device that never answers: the call gives up after 8 s and says so", { ms: call.ms });
  }

  // ---------------------------------------------------------------- phone
  {
    await seedChatOnly();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: "block" });
    await phone.addInitScript(onboarding);
    const mobile = current = await phone.newPage();
    await mobile.goto(`${web}/project/${NAME}`);
    await mobile.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 30000 });
    const [call] = await turn(mobile, [{ tool: "open_preview", args: { path: "site/dashboard.html" } }], "show it on my phone");
    assert.equal(call.isError, false, call.text);
    const [, width] = /checked it at (\d+)x(\d+)/.exec(call.text) ?? [];
    assert.ok(Number(width) <= 390, `checked at phone width (${width})`);
    await iframeFor(mobile, "dashboard.html").waitFor();
    assert.equal(await mobile.locator('textarea[placeholder="Ask anything..."]:visible').count(), 0, "the page took the screen");
    await mobile.screenshot({ path: join(artifacts, "phone-preview.png") });
    // Back to the chat through the tab switcher, where the card's Open button is a full touch target.
    await mobile.locator("nav button", { hasText: "dashboard.html" }).first().click();
    await mobile.getByText("Tab tools test", { exact: true }).last().click();
    const open = mobile.locator("[data-tool-ref]", { hasText: "Preview" }).filter({ hasText: "dashboard.html" }).last().getByRole("button", { name: "Open", exact: true });
    await open.waitFor();
    const box = await open.boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44, `Open is a 44px target (${box.width}x${box.height})`);
    await open.tap();
    await iframeFor(mobile, "dashboard.html").waitFor({ timeout: 15000 });
    record("phone: the page opens in place of the chat, is checked at phone width, and Open is a 44px target", { width: Number(width), open: box });
    await phone.close();
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  // What was on screen, and what the editors and the layout held, when it failed.
  try {
    await current?.screenshot({ path: join(artifacts, "failure.png") });
    const state = await current?.evaluate((name) => ({
      layout: JSON.parse(localStorage.getItem(`ppm-panels-${name}`) ?? "null"),
      editors: (window.monaco?.editor.getEditors() ?? []).map((e) => ({
        visible: !!e.getDomNode()?.offsetParent, head: e.getModel()?.getValue().slice(0, 80), position: e.getPosition(),
      })),
    }), NAME);
    await writeFile(join(artifacts, "failure-state.json"), JSON.stringify(state, null, 2));
  } catch { /* the page may be gone */ }
} finally {
  await browser?.close();
  backend.kill();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.length} passed; artifacts in ${artifacts}`);
}
