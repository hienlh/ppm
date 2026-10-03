import { spawn } from "node:child_process";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PPM_PLAYWRIGHT_MODULE || "playwright");
// Add a terminal selection to chat: select output with the mouse on a desktop, or with a finger in
// select mode on a phone, and add it to the open chat or a new one from the actions beside it.
// Build into a scratch directory first; this runner never writes live dist or PPM data, and HOME
// is a temp dir, so no real provider can answer.
// PPM_E2E_DIST=/path/to/scratch/dist node tests/e2e/terminal-selection-chat-e2e.mjs
const dist = process.env.PPM_E2E_DIST;
assert(dist, "Set PPM_E2E_DIST to an isolated compiled build's dist directory");
const root = await mkdtemp(join(tmpdir(), "ppm-terminal-selection-e2e-"));
const configModule = pathToFileURL(resolve(import.meta.dirname, "../../src/services/config.service.ts")).href;
const home = root + "/test-home", ppm = root + "/ppm", artifacts = process.env.PPM_TERMINAL_ARTIFACTS || root + "/artifacts";
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
// bash with an empty HOME: a zsh there would stop at its new-user wizard.
const child = spawn(resolve(dist, "ppm"), ["__serve__", String(port), "127.0.0.1"], { env: { ...env, PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; child.stdout.on("data", (d) => serverLog += d); child.stderr.on("data", (d) => serverLog += d);
async function until(label, fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw Error("Timeout: " + label); }
async function api(path, opts = {}) { const r = await fetch(origin + path, { ...opts, headers: { "Content-Type": "application/json" } }); const j = await r.json(); assert(r.ok && j.ok, JSON.stringify(j)); return j.data; }
const CHIP_TEXT = "Selected text from the terminal\n```\nMARK_A\nMARK_B\n```";
let browser; const results = [];
try {
  await until("binary healthy", async () => { const r = await fetch(origin + "/api/health"); return (await r.json()).ok; }, 60000);
  browser = await chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
  for (const [device, options] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["mobile", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
    const touch = device === "mobile";
    const name = "binary-terminal-" + device, project = root + "/project-" + device; await mkdir(project, { recursive: true }); await cmd("git", ["init", project]);
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name, path: project }) });
    const session = await api(`/api/project/${name}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "mock", title: "Terminal chat " + device }) });
    const chatTab = { id: "chat-" + device, type: "chat", title: "Terminal chat", projectId: name, closable: true, metadata: { projectName: name, sessionId: session.id, providerId: "mock" } };
    const terminalTab = { id: "terminal-" + device, type: "terminal", title: "Terminal", projectId: name, closable: true, metadata: { projectName: name } };
    await api(`/api/project/${name}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [chatTab, terminalTab], activeTabId: terminalTab.id, tabHistory: [chatTab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });
    const context = await browser.newContext({ ...options, serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
    const page = await context.newPage(), errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${origin}/project/${name}`);

    const screen = page.locator(".xterm-screen:visible").first();
    const actions = page.getByRole("group", { name: "Add the selection to chat" });
    await screen.waitFor({ timeout: 30000 });
    await page.getByText("Connected", { exact: true }).first().waitFor({ timeout: 30000 });
    // The cell, and the row the cursor is on, from the textarea xterm keeps under the cursor.
    const cursor = () => page.locator(".xterm-helper-textarea").first().evaluate((t) => {
      const height = parseFloat(t.style.height);
      return { row: Math.round(parseFloat(t.style.top) / height), cell: { width: parseFloat(t.style.width), height } };
    });
    // Two known lines at the top of the screen, the prompt on the row after them.
    const printMarks = async () => {
      await page.locator(".xterm-helper-textarea").first().focus();
      await page.keyboard.type("clear; printf 'MARK_A\\nMARK_B\\n'");
      await page.keyboard.press("Enter");
      await until("output printed", async () => (await cursor()).row === 2, 15000);
    };
    await page.waitForTimeout(1000);
    await printMarks();
    const box = await screen.boundingBox(), { cell } = await cursor();
    const from = { x: box.x + 1, y: box.y + cell.height * 0.5 }, to = { x: box.x + cell.width * 10, y: box.y + cell.height * 1.5 };
    if (!touch) {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      assert.equal(await actions.count(), 0, "no actions while the selection is still being dragged");
      await page.mouse.up();
    } else {
      // xterm has no touch selection of its own: select mode turns a drag into one.
      await page.getByRole("button", { name: "Select text" }).tap();
      await screen.evaluate((node, [from, to]) => {
        const at = (p) => new Touch({ identifier: 1, target: node, clientX: p.x, clientY: p.y });
        const send = (type, p, list) => node.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list ? [at(p)] : [], changedTouches: [at(p)] }));
        send("touchstart", from, true);
        send("touchmove", { x: (from.x + to.x) / 2, y: to.y }, true);
        send("touchmove", to, true);
        send("touchend", to, false);
      }, [from, to]);
    }
    await actions.waitFor({ timeout: 5000 });
    // Under the second row, from the column the selection ends at.
    const placed = await actions.boundingBox();
    assert(Math.abs(placed.y - (box.y + 2 * cell.height + 4)) <= 1.5, "actions sit under the selection: " + JSON.stringify({ placed, box, cell }));
    if (!touch) assert(Math.abs(placed.x - (box.x + 10 * cell.width)) <= 1.5, "actions start where the selection ends: " + JSON.stringify({ placed, box, cell }));
    for (const title of ["Add to current chat", "Add to new chat"]) {
      const size = await actions.getByRole("button", { name: title }).boundingBox();
      if (touch) assert(size.height >= 44, title + " is a finger-sized target: " + size.height);
      assert(size.x >= 0 && size.x + size.width <= options.viewport.width + 0.5, title + " fits the screen: " + JSON.stringify(size));
    }
    await page.screenshot({ path: artifacts + `/${device}-1-actions.png` });

    const composer = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
    const chip = page.getByText("Terminal selection", { exact: true }).filter({ visible: true }).last();
    if (!touch) {
      // Into the open chat, as a chip that goes with the user's own message.
      await actions.getByRole("button", { name: "Add to current chat" }).click();
      await chip.waitFor({ timeout: 10000 });
      assert.equal(await actions.count(), 0, "the actions go once they have been used");
      await page.screenshot({ path: artifacts + `/${device}-2-current-chat.png` });
      await composer.fill("What printed this?"); await composer.press("Enter");
      const sent = await until("selection delivered", async () => (await api(`/api/project/${name}/chat/sessions/${session.id}/messages?providerId=mock`)).messages.find((m) => m.role === "user" && m.content.includes(CHIP_TEXT)), 15000);
      assert(sent.content.includes("What printed this?"), sent.content);
      results.push({ device, step: "current chat", sessionId: session.id });
      // Back to the terminal for the other action.
      await page.locator(`[data-tab-id="${terminalTab.id}"]:visible`).first().click();
      await screen.waitFor();
      await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
      await actions.waitFor({ timeout: 5000 });
    }
    // A new chat, with the selection waiting in its composer and nothing sent.
    const newChat = actions.getByRole("button", { name: "Add to new chat" });
    if (touch) await newChat.tap(); else await newChat.click();
    await chip.waitFor({ timeout: 10000 });
    assert.equal(await composer.inputValue(), "");
    // Not the chat the first selection went to: that one shows the message sent with it.
    if (!touch) assert.equal(await page.getByText("What printed this?").filter({ visible: true }).count(), 0, "the selection went to the open chat instead of a new one");
    assert.equal(await actions.count(), 0, "the actions go once they have been used");
    await page.screenshot({ path: artifacts + `/${device}-3-new-chat.png` });
    results.push({ device, step: "new chat" });

    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, origin, artifacts, results }, null, 2));
} catch (error) {
  process.exitCode = 1; console.error(error);
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) await p.screenshot({ path: artifacts + "/failure.png", fullPage: true }).catch(() => {});
} finally {
  await writeFile(artifacts + "/results.json", JSON.stringify({ origin, artifacts, results, passed: !process.exitCode }, null, 2));
  await writeFile(artifacts + "/server.log", serverLog); await browser?.close(); child.kill("SIGTERM");
}
