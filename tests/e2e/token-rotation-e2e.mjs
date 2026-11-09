// Renewing a Claude sign-in must not cut a chat short. Runs the REAL Claude provider and CLI
// against a fake Anthropic API that revokes the previous access token on every renewal, on the
// production Vite bundle at phone size. No live credentials, nothing outside a temp directory.
//
// 1. A renewal is held back while a turn runs on the account, then happens once it is quiet,
//    and the idle chat moves onto the new token: its next message gets no 401.
// 2. A renewal forced mid-turn (the point-of-use renewal near expiry) does not touch the
//    running turn; the chat is restarted onto the new token as soon as the turn ends.
// Neither shows "Token refreshed — retrying".
//
// Run with node (Playwright hangs under Bun):
//   PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs PPM_PLAYWRIGHT_CHANNEL=chrome node tests/e2e/token-rotation-e2e.mjs
// PPM_ROTATION_WEB_DIR reuses a scratch build; PPM_ROTATION_ARTIFACTS keeps the screenshots.
// In a Linux container (Debian chromium + node + playwright-core), pass PPM_PLAYWRIGHT_EXECUTABLE
// instead of the channel, and IS_SANDBOX=1: run as root, the CLI otherwise refuses
// --dangerously-skip-permissions and every turn crashes before reaching the fake API.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-rotation-e2e-"));
const artifacts = process.env.PPM_ROTATION_ARTIFACTS ? resolve(process.env.PPM_ROTATION_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
const webDir = process.env.PPM_ROTATION_WEB_DIR ? resolve(process.env.PPM_ROTATION_WEB_DIR) : join(sandbox, "web");
await Promise.all([artifacts, webDir, ppm, home, project].map((p) => mkdir(p, { recursive: true })));
const BUN = process.env.PPM_BUN || "bun";

async function command(cmd, args, env = process.env) {
  const child = spawn(cmd, args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} exited ${code}: ${log}`);
  return log;
}
if (!process.env.PPM_ROTATION_WEB_DIR) {
  console.log("Building the web bundle…");
  await writeFile(join(artifacts, "build.log"), await command(BUN, ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_ROTATION_WEB_DIR: webDir,
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn(BUN, ["tests/e2e/fixtures/token-rotation-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await sleep(200); }
  throw new Error(`Timeout: ${label}`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body;
}
const state = () => api("/__rotation-test/state");
const unauthorizedSince = (s, at) => s.requests.filter((r) => r.status === 401 && r.at >= at);
const logLines = (pattern) => serverLog.split("\n").filter((l) => pattern.test(l));

const results = []; let browser;
try {
  await until("API ready", async () => { try { return (await fetch(web + "/api/health")).ok; } catch { return false; } });
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true,
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });

  const projectName = "rotation";
  const projectDir = join(project, projectName); await mkdir(projectDir); await command("git", ["init", projectDir]);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, path: projectDir }) });
  const created = await api(`/api/project/${projectName}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Token renewal" }) });
  const sessionId = created.data.id;
  const tab = { id: `rot-${sessionId}`, type: "chat", title: "Token renewal", projectId: projectName, closable: true, metadata: { projectName, sessionId, providerId: "claude" } };
  await api(`/api/project/${projectName}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { "rot-panel": { id: "rot-panel", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["rot-panel"]], focusedPanelId: "rot-panel" } }) });

  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, serviceWorkers: "block", deviceScaleFactor: 2 });
  await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${web}/project/${projectName}`);
  const box = page.locator("textarea:visible").first();
  const retryBanner = page.getByText(/Token refreshed|retrying with/i);
  await box.waitFor({ state: "visible" });
  const send = async (text) => { await box.fill(text); await box.press("Enter"); };

  // ---- 1. Renewal waits for a quiet account ----------------------------------------------
  const before = await state();
  assert.equal(before.issued.length, 1, "the account starts on its first token");
  assert(before.expiresInS > 300 && before.expiresInS <= 7200, `account must start inside the early window (${before.expiresInS}s)`);

  await send("slow first task");
  await page.getByText(/step one/).first().waitFor({ timeout: 90000 });
  await page.screenshot({ path: join(artifacts, "1-turn-running.png") });
  const midTurn = await api("/__rotation-test/sweep", { method: "POST" });
  assert.equal(midTurn.issued.length, 1, "a sweep renewed the token while a turn was running");

  await page.getByText(/step eight, done\./).first().waitFor({ timeout: 90000 });
  // Let the `done` event land so the session is idle before the next sweep.
  await until("turn ended", async () => (await page.locator("text=/step eight, done\\./").count()) > 0 && !(await page.getByRole("button", { name: /stop/i }).isVisible().catch(() => false)), 30000);
  await sleep(1500);
  const quiet = await api("/__rotation-test/sweep", { method: "POST" });
  assert.equal(quiet.issued.length, 2, "the quiet account was not renewed early");
  assert.equal(quiet.currentToken, quiet.issued[1], "PPM did not store the renewed token");
  await until("idle chat restarted onto the new token", async () => logLines(/restarting idle subprocess/).length >= 1, 15000);
  const renewedAt = Date.now();

  await send("second message");
  await page.getByText("Reply to: second message").first().waitFor({ timeout: 90000 });
  await sleep(1000);
  const afterSecond = await state();
  assert.deepEqual(unauthorizedSince(afterSecond, renewedAt), [], "the chat hit a 401 after the renewal");
  assert(afterSecond.requests.some((r) => r.at >= renewedAt && r.token === afterSecond.issued[1] && r.status === 200), "the next turn did not use the new token");
  assert.equal(await retryBanner.count(), 0, "the retry banner appeared");
  await page.screenshot({ path: join(artifacts, "2-after-quiet-renewal.png") });
  results.push({ step: "quiet renewal", passed: true, tokensIssued: afterSecond.issued.length });

  // ---- 2. A renewal forced mid-turn moves the chat over once the turn ends --------------------
  await send("slow third task");
  await page.getByText(/step one/).nth(1).waitFor({ timeout: 90000 });
  const forcedAt = Date.now();
  const forced = await api("/__rotation-test/force-renew", { method: "POST" });
  assert.equal(forced.issued.length, 3);
  await page.screenshot({ path: join(artifacts, "3-renewed-mid-turn.png") });
  await page.getByText(/step eight, done\./).nth(1).waitFor({ timeout: 90000 });
  await until("chat restarted after its turn", async () => logLines(/restarting idle subprocess/).length >= 2, 20000);
  assert.equal(await retryBanner.count(), 0, "the running turn was cut short");

  await send("fourth message");
  await page.getByText("Reply to: fourth message").first().waitFor({ timeout: 90000 });
  await sleep(1000);
  const afterFourth = await state();
  const lateUnauthorized = unauthorizedSince(afterFourth, forcedAt);
  assert.deepEqual(lateUnauthorized, [], "the chat hit a 401 after the forced renewal");
  assert.equal(await retryBanner.count(), 0, "the retry banner appeared");
  await page.screenshot({ path: join(artifacts, "4-after-forced-renewal.png") });
  results.push({ step: "forced renewal mid-turn", passed: true, tokensIssued: afterFourth.issued.length });

  assert.deepEqual(errors, []);
  await context.close();
  console.log(JSON.stringify({ passed: true, artifacts, results }, null, 2));
} catch (error) {
  results.push({ passed: false, error: error.stack }); console.error(error); process.exitCode = 1;
  for (const context of browser?.contexts() || []) for (const page of context.pages()) await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  const final = await state().catch(() => null);
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ artifacts, webDir, results, api: final }, null, 2));
  await writeFile(join(artifacts, "server.log"), serverLog);
  await browser?.close(); backend.kill();
}
