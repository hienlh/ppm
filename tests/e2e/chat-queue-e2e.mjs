// The chat message queue, end to end: the REAL Claude provider and CLI against a fake Anthropic
// API (fixtures/chat-queue-server.ts), on the production Vite bundle. No live credentials,
// nothing outside a temp directory.
//
// 1. A message sent while a command runs waits in the stack above the composer, not in the
//    conversation, and the AI reads it in the same turn once the command finishes.
// 2. Remove takes it out, and the model never sees it.
// 3. Edit puts it back into the composer.
// 4. Send now has the AI read it at once, long before the running command would have finished.
// 5. Stop keeps what was queued and sends it next.
// 7. The list keeps following the reply when the composer shrinks, and scrolling up still stops it.
//
// Run with node (Playwright hangs under Bun):
//   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs node tests/e2e/chat-queue-e2e.mjs
// PPM_QUEUE_WEB_DIR reuses a scratch build; PPM_QUEUE_ARTIFACTS keeps the screenshots.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-queue-e2e-"));
const artifacts = process.env.PPM_QUEUE_ARTIFACTS ? resolve(process.env.PPM_QUEUE_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
const webDir = process.env.PPM_QUEUE_WEB_DIR ? resolve(process.env.PPM_QUEUE_WEB_DIR) : join(sandbox, "web");
await Promise.all([artifacts, webDir, ppm, home, project].map((p) => mkdir(p, { recursive: true })));
const BUN = process.env.PPM_BUN || "bun";

async function command(cmd, args, env = process.env) {
  const child = spawn(cmd, args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} exited ${code}: ${log}`);
  return log;
}
if (!process.env.PPM_QUEUE_WEB_DIR) {
  console.log("Building the web bundle…");
  await writeFile(join(artifacts, "build.log"), await command(BUN, ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_QUEUE_WEB_DIR: webDir,
};
delete env.PPM_ALLOW_PROD_DB;
delete env.NOTIFY_SOCKET;
const backend = spawn(BUN, ["tests/e2e/fixtures/chat-queue-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await sleep(150); }
  throw new Error(`Timeout: ${label}`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body;
}
const seenByModel = async () => (await api("/__queue-test/requests")).flatMap((r) => r.texts).join("\n");

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

  const projectName = "queue";
  const projectDir = join(project, projectName); await mkdir(projectDir); await command("git", ["init", projectDir]);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, path: projectDir }) });
  const created = await api(`/api/project/${projectName}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Queue" }) });
  const sessionId = created.data.id;
  const tab = { id: `q-${sessionId}`, type: "chat", title: "Queue", projectId: projectName, closable: true, metadata: { projectName, sessionId, providerId: "claude" } };
  await api(`/api/project/${projectName}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { "q-panel": { id: "q-panel", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["q-panel"]], focusedPanelId: "q-panel" } }) });

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  await context.addInitScript(() => { if (window.top === window) localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })); });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${web}/project/${projectName}`);
  const box = page.locator("textarea:visible").first();
  await box.waitFor({ state: "visible" });
  const stack = page.getByTestId("queued-messages");
  const send = async (text) => { await box.fill(text); await box.press("Enter"); };
  const userBubble = (text) => page.getByText(text, { exact: true });
  const running = async () => (await page.getByRole("button", { name: /stop/i }).count()) > 0 || (await box.getAttribute("placeholder"))?.startsWith("Queue");
  const idle = () => until("turn ended", async () => (await box.getAttribute("placeholder")) === "Ask anything...", 60000);
  const shot = (name) => page.screenshot({ path: join(artifacts, `${name}.png`) });

  // ---- 1. Queued while a command runs, read in the same turn once it finishes ------------------
  await send("RUN: sleep 6; echo one");
  await until("turn running", running, 60000);
  await sleep(1500);
  await send("QUEUED A");
  await stack.getByText("QUEUED A").waitFor({ timeout: 10000 });
  assert.equal(await userBubble("QUEUED A").count(), 1, "the queued message was drawn in the conversation as well as in the stack");
  assert.equal(await box.inputValue(), "", "the composer kept the queued text");
  await shot("1-queued");
  await page.getByText("Got: QUEUED A").waitFor({ timeout: 30000 });
  assert.equal(await stack.count(), 0, "the stack still showed a message the AI had read");
  await userBubble("QUEUED A").waitFor();
  await idle();
  const turns1 = (await api("/__queue-test/requests")).filter((r) => r.texts.some((t) => t.includes("QUEUED A")));
  assert(turns1.length >= 1 && turns1[0].toolResult, "the queued message did not reach the model alongside the tool result (same turn)");
  await shot("1-read");
  results.push({ step: "read at the next step", passed: true });

  // ---- 2. Remove ----------------------------------------------------------------------------
  await send("RUN: sleep 5; echo two");
  await until("turn running", running, 60000);
  await sleep(1000);
  await send("QUEUED REMOVE ME");
  await stack.getByText("QUEUED REMOVE ME").waitFor({ timeout: 10000 });
  // On a phone every action in the stack is a 44px target.
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  for (const name of ["Remove queued message", "Edit queued message", /Send now/]) {
    const b = await stack.getByRole("button", { name }).boundingBox();
    assert(b && b.height >= 44 && b.width >= 44, `stack button ${name} is ${b?.width}x${b?.height} on a phone`);
  }
  await shot("2-phone");
  await page.setViewportSize({ width: 1280, height: 860 });
  await stack.getByRole("button", { name: "Remove queued message" }).click();
  await until("stack empty", async () => (await stack.count()) === 0, 10000);
  await idle();
  await sleep(1000);
  assert(!(await seenByModel()).includes("QUEUED REMOVE ME"), "a removed message reached the model");
  results.push({ step: "remove", passed: true });

  // ---- 3. Edit -------------------------------------------------------------------------------
  await send("RUN: sleep 5; echo three");
  await until("turn running", running, 60000);
  await sleep(1000);
  await send("QUEUED EDIT ME");
  await stack.getByText("QUEUED EDIT ME").waitFor({ timeout: 10000 });
  await stack.getByRole("button", { name: "Edit queued message" }).click();
  await until("text back in the composer", async () => (await box.inputValue()) === "QUEUED EDIT ME", 10000);
  assert.equal(await stack.count(), 0, "an edited message stayed queued");
  await shot("3-edit");
  await box.fill("");
  await idle();
  await sleep(1000);
  assert(!(await seenByModel()).includes("QUEUED EDIT ME"), "an edited-away message reached the model");
  results.push({ step: "edit", passed: true });

  // ---- 4. Send now ---------------------------------------------------------------------------
  await send("RUN: sleep 40; echo four");
  await until("turn running", running, 60000);
  await sleep(2000);
  await send("QUEUED NOW");
  await stack.getByText("QUEUED NOW").waitFor({ timeout: 10000 });
  const nowAt = Date.now();
  await stack.getByRole("button", { name: /Send now/ }).click();
  await page.getByText("Got: QUEUED NOW").waitFor({ timeout: 20000 });
  assert.equal(await page.getByText(/encountered an error/).count(), 0, "Send now's interrupt was shown as an error");
  const sendNowMs = Date.now() - nowAt;
  assert(sendNowMs < 20000, `Send now took ${sendNowMs} ms`);
  await shot("4-send-now");
  await idle();
  results.push({ step: "send now", passed: true, ms: sendNowMs });

  // ---- 5. Stop keeps the queue -----------------------------------------------------------------
  await send("RUN: sleep 40; echo five");
  await until("turn running", running, 60000);
  await sleep(2000);
  await send("QUEUED AFTER STOP");
  await stack.getByText("QUEUED AFTER STOP").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /stop/i }).first().click();
  await page.getByText("Got: QUEUED AFTER STOP").waitFor({ timeout: 60000 });
  await userBubble("QUEUED AFTER STOP").waitFor();
  assert.equal(await stack.count(), 0);
  await shot("5-after-stop");
  results.push({ step: "stop keeps the queue", passed: true });

  // ---- Reload: the history matches what was shown ----------------------------------------------
  await idle();
  await page.reload();
  await box.waitFor({ state: "visible" });
  for (const text of ["QUEUED A", "QUEUED NOW", "QUEUED AFTER STOP"]) await userBubble(text).first().waitFor({ timeout: 20000 });
  assert.equal(await userBubble("QUEUED REMOVE ME").count(), 0);
  await shot("6-reloaded");
  results.push({ step: "history after reload", passed: true });

  // ---- 7. The list keeps following when its container grows mid-turn ----------------------------
  // The composer shrinking after a multi-line message clamps the scroll position, which the
  // follower used to read as the reader scrolling up: the reply then grew out of sight.
  await page.setViewportSize({ width: 1280, height: 600 });
  const chatGap = () => page.evaluate(() => {
    const el = document.querySelector(".chat-scroll-fade");
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
  });
  await send(Array.from({ length: 10 }, (_, i) => `RUN: sleep 1; echo grow ${i}`).join("\n"));
  await sleep(3000);
  await box.fill("one\ntwo\nthree\nfour\nfive\nsix\nseven");
  await sleep(500);
  await box.fill("");
  await sleep(3500);
  const gapAfterShrink = await chatGap();
  assert(gapAfterShrink <= 2, `the list stopped following after the composer shrank (gap ${gapAfterShrink}px)`);
  const list = await page.locator(".chat-scroll-fade").first().boundingBox();
  await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
  await page.mouse.wheel(0, -300);
  await sleep(2500);
  assert((await chatGap()) > 100, "scrolling up no longer stops the follow");
  await idle();
  results.push({ step: "follow survives the container growing", passed: true });

  assert.deepEqual(errors, []);
  await context.close();
  console.log(JSON.stringify({ passed: true, artifacts, results }, null, 2));
} catch (error) {
  results.push({ passed: false, error: error.stack }); console.error(error); process.exitCode = 1;
  for (const context of browser?.contexts() || []) for (const page of context.pages()) await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  const seen = await api("/__queue-test/requests").catch(() => null);
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ artifacts, webDir, results, seen }, null, 2));
  await writeFile(join(artifacts, "server.log"), serverLog);
  await browser?.close(); backend.kill();
  console.log(`artifacts: ${artifacts}`);
}
