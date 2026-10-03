import { spawn } from "node:child_process";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PPM_PLAYWRIGHT_MODULE || "playwright");
// "Fix with AI" and "Explain with AI" on an editor problem: in the bulb's menu, from the problem's
// hover, beside the selection actions, and from the sparkle bulb of a problem with no other fix. Build into a scratch directory first; this runner
// never writes live dist or PPM data, and HOME is a temp dir, so no real provider can answer.
// PPM_E2E_DIST=/path/to/scratch/dist node tests/e2e/editor-fix-with-ai-e2e.mjs
const dist = process.env.PPM_E2E_DIST;
assert(dist, "Set PPM_E2E_DIST to an isolated compiled build's dist directory");
const root = await mkdtemp(join(tmpdir(), "ppm-fix-with-ai-e2e-"));
const configModule = pathToFileURL(resolve(import.meta.dirname, "../../src/services/config.service.ts")).href;
const home = root + "/test-home", ppm = root + "/ppm", artifacts = process.env.PPM_FIX_ARTIFACTS || root + "/artifacts";
await Promise.all([home, ppm, artifacts].map((p) => mkdir(p, { recursive: true })));
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home + "/.claude", CODEX_HOME: home + "/.codex" };
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY", "PPM_ALLOW_PROD_DB"]) delete env[key];
async function cmd(exe, args) {
  const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
  child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => output += d);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, output); return output;
}
await writeFile(root + "/setup-test.ts", `import { configService } from ${JSON.stringify(configModule)};
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("ai", { ...configService.get("ai"), default_provider: "mock", share_provider_context: false,
providers: { mock: { type: "mock", permission_mode: "bypassPermissions" } } });`);
await cmd("bun", [root + "/setup-test.ts"]);
const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r)); const port = listener.address().port; await new Promise((r) => listener.close(r));
const origin = `http://127.0.0.1:${port}`; console.log("Isolated binary browser test", origin);
const child = spawn(resolve(dist, "ppm"), ["__serve__", String(port), "127.0.0.1"], { env: { ...env, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; child.stdout.on("data", (d) => serverLog += d); child.stderr.on("data", (d) => serverLog += d);
async function until(label, fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw Error("Timeout: " + label); }
async function api(path, opts = {}) { const r = await fetch(origin + path, { ...opts, headers: { "Content-Type": "application/json" } }); const j = await r.json(); assert(r.ok && j.ok, JSON.stringify(j)); return j.data; }
const TS_REQUEST = "Fix this problem in example.ts:\n- 2:13 error: Cannot find name 'answe'. Did you mean 'answer'? typescript(2552)";
const PY_EXPLAIN = "Explain this problem in notes.py, without changing any files:\n- 1:7 error: \"answe\" is not defined Pyright(reportUndefinedVariable)";
let browser; const steps = [];
try {
  await until("binary healthy", async () => { const r = await fetch(origin + "/api/health"); return (await r.json()).ok; }, 60000);
  browser = await chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
  const name = "binary-fix-with-ai", project = root + "/project"; await mkdir(project, { recursive: true }); await cmd("git", ["init", project]);
  await writeFile(project + "/example.ts", "const answer = 42;\nconsole.log(answe);\n\nfunction demo() {\n    return answer;\n}\n");
  await writeFile(project + "/notes.py", "print(answe)\n");
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name, path: project }) });
  // No chat open: every request has to arrive in a chat of its own.
  const tab = (file) => ({ id: "editor-" + file, type: "editor", title: file, projectId: name, closable: true, metadata: { projectName: name, filePath: file } });
  await api(`/api/project/${name}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [tab("example.ts"), tab("notes.py")], activeTabId: "editor-example.ts", tabHistory: [] } }, grid: [["main"]], focusedPanelId: "main" } }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
  const page = await context.newPage(), errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  // The registry hides the mock from the providers a new chat may pick (`registry.list()`), so a
  // chat opened from the UI would stop at "mock is not available". Offer it, and nothing else:
  // the server, its WebSocket and the mock provider behind it are the real ones.
  const offerMock = (providersOf) => async (route) => {
    const response = await route.fetch(), json = await response.json();
    providersOf(json).push({ id: "mock", name: "Mock" });
    await route.fulfill({ response, json });
  };
  await page.route("**/chat/prepare", offerMock((json) => json.data.providers));
  await page.route("**/chat/providers", offerMock((json) => json.data));
  await page.goto(`${origin}/project/${name}`);

  // A language server's error, as `use-lsp` publishes it, on the visible editor showing `text`.
  const showEditor = async (file, text, marker) => {
    await page.locator(`[data-tab-id="editor-${file}"]:visible`).first().click();
    // Visible is not enough: a tab shown again keeps its editor at 5 x 5 px until Monaco's next
    // layout, and a point aimed at a column before then lands in the gutter.
    await until("editor for " + file, () => page.evaluate((text) => window.monaco?.editor.getEditors().some((e) => e.getModel()?.getValue().includes(text) && e.getDomNode()?.offsetParent && e.getDomNode().getBoundingClientRect().width > 100), text));
    await page.evaluate(([text, marker]) => {
      const editor = window.__fixEditor = window.monaco.editor.getEditors().find((e) => e.getModel()?.getValue().includes(text) && e.getDomNode()?.offsetParent);
      window.monaco.editor.setModelMarkers(editor.getModel(), "e2e", [{ ...marker, severity: window.monaco.MarkerSeverity.Error }]);
      editor.focus();
    }, [text, marker]);
  };
  const tsMarker = { startLineNumber: 2, startColumn: 13, endLineNumber: 2, endColumn: 18, message: "Cannot find name 'answe'. Did you mean 'answer'?", source: "typescript", code: "2552" };
  const pyMarker = { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12, message: "\"answe\" is not defined", source: "Pyright", code: "reportUndefinedVariable" };
  const bulb = page.locator('.monaco-editor .lightBulbWidget:visible, .monaco-editor .glyph-margin-widgets [class*="codicon-gutter-lightbulb"]:visible').first();
  // The first automatic code-action request after an editor mounts can come back with nothing
  // while Monaco's TypeScript worker starts (13 MB), and nothing asks again until the cursor
  // moves — so step off and back on until the bulb shows, as a user's next keystroke would.
  const cursorTo = async (cursor) => {
    await until("bulb at " + JSON.stringify(cursor), async () => {
      await page.evaluate((cursor) => {
        const editor = window.__fixEditor;
        if ("startLineNumber" in cursor) { editor.setPosition({ lineNumber: cursor.startLineNumber, column: 1 }); editor.setSelection(cursor); }
        else { editor.setPosition({ lineNumber: cursor.lineNumber, column: cursor.column - 1 }); editor.setPosition(cursor); }
      }, cursor);
      await page.waitForTimeout(800);
      return bulb.isVisible();
    }, 45000);
  };
  // Right of centre, as the selection e2e explains: the gutter is hit-tested by x.
  const clickBulb = async () => { const box = await bulb.boundingBox(); await bulb.click({ position: { x: box.width / 2 + 3, y: box.height / 2 } }); };
  const choose = async (title) => {
    const option = page.locator(".action-widget:visible").getByText(title, { exact: true }), rect = await option.boundingBox();
    // Monaco blocks the opening click until the pointer moves into its menu.
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, { steps: 5 });
    await option.click();
  };
  const seen = new Set();
  // The request lands in a chat it opened, as the user's own message, sent once, and the mock answers it.
  const expectSentFromNewChat = async (label, request, code) => {
    const session = await until(label + ": request sent from a new chat", async () => {
      for (const s of (await api(`/api/project/${name}/chat/sessions?providerId=mock`)).sessions) {
        if (seen.has(s.id)) continue;
        const history = await api(`/api/project/${name}/chat/sessions/${s.id}/messages?providerId=mock`);
        if (history.messages.find((m) => m.role === "user")?.content.startsWith(request)) return { id: s.id, history };
      }
    }, 15000);
    seen.add(session.id);
    const user = session.history.messages.filter((m) => m.role === "user");
    assert.equal(user.length, 1, "the request was sent once");
    assert(user[0].content.includes(code), user[0].content);
    await until(label + ": mock replied", async () => (await api(`/api/project/${name}/chat/sessions/${session.id}/messages?providerId=mock`)).messages.some((m) => m.role === "assistant"));
    // On screen too: the chat it opened is the active tab, showing the request.
    await page.locator("text=" + request.split("\n")[0] + " >> visible=true").first().waitFor({ timeout: 5000 });
    steps.push({ step: label, sessionId: session.id });
  };
  const TS_CODE = "Code from example.ts:1-5\n```typescript\nconst answer = 42;\nconsole.log(answe);";

  // 1. The cursor on a TypeScript error. With no language server running, Monaco's own TypeScript
  //    worker has a quick fix for it as well, so the bulb is the mixed lightbulb-sparkle and opens
  //    Monaco's menu: the server's fix first, the two AI ones after it, each with a sparkle.
  await showEditor("example.ts", "answe);", tsMarker);
  await cursorTo({ lineNumber: 2, column: 15 });
  const mixed = await bulb.getAttribute("class");
  assert(mixed.includes("sparkle") && !mixed.includes("filled"), "a bulb with AI and other fixes is the lightbulb-sparkle: " + mixed);
  await clickBulb();
  const menu = page.locator(".action-widget:visible");
  await menu.getByText("Fix with AI", { exact: true }).waitFor({ timeout: 2000 });
  assert.deepEqual(await menu.locator(".monaco-list-row.action .title").allTextContents(), ["Change spelling to 'answer'", "Fix with AI", "Explain with AI"]);
  for (const title of ["Fix with AI", "Explain with AI"]) assert.equal(await menu.locator(".monaco-list-row.action").filter({ hasText: title }).locator(".codicon-sparkle").count(), 1, title + " carries Monaco's sparkle");
  await page.screenshot({ path: artifacts + "/1-menu-on-error.png" });
  await choose("Fix with AI");
  await expectSentFromNewChat("menu", TS_REQUEST, TS_CODE);
  await page.screenshot({ path: artifacts + "/2-new-chat.png" });

  // 2. The problem's hover: Monaco puts the first AI action beside "Quick Fix...", one click away,
  //    and only that one — which is why Fix is offered before Explain.
  await showEditor("example.ts", "answe);", tsMarker);
  const at = await page.evaluate(() => {
    const editor = window.__fixEditor, pos = editor.getScrolledVisiblePosition({ lineNumber: 2, column: 15 }), rect = editor.getDomNode().getBoundingClientRect();
    return { x: rect.left + pos.left, y: rect.top + pos.top + pos.height / 2 };
  });
  await page.mouse.move(at.x - 20, at.y); await page.mouse.move(at.x, at.y, { steps: 4 });
  const hover = page.locator(".monaco-hover:visible").filter({ hasText: "Cannot find name 'answe'" }).first();
  await hover.waitFor({ timeout: 5000 });
  const fixInHover = hover.getByText("Fix with AI", { exact: true });
  await fixInHover.waitFor({ timeout: 5000 });
  assert(await hover.getByText("Quick Fix...", { exact: false }).count() >= 1, "the hover keeps Monaco's own Quick Fix link");
  assert.equal(await hover.getByText("Explain with AI", { exact: true }).count(), 0, "the hover offers one AI action, Fix");
  await page.screenshot({ path: artifacts + "/3-hover.png" });
  await fixInHover.click();
  await expectSentFromNewChat("hover", TS_REQUEST, TS_CODE);

  // 3. A selection over the error: the AI actions sit with the selection's own.
  await showEditor("example.ts", "answe);", tsMarker);
  await cursorTo({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 20 });
  await clickBulb();
  await menu.getByText("Fix with AI", { exact: true }).waitFor({ timeout: 2000 });
  const titles = await menu.locator(".monaco-list-row.action .title").allTextContents();
  for (const title of ["Fix with AI", "Explain with AI", "Add to current chat", "Add to new chat"]) assert(titles.includes(title), JSON.stringify(titles));
  await page.screenshot({ path: artifacts + "/4-menu-with-selection.png" });
  await page.keyboard.press("Escape");

  // 4. A Python error with no other fix: every fix on offer is AI, so Monaco draws the filled
  //    sparkle. It would run a lone one from the bulb; with two, the bulb opens the menu.
  await showEditor("notes.py", "print(answe)", pyMarker);
  await cursorTo({ lineNumber: 1, column: 9 });
  const aiOnly = await bulb.getAttribute("class");
  assert(aiOnly.includes("sparkle-filled"), "a bulb with only AI fixes is the filled sparkle: " + aiOnly);
  await page.screenshot({ path: artifacts + "/5-ai-only-bulb.png" });
  await clickBulb();
  await menu.getByText("Explain with AI", { exact: true }).waitFor({ timeout: 2000 });
  assert.deepEqual(await menu.locator(".monaco-list-row.action .title").allTextContents(), ["Fix with AI", "Explain with AI"]);
  await page.screenshot({ path: artifacts + "/6-ai-only-menu.png" });
  await choose("Explain with AI");
  await expectSentFromNewChat("explain", PY_EXPLAIN, "Code from notes.py:1-2\n```python\nprint(answe)");

  assert.deepEqual(errors, []);
  await context.close();
  console.log(JSON.stringify({ passed: true, origin, artifacts, steps }, null, 2));
} catch (error) {
  process.exitCode = 1; console.error(error);
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) await p.screenshot({ path: artifacts + "/failure.png", fullPage: true }).catch(() => {});
} finally {
  await writeFile(artifacts + "/results.json", JSON.stringify({ origin, artifacts, steps, passed: !process.exitCode }, null, 2));
  await writeFile(artifacts + "/server.log", serverLog); await browser?.close(); child.kill("SIGTERM");
}
