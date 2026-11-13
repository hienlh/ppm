// The Assistant running `ppm` through its shell, end to end, against a scratch PPM on the `dev`
// profile (tests/e2e/fixtures/assistant-cli-server.ts). Nothing between the command and the server
// is a stand-in: the scripted turn asks to run this PPM's own CLI, the card is approved by clicking
// it in the page, and the fixture then really spawns the command with the environment the provider
// would have given it — once as Claude (its CLI's base environment) and once as Codex (the
// allowlisted app-server environment). Each run checks that:
//  1. the command's stderr starts with the PPM it reached: `→ PPM dev (ppm.dev.db) at 127.0.0.1:<port>`
//     (after PPM's own `[config] …` log lines, which any command prints as it loads);
//  2. the rename reached the running server, and the open page shows the new name with no reload;
//  3. `ppm.db` in the scratch home is never created (the command found the dev database's server);
//  4. `chat_stop`, approved on its card, stops a project chat that is running a turn.
// Scripted providers only: no account, no network, no real PPM data.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/assistant-cli-through-server-e2e.mjs
//
// PPM_ASSISTANT_WEB_DIR=<dir> reuses a scratch build (Monaco staged under assets/monaco/vs);
// PPM_PLAYWRIGHT_EXECUTABLE names a Chromium; PPM_ASSISTANT_ARTIFACTS keeps logs and screenshots.
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-assistant-cli-e2e-"));
const artifacts = process.env.PPM_ASSISTANT_ARTIFACTS ? resolve(process.env.PPM_ASSISTANT_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const workbench = join(sandbox, "workbench"), renamed = join(sandbox, "renamed");
await Promise.all([artifacts, ppm, home, workbench, renamed].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
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

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const TARGET_LINE = `→ PPM dev (ppm.dev.db) at 127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir, PPM_PROFILE: "dev",
  PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"), PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "60000",
};
// Nothing of a PPM this run may itself be inside reaches the fixture or its commands.
for (const k of ["PPM_ALLOW_PROD_DB", "PPM_ASSISTANT_FIXTURE_RESUME", "PPM_INSTANCE_ID", "PPM_AI_CHAT", "PPM_ASSISTANT_DB", "PPM_LIVE_HOME"]) delete env[k];

let serverLog = "";
const backend = spawn("bun", ["tests/e2e/fixtures/assistant-cli-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 500)})`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}
const fixtureState = () => api("/__assistant-test/calls");
const scriptOps = (label, ops, match) => api("/__assistant-test/script", { method: "POST", body: JSON.stringify({ label, ops, ...(match ? { match } : {}) }) });
const recordsOf = async (label) => (await fixtureState()).calls.filter((c) => c.label === label);
const chatLive = async (id) => (await api(`/__assistant-test/chat-live/${encodeURIComponent(id)}`)).state;
const projectNames = async () => (await api("/api/projects")).data.map((p) => p.name).sort();

const COMPOSER = ['Ask anything...', 'Follow-up...', 'Follow-up or Stop...'].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
const results = [];
const failures = [];
let browser, page;
const globalFrames = [];
let mainNavigations = 0;

async function shot(name) {
  try { await page.screenshot({ path: join(artifacts, `${name}.png`) }); } catch { /* page gone */ }
}
/** The next card on screen whose id is not `previous`, approved by clicking Allow. */
async function approveNextCard(previous) {
  const card = page.locator("[data-approval-request]:visible").last();
  const requestId = await until("a new card", async () => {
    const id = await card.getAttribute("data-approval-request", { timeout: 500 }).catch(() => null);
    return id && id !== previous ? id : null;
  });
  const text = await card.innerText();
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  return { requestId, text };
}

/** One provider's run: a busy project chat, then one Assistant turn that renames and stops. */
async function scenario(provider, from, to) {
  const providerId = provider.toLowerCase();
  const label = `cli-${providerId}`;
  // A project chat running a turn that only a stop ends.
  const busy = (await api("/api/project/workbench/chat/sessions", { method: "POST", body: JSON.stringify({ providerId: "claude", title: `Busy ${provider}` }) })).data.id;
  await scriptOps(`busy-${providerId}`, [{ sleep: 600000 }], `busy-${providerId}`);
  await api("/__assistant-test/chat-send", { method: "POST", body: JSON.stringify({ sessionId: busy, projectName: "workbench", providerId: "claude", message: `busy-${providerId}: keep working` }) });
  await until(`${provider}: the project chat is running`, async () => (await chatLive(busy))?.running === true);

  // A new Assistant session on this provider, open in the page.
  const { id } = (await api("/api/project/__assistant__/chat/sessions", { method: "POST", body: JSON.stringify({ providerId }) })).data;
  await page.goto(`${web}/assistant?session=${providerId}/${id}`);
  await page.locator(COMPOSER).first().waitFor({ timeout: 30000 });
  await page.evaluate(() => { window.__ppmNoReload = true; });
  const navBefore = mainNavigations;
  const framesBefore = globalFrames.length;

  await scriptOps(label, [
    { shell: { args: ["projects", "rename", from, to] } },
    { mcp: "chat_stop", args: { project: "workbench", sessionId: busy } },
  ]);
  const box = page.locator(COMPOSER).first();
  await box.fill(`Rename ${from} to ${to} with ppm, then stop the busy chat`);
  await box.press("Enter");

  // The shell card: the line is this PPM's own CLI with the arguments.
  const shellCard = await approveNextCard(null);
  assert.match(shellCard.text, new RegExp(`projects rename ${from} ${to}`), "the card shows the command line");
  const [ran] = await until(`${provider}: the command ran`, async () => {
    const mine = await recordsOf(label);
    return mine[0]?.done ? mine : null;
  }, 90000);
  await writeFile(join(artifacts, `${providerId}-command.json`), JSON.stringify(ran, null, 2));
  assert.equal(ran.decision, "ask", "the shell asked first");
  assert.equal(ran.approved, true, "and the card was approved");
  assert.ok(ran.shell, `the command really ran: ${ran.text}`);
  assert.equal(ran.shell.code, 0, `ppm exited 0: ${ran.shell.stderr}`);
  // PPM's own log lines (`[config] Loaded from SQLite`) may come first; the command's first word is the target.
  const firstLine = ran.shell.stderr.split(/\r?\n/).filter((l) => l && !/^\[[\w-]+\] /.test(l))[0];
  assert.equal(firstLine, TARGET_LINE, `stderr begins with the target line (got ${JSON.stringify(ran.shell.stderr.slice(0, 300))})`);
  for (const key of ["PPM_PROFILE", "PPM_INSTANCE_ID", "PPM_AI_CHAT", "PPM_ASSISTANT_DB", "PPM_HOME"]) {
    assert.ok(ran.shell.envKeys.includes(key), `${provider}'s shell environment carries ${key}`);
  }
  // Codex's environment is the allowlist, not the server's whole environment.
  if (providerId === "codex") assert.ok(!ran.shell.envKeys.includes("PPM_HTML_TEST_PORT"), "Codex's shell gets the allowlisted environment only");
  else assert.ok(ran.shell.envKeys.includes("PPM_HTML_TEST_PORT"), "Claude's shell inherits the server's environment");

  // The running server made the change, and told the open page.
  assert.deepEqual(await projectNames(), [to, "workbench"].sort(), "the server holds the new name");
  await until(`${provider}: the page heard projects:changed`, () => globalFrames.slice(framesBefore).some((f) => f.type === "projects:changed"));
  await page.locator('button[title="Switch project"]').first().click();
  await until(`${provider}: the switcher lists ${to}`, async () => {
    // A row reads avatar initial, name, path, last opened — one line each.
    const names = (await page.locator("[data-row-index]").allInnerTexts()).flatMap((r) => r.split("\n").map((l) => l.trim()));
    return names.includes(to) && !names.includes(from);
  });
  await shot(`${providerId}-switcher-after-rename`);
  await page.keyboard.press("Escape");
  assert.equal(mainNavigations, navBefore, "the page did not navigate");
  assert.equal(await page.evaluate(() => window.__ppmNoReload === true), true, "the page did not reload");

  // chat_stop: its card, approved in the page, stops the busy chat.
  const stopCard = await approveNextCard(shellCard.requestId);
  assert.match(stopCard.text, /Busy|workbench/, "the stop card names the chat");
  const [, stopped] = await until(`${provider}: chat_stop answered`, async () => {
    const mine = await recordsOf(label);
    return mine.length === 2 && mine[1].done ? mine : null;
  }, 60000);
  assert.equal(stopped.isError, false, `chat_stop: ${stopped.text}`);
  assert.equal(JSON.parse(stopped.text).outcome, "stopped");
  await until(`${provider}: the busy chat stopped`, async () => (await chatLive(busy))?.running === false);
  await page.getByText(`Turn "${label}" done.`).first().waitFor({ state: "attached", timeout: 30000 });

  assert.equal(existsSync(join(ppm, "ppm.db")), false, "ppm.db was never created");
  results.push({ provider, line: ran.shell.line, targetLine: firstLine, stdout: ran.shell.stdout.trim(), renamed: `${from} → ${to}`, stopped: busy });
  console.log(`PASS [${provider}] ${firstLine} | ${ran.shell.line.replace(/^.*index\.ts/, "ppm")} | chat_stop stopped ${busy}`);
}

try {
  await until("fixture ready and endpoint published", async () => /Endpoint published/.test(serverLog) || backend.exitCode !== null, 60000);
  assert.equal(backend.exitCode, null, `fixture exited: ${serverLog}`);
  assert.ok(existsSync(join(ppm, "ppm.dev.db")), "the fixture runs on ppm.dev.db");
  assert.equal(existsSync(join(ppm, "ppm.db")), false, "and no ppm.db exists");
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "workbench", path: workbench }) });
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "alpha-cli", path: renamed }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  if (!modulePath) throw new Error("PPM_PLAYWRIGHT_MODULE must name playwright's index.mjs");
  const pw = await import(pathToFileURL(modulePath).href);
  browser = await pw.chromium.launch({
    headless: true, channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined,
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  });
  page = await context.newPage();
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) mainNavigations++; });
  page.on("websocket", (ws) => {
    if (!/\/ws\/global(?:\?|$)/.test(ws.url())) return;
    ws.on("framereceived", (f) => { try { globalFrames.push(JSON.parse(String(f.payload))); } catch { /* not JSON */ } });
  });

  for (const [provider, from, to] of [["Claude", "alpha-cli", "bravo-cli"], ["Codex", "bravo-cli", "charlie-cli"]]) {
    try { await scenario(provider, from, to); } catch (error) {
      failures.push({ provider, error: String(error.stack ?? error) });
      console.error(`FAIL [${provider}] ${error.stack ?? error}`);
      await shot(`failure-${provider.toLowerCase()}`);
    }
  }
} catch (error) {
  failures.push({ provider: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await browser?.close().catch(() => {});
  if (backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED [${f.provider}]: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} passed, ${failures.length} failed; artifacts in ${artifacts}`);
  if (failures.length) process.exitCode = 1;
  else if (process.env.PPM_ASSISTANT_KEEP !== "1") {
    for (const dir of [ppm, home, workbench, renamed, ...(process.env.PPM_ASSISTANT_WEB_DIR ? [] : [webDir])]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error(`could not remove ${dir}: ${e.message}`); }
    }
  }
  process.exit(process.exitCode ?? 0);
}
