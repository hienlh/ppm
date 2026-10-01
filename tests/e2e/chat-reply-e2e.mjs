// Runs the production Vite bundle on a disposable real API/ws server. No live credentials.
// PPM_PLAYWRIGHT_MODULE may point at an external Playwright index.mjs.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-reply-e2e-"));
const artifacts = process.env.PPM_REPLY_ARTIFACTS ? resolve(process.env.PPM_REPLY_ARTIFACTS) : join(sandbox, "artifacts");
const webDir = join(sandbox, "web"), ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
await Promise.all([artifacts, webDir, ppm, home, project].map((p) => mkdir(p, { recursive: true })));
async function command(cmd, args, env = process.env) {
  const child = spawn(cmd, args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} exited ${code}: ${log}`);
  return log;
}
await command("git", ["init", project]);
const buildLog = await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]);
await writeFile(join(artifacts, "build.log"), buildLog);
const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port), PPM_REPLY_WEB_DIR: webDir };
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/chat-reply-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
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
const results = []; let browser;
try {
  await until("API ready", async () => { try { return (await fetch(web + "/api/health")).ok; } catch { return false; } });
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
  console.log("Serving production build", webDir);
  for (const [device, viewport] of [["desktop", { width: 1366, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    console.log("Checking", device);
    const projectName = `reply-${device}`;
    const projectDir = join(project, device); await mkdir(projectDir); await command("git", ["init", projectDir]);
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, path: projectDir }) });
    if (device === "mobile") {
      const created = await api(`/api/project/${projectName}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Mobile reply test" }) });
      const sessionId = created.data.id;
      const tab = { id: `reply-${sessionId}`, type: "chat", title: "Mobile reply test", projectId: projectName, closable: true, metadata: { projectName, sessionId, providerId: "claude" } };
      await api(`/api/project/${projectName}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { "reply-panel": { id: "reply-panel", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["reply-panel"]], focusedPanelId: "reply-panel" } }) });
    }
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${web}/project/${projectName}`);
    if (device === "desktop") await page.locator("button:visible").filter({ hasText: /^AI Chat$/ }).first().click();
    const box = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
    await box.waitFor({ state: "visible" });
    await box.fill(`original ${device}`); await box.press("Enter");
    await until("two completed message reply actions", async () => (await page.getByRole("button", { name: "Reply", exact: true }).count()) >= 2);
    await box.fill(`draft ${device}`);
    await page.getByRole("button", { name: "Reply", exact: true }).nth(1).click();
    await page.getByText("Replying to AI", { exact: true }).waitFor();
    assert.equal(await box.inputValue(), `draft ${device}`);
    await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
    assert.equal(await box.inputValue(), `draft ${device}`);
    await page.getByRole("button", { name: "Reply", exact: true }).nth(1).click();
    await new Promise((r) => setTimeout(r, 1500));
    await page.reload(); await box.waitFor({ state: "visible" });
    await page.getByText("Replying to AI", { exact: true }).waitFor();
    assert.equal(await box.inputValue(), `draft ${device}`);
    await box.press("Enter");
    const turn = await until("provider captured reply", async () => (await api("/__instant-test/state")).turns.find((t) => t.message.startsWith(`draft ${device}`)));
    assert(turn.message.includes("<ppm-reply-v1>")); assert(turn.message.includes('"role":"assistant"'));
    await page.getByText("Reply to AI", { exact: true }).waitFor();
    await until("reply response complete", async () => (await page.getByRole("button", { name: "Reply", exact: true }).count()) >= 4);
    await page.getByRole("button", { name: "Reply", exact: true }).first().click();
    await page.getByText("Replying to you", { exact: true }).waitFor();
    await box.fill(`user reply ${device}`); await box.press("Enter");
    const userTurn = await until("provider captured user reference", async () => (await api("/__instant-test/state")).turns.find((t) => t.message.startsWith(`user reply ${device}`)));
    assert(userTurn.message.includes('"role":"user"')); assert(userTurn.message.includes(`original ${device}`));
    await page.getByText("Reply to you", { exact: true }).waitFor();
    await until("last response complete", async () => (await page.getByRole("button", { name: "Reply", exact: true }).count()) >= 6);
    await page.reload();
    await page.getByText("Reply to AI", { exact: true }).waitFor(); await page.getByText("Reply to you", { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, `${device}.png`), fullPage: true });
    const scripts = await page.locator("script[src]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("src")));
    assert(scripts.some((src) => src.startsWith("/assets/index-"))); assert(!scripts.some((src) => src.includes("@vite/client")));
    if (device === "mobile") {
      const bounds = await page.getByRole("button", { name: "Reply", exact: true }).first().boundingBox(); assert(bounds.height >= 44);
    }
    assert.deepEqual(errors, []);
    results.push({ device, passed: true, providerReply: turn.message, providerUserReply: userTurn.message, scripts });
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
