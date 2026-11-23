// A chat whose transcript Claude Code no longer has. Runs the REAL Claude provider and CLI against
// a fake Anthropic API (`fixtures/resume-session-missing-server.ts`): Claude's config folder is a
// sandbox, the API key is made up, no live credentials, nothing outside a temp directory.
//
// The transcript is deleted the way a wiped or reinstalled `~/.claude` deletes it, the chat's CLI
// is released (as a restart or PPM's idle release does), then the chat is continued. With "Recover chats Claude Code lost" (asked once as a new feature, answered here):
//   off — one clear line and a stop bar offering "Start fresh here" / "New chat", no raw
//         "No conversation found", no second "SDK error"; the next message starts a new session;
//   on  — one line saying a new session was started, the fake API receives the kept history in
//         that session's first request, and the turn is answered.
// MODE=before runs the first part against a checkout without the change, for its screenshots.
//
// Run with node (Playwright hangs under Bun):
//   PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs PPM_PLAYWRIGHT_CHANNEL=chrome node tests/e2e/resume-session-missing-e2e.mjs
// PPM_RESUME_WEB_DIR reuses a scratch build; PPM_RESUME_ARTIFACTS keeps the screenshots.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const MODE = process.env.MODE === "before" ? "before" : "after";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-resume-missing-e2e-"));
const artifacts = process.env.PPM_RESUME_ARTIFACTS ? resolve(process.env.PPM_RESUME_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
const webDir = process.env.PPM_RESUME_WEB_DIR ? resolve(process.env.PPM_RESUME_WEB_DIR) : join(sandbox, "web");
await Promise.all([artifacts, webDir, ppm, home, project].map((p) => mkdir(p, { recursive: true })));
const BUN = process.env.PPM_BUN || "bun";
const shot = (name) => join(artifacts, `${MODE}-${name}.png`);

async function command(cmd, args, env = process.env) {
  const child = spawn(cmd, args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} exited ${code}: ${log}`);
  return log;
}
if (!process.env.PPM_RESUME_WEB_DIR) {
  console.log("Building the web bundle…");
  await writeFile(join(artifacts, `${MODE}-build.log`), await command(BUN, ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir], { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" }));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_RESUME_WEB_DIR: webDir,
  ...(MODE === "after" ? { PPM_FIXTURE_LEAVE_INTROS: "resume-recovery-2026-11" } : {}),
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn(BUN, ["tests/e2e/fixtures/resume-session-missing-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);
console.log(`fixture server pid ${backend.pid} on port ${port}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await sleep(250); }
  throw new Error(`Timeout: ${label}`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}
const state = () => api("/__resume-test/state");

/** Processes the fixture spawned (the Claude CLIs), so none outlives the run. Windows only. */
function childPids(pid) {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}

const results = []; let browser; let leftover = [];
const record = (step, extra = {}) => { results.push({ step, passed: true, ...extra }); console.log(`PASS ${step}`); };
try {
  await until("API ready", async () => { try { return (await fetch(web + "/api/health")).ok; } catch { return false; } });
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true,
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });

  const projectName = "resume";
  const projectDir = join(project, projectName); await mkdir(projectDir); await command("git", ["init", projectDir]);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName, path: projectDir }) });
  const created = await api(`/api/project/${projectName}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Lost transcript" }) });
  const sessionId = created.data.id;
  const tab = { id: `res-${sessionId}`, type: "chat", title: "Lost transcript", projectId: projectName, closable: true, metadata: { projectName, sessionId, providerId: "claude" } };
  await api(`/api/project/${projectName}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { "res-panel": { id: "res-panel", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["res-panel"]], focusedPanelId: "res-panel" } }) });

  const tourDismissed = () => { if (window.top === window) localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })); };
  const errors = [];
  async function openPage(viewport, phone) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block", deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(tourDismissed);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${phone ? "phone" : "desktop"}: ${String(e)}`));
    await page.goto(`${web}/project/${projectName}`);
    return page;
  }
  const desktop = await openPage({ width: 1440, height: 900 }, false);
  const phone = await openPage({ width: 390, height: 844 }, true);
  const box = (page) => page.locator("textarea:visible").first();
  const send = async (page, text) => { const b = box(page); await b.waitFor({ state: "visible", timeout: 60000 }); await b.fill(text); await b.press("Enter"); };

  // ---- the new feature's question, then Turn off ----------------------------------------------
  if (MODE === "after") {
    const title = "Recover chats Claude Code lost";
    await desktop.getByRole("heading", { name: title }).waitFor({ timeout: 60000 });
    await phone.getByRole("heading", { name: title }).waitFor({ timeout: 60000 });
    await desktop.screenshot({ path: shot("1440-1-feature-intro") });
    await phone.screenshot({ path: shot("390-1-feature-intro") });
    await desktop.getByRole("button", { name: "Turn off" }).click();
    await until("answer stored", async () => (await state()).resumeRecovery === false, 15000);
    await desktop.getByRole("heading", { name: title }).waitFor({ state: "detached", timeout: 15000 });
    record("the new feature is asked once and Turn off stores ai.resume_recovery=false");
  }

  // ---- a chat with history, whose transcript then disappears ---------------------------------
  await send(desktop, "first task");
  await desktop.getByText("Reply to: first task").first().waitFor({ timeout: 120000 });
  await until("turn ended", async () => !(await desktop.getByRole("button", { name: /^stop/i }).isVisible().catch(() => false)), 30000);
  await sleep(1500);
  const removed = (await api("/__resume-test/delete-transcript", { method: "POST", body: JSON.stringify({ sessionId }) })).removed;
  assert.equal(removed.length, 1, "the chat's transcript was not where the CLI writes it");
  // A live CLI holds the chat in memory and never re-reads the file; the next message must need a
  // new one, as after a restart or once PPM released the quiet chat's subprocess.
  assert.equal((await api("/__resume-test/release-cli", { method: "POST", body: JSON.stringify({ sessionId }) })).released, true);
  record("a real CLI turn wrote the transcript under the sandboxed CLAUDE_CONFIG_DIR; it was deleted and the chat's CLI released", { removed });

  await send(desktop, "Continue from where you left off.");
  if (MODE === "before") {
    await desktop.getByText(/No conversation found/).first().waitFor({ timeout: 120000 });
    await sleep(3000);
    await phone.getByText(/No conversation found/).first().waitFor({ timeout: 30000 });
    await desktop.screenshot({ path: shot("1440-continue") });
    await phone.screenshot({ path: shot("390-continue") });
    const raw = await desktop.getByText(/No conversation found/).count();
    record("before: Continue shows Claude Code's raw error", { rawErrorLines: raw, sdkErrorShown: (await desktop.getByText(/SDK error/).count()) > 0 });
  } else {
    // ---- off: one clear line, a stop bar with a way out, and a fresh session next -------------
    const bar = desktop.locator("[data-testid=turn-stop-bar][data-stop-kind=session-missing]");
    await bar.waitFor({ timeout: 120000 });
    await phone.locator("[data-testid=turn-stop-bar][data-stop-kind=session-missing]").waitFor({ timeout: 30000 });
    assert.equal(await desktop.getByText(/No conversation found/).count(), 0, "the raw CLI error is shown");
    assert.equal(await desktop.getByText(/SDK error/).count(), 0, "the SDK's echo is shown");
    assert.match(await bar.textContent(), /This conversation is gone from Claude Code/);
    const labels = await bar.locator("button").allTextContents();
    assert.deepEqual(labels.map((l) => l.trim()), ["Start fresh here", "New chat"]);
    await desktop.screenshot({ path: shot("1440-2-off-bar") });
    await phone.screenshot({ path: shot("390-2-off-bar") });
    record("off: a stop bar says the conversation is gone, offers Start fresh here / New chat, and no raw error appears");

    await bar.getByRole("button", { name: "Start fresh here" }).click();
    await bar.waitFor({ state: "detached", timeout: 10000 });
    const beforeFresh = (await state()).prompts.length;
    await send(desktop, "hello fresh");
    await desktop.getByText("Reply to: hello fresh").first().waitFor({ timeout: 120000 });
    const freshPrompt = (await state()).prompts.slice(beforeFresh).find((p) => p.includes("hello fresh"));
    assert(freshPrompt && !freshPrompt.includes("<earlier-turn"), "Start fresh here sent history");
    record("off: after Start fresh here the next message starts a new session, with no history sent");

    // ---- on: a new session carrying what PPM kept, in one line ----------------------------------
    await until("turn ended", async () => !(await desktop.getByRole("button", { name: /^stop/i }).isVisible().catch(() => false)), 30000);
    await sleep(1500);
    await api("/api/settings/ai", { method: "PUT", body: JSON.stringify({ resume_recovery: true }) });
    assert.equal((await state()).resumeRecovery, true);
    const removedAgain = (await api("/__resume-test/delete-transcript", { method: "POST", body: JSON.stringify({ sessionId }) })).removed;
    assert.equal(removedAgain.length, 1);
    assert.equal((await api("/__resume-test/release-cli", { method: "POST", body: JSON.stringify({ sessionId }) })).released, true);
    const beforeRecovered = (await state()).prompts.length;
    const repliesBefore = await desktop.getByText(/^Reply to:/).count();
    await send(desktop, "Continue from where you left off.");
    const notice = desktop.locator("[data-testid=session-recovered-notice]");
    await notice.waitFor({ timeout: 120000 });
    await until("the recovered turn answered", async () => (await desktop.getByText(/^Reply to:/).count()) > repliesBefore, 120000);
    // The fake echoes what was typed (the history rides in the shared-context block in front of it).
    await desktop.getByText("Reply to: Continue from where you left off.").first().waitFor({ timeout: 10000 });
    await phone.locator("[data-testid=session-recovered-notice]").waitFor({ timeout: 30000 });
    assert.equal(await notice.count(), 1, "more than one notice");
    assert.equal(await desktop.locator("[data-testid=turn-stop-bar]").count(), 0, "a stop bar is shown after recovery");
    assert.equal(await desktop.getByText(/No conversation found|SDK error/).count(), 0, "a raw error is shown");
    const sent = (await state()).prompts.slice(beforeRecovered).find((p) => p.includes("<earlier-turn"));
    assert(sent, "the new session's first request carried no history");
    assert(sent.includes("User: first task") && sent.includes("User: hello fresh"), "the kept turns are missing");
    assert(sent.includes("Assistant: Reply to: first task"), "the kept answers are missing");
    await desktop.screenshot({ path: shot("1440-3-recovered") });
    await phone.screenshot({ path: shot("390-3-recovered") });
    await notice.locator("summary").click();
    await desktop.screenshot({ path: shot("1440-4-recovered-what-was-sent") });
    record("on: one line says a new session was started, the fake API received the kept turns, and the turn was answered", { sentChars: sent.length });

    // The chat goes on in the recovered session: the next message resumes it.
    await until("turn ended", async () => !(await desktop.getByRole("button", { name: /^stop/i }).isVisible().catch(() => false)), 30000);
    await sleep(1000);
    await send(desktop, "and after that");
    await desktop.getByText("Reply to: and after that").first().waitFor({ timeout: 120000 });
    assert.equal(await desktop.locator("[data-testid=session-recovered-notice]").count(), 1, "the next message recovered again");
    record("on: the next message resumes the recovered session normally");
  }

  assert.deepEqual(errors, [], "page errors");
  console.log(JSON.stringify({ passed: true, mode: MODE, artifacts, results }, null, 2));
} catch (error) {
  results.push({ passed: false, error: error.stack }); console.error(error); process.exitCode = 1;
  for (const context of browser?.contexts() || []) for (const [i, page] of context.pages().entries()) await page.screenshot({ path: join(artifacts, `${MODE}-failure-${i}.png`), fullPage: true }).catch(() => {});
} finally {
  const final = await state().catch(() => null);
  const clis = childPids(backend.pid);
  await api("/__resume-test/shutdown", { method: "POST" }).catch(() => null);
  await browser?.close();
  await until("fixture exit", async () => backend.exitCode !== null, 15000).catch(() => {});
  if (backend.exitCode === null) { console.log(`fixture pid ${backend.pid} did not exit; killing that pid`); backend.kill(); }
  // Any CLI the fixture started that is still alive is stopped by its own pid, nothing broader.
  leftover = clis.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (const pid of leftover) { try { process.kill(pid); } catch {} }
  await writeFile(join(artifacts, `${MODE}-results.json`), JSON.stringify({ artifacts, webDir, fixturePid: backend.pid, cliPids: clis, leftoverKilled: leftover, results, api: final }, null, 2));
  await writeFile(join(artifacts, `${MODE}-server.log`), serverLog);
  console.log(`fixture pid ${backend.pid} stopped; CLI pids seen ${JSON.stringify(clis)}, leftover killed ${JSON.stringify(leftover)}`);
}
