// The bar that says why a turn stopped, on the production Vite bundle against a disposable
// server whose only provider ends every turn the way a real Max Turns stop does. Checks that the
// bar appears, survives a reload (the transcript has no record of the stop), continues the turn,
// and is gone once a turn finishes. No live credentials.
// PPM_PLAYWRIGHT_MODULE may point at an external Playwright index.mjs.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-turn-stop-e2e-"));
const artifacts = process.env.PPM_TURN_STOP_ARTIFACTS ? resolve(process.env.PPM_TURN_STOP_ARTIFACTS) : join(sandbox, "artifacts");
const webDir = join(sandbox, "web"), ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
await Promise.all([artifacts, webDir, ppm, home, project].map((p) => mkdir(p, { recursive: true })));
async function command(cmd, args, env = process.env) {
  const child = spawn(cmd, args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} exited ${code}: ${log}`);
  return log;
}
const buildLog = await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]);
await writeFile(join(artifacts, "build.log"), buildLog);
const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port), PPM_TURN_STOP_WEB_DIR: webDir };
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/turn-stop-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);
async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`Timeout: ${label}`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body;
}
const CONTINUE = "Continue from where you left off.";
const results = []; let browser;
try {
  await until("API ready", async () => { try { return (await fetch(web + "/api/health")).ok; } catch { return false; } });
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
  console.log("Serving production build", webDir);
  for (const [device, viewport] of [["desktop", { width: 1366, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    console.log("Checking", device);
    const projectName = `turn-stop-${device}`;
    const projectDir = join(project, device); await mkdir(projectDir); await command("git", ["init", projectDir]);
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, path: projectDir }) });
    if (device === "mobile") {
      const created = await api(`/api/project/${projectName}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Mobile stop test" }) });
      const sessionId = created.data.id;
      const tab = { id: `stop-${sessionId}`, type: "chat", title: "Mobile stop test", projectId: projectName, closable: true, metadata: { projectName, sessionId, providerId: "claude" } };
      await api(`/api/project/${projectName}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { "stop-panel": { id: "stop-panel", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["stop-panel"]], focusedPanelId: "stop-panel" } }) });
    }
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${web}/project/${projectName}`);
    if (device === "desktop") await page.locator("button:visible").filter({ hasText: /^AI Chat$/ }).first().click();
    const box = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
    const bar = page.locator("[data-testid=turn-stop-bar]:visible");
    await box.waitFor({ state: "visible" });
    await box.fill(`build everything ${device}`); await box.press("Enter");

    // 1. The turn ends on Max Turns: the bar says so, with the setting that caused it.
    await bar.waitFor({ state: "visible" });
    const live = await bar.innerText();
    assert(live.includes("Stopped after 500 steps (Max Turns)"), live);
    assert(live.includes("Settings → AI Provider"), live);
    await page.screenshot({ path: join(artifacts, `${device}-1-stopped.png`) });

    // 2. A reload rebuilds the chat from the transcript, which has no record of the stop.
    await page.reload(); await box.waitFor({ state: "visible" });
    await bar.waitFor({ state: "visible" });
    assert((await bar.innerText()).includes("Stopped after 500 steps (Max Turns)"));
    await page.screenshot({ path: join(artifacts, `${device}-2-after-reload.png`) });
    const continueButton = bar.getByRole("button", { name: "Continue" });
    const buttonBox = await continueButton.boundingBox(), barBox = await bar.boundingBox();
    assert(barBox.y + barBox.height <= viewport.height, "bar is below the fold");
    if (device === "mobile") assert(buttonBox.height >= 44, `Continue is ${buttonBox.height}px tall`);
    // innerText reads through a line clamp, so ask the layout whether the detail was cut short.
    const clipped = await bar.locator("p").evaluateAll((ps) => ps.filter((p) => p.scrollHeight > p.clientHeight + 1).map((p) => p.textContent));
    assert.deepEqual(clipped, [], "the bar cuts its own text short");

    // 3. Continue sends PPM's own retry wording, and the bar goes with the new turn.
    await continueButton.click();
    const resumed = await until("provider got the continue message", async () =>
      (await api("/__turn-stop-test/turns")).turns.find((t) => t.message.startsWith(CONTINUE)));
    await page.getByText("Resumed and finished.").first().waitFor();
    await bar.waitFor({ state: "hidden" });
    await page.screenshot({ path: join(artifacts, `${device}-3-continued.png`) });

    // 4. Once a turn has finished, a reload shows no bar.
    await page.reload(); await box.waitFor({ state: "visible" });
    await page.getByText("Resumed and finished.").first().waitFor();
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await bar.count(), 0, "bar came back after a finished turn");
    await page.screenshot({ path: join(artifacts, `${device}-4-finished-reload.png`) });

    const scripts = await page.locator("script[src]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("src")));
    assert(scripts.some((src) => src.startsWith("/assets/index-"))); assert(!scripts.some((src) => src.includes("@vite/client")));
    assert.deepEqual(errors, []);
    results.push({ device, passed: true, barText: live, continueHeight: buttonBox.height, continueMessage: resumed.message });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, artifacts, results }, null, 2));
} catch (error) {
  results.push({ passed: false, error: error.stack }); console.error(error); process.exitCode = 1;
  for (const context of browser?.contexts() || []) for (const page of context.pages()) await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ artifacts, webDir, results }, null, 2));
  await writeFile(join(artifacts, "server.log"), serverLog);
  await browser?.close(); backend.kill();
}
