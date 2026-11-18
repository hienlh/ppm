// The cards of PPM's own tools, end to end, on the production Vite bundle against a disposable
// API/ws server whose only provider is scripted (tests/e2e/fixtures/ppm-tool-cards-server.ts).
// One manager chat calls the task, session-history, schedule, report and database tools — most
// through PPM's real endpoints with the token the turn was handed — one call fails and one is
// still running when the screenshots are taken, and one card is opened. Then the task code opens
// the task's quick view and a turn read opens its chat. Desktop at 1440 and a phone at 390.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/ppm-tool-cards-e2e.mjs
//
// PPM_TOOL_CARDS_WEB_DIR=<dir> serves that build; PPM_TOOL_CARDS_MODE=before only takes the
// screenshots (for a build without these cards); PPM_TOOL_CARDS_ARTIFACTS=<dir> keeps them.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const MODE = process.env.PPM_TOOL_CARDS_MODE === "before" ? "before" : "after";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-tool-cards-e2e-"));
const artifacts = process.env.PPM_TOOL_CARDS_ARTIFACTS ? resolve(process.env.PPM_TOOL_CARDS_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "demo");
await Promise.all([artifacts, ppm, home, project].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

let webDir = process.env.PPM_TOOL_CARDS_WEB_DIR;
if (!webDir) {
  webDir = join(sandbox, "web");
  await writeFile(join(artifacts, "build.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), PPM_TOOL_CARDS_WEB_DIR: webDir,
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/ppm-tool-cards-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
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
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}

const NAME = "demo";
const results = [];
const record = (name, detail = {}) => { results.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser;

/** The canned answers, written as the tools write them, for the calls that do not go to a real endpoint. */
const turnHead = (sessionId, n) => `Session ${sessionId} · claude · this project (demo) · Turn ${n} · 2026-11-18T14:00:00Z · done`;
const SCRIPT = (other) => [
  { tool: "mcp__ppm-tabs__search_sessions", input: { query: "NX-6317" }, output: JSON.stringify([{ type: "text", text: [
    "Every session below is in this project (demo).", "```text", "Title matches (session · provider · title):",
    `- ${other} · claude · NX-6317 Internal tools`, "", "Content matches (session · provider · title · turn · turn id · time · who: excerpt):",
    `- ${other} · claude · NX-6317 Internal tools · Turn 2 · t2 · 2026-11-18 · user: e2e on Dev`,
    `- ${other} · claude · NX-6317 Internal tools · Turn 5 · t5 · 2026-11-18 · assistant: merged`, "```",
    "Read a turn with read_session_turns(session_id, turn_ids).",
  ].join("\n") }]) },
  { tool: "mcp__ppm-tabs__read_session_turns", input: { session_id: other, turn_ids: ["t2", "t5"] },
    output: `Session data below…\n\`\`\`text\n${turnHead(other, 2)}\nUser: run e2e on Dev\n\n${turnHead(other, 5)}\nAssistant: merged\n\`\`\`` },
  { tool: "mcp__ppm-tabs__list_session_turns", input: { session_id: other }, output: `Session ${other} · claude · this project (demo) · 5 turns · showing turns 1–5\n\`\`\`text\n\`\`\`` },
  { tool: "mcp__ppm-sessions__ppm_task_create", input: { title: "Fix login on Safari", urgency: "today", reason: "from NX-6317" }, real: true },
  { tool: "mcp__ppm-sessions__ppm_task_update", input: { task: "#1", revision: 1, reason: "waiting on QA", status: "Waiting" }, real: true },
  { tool: "mcp__ppm-sessions__ppm_task_get", input: { task: "#1" }, real: true },
  { tool: "mcp__ppm-sessions__ppm_task_list", input: {}, real: true },
  { tool: "mcp__ppm-sessions__ppm_task_close", input: { task: "#9", revision: 1, reason: "done" }, real: true },
  { tool: "mcp__ppm-sessions__send_to_session", input: { session_id: other, message: "Please run the e2e again" },
    output: JSON.stringify({ sessionId: other, title: "NX-6317 Internal tools", providerId: "claude", delivered: "queued" }) },
  { tool: "mcp__ppm-sessions__session_status", input: { session_ids: [other] }, real: true },
  { tool: "mcp__ppm-sessions__report_to_assistant", input: { kind: "needs_decision", title: "Merge PR #42 now or wait for review?" },
    output: JSON.stringify({ cardId: "c1", kind: "needs_decision" }) },
  { tool: "mcp__ppm-sessions__session_schedule_create", input: { name: "Check CI", cron: "0 9 * * *", prompt: "Check CI", recurring: true }, real: true },
  { tool: "mcp__ppm-sessions__session_schedule_list", input: {}, real: true },
  { tool: "mcp__ppm-db__db_query", input: { connection: "Prod", sql: "SELECT id, email FROM users LIMIT 5" },
    output: "Statement 1 returned 5 rows:\nUntrusted…\n```text\nid\temail\n1\ta@x\n```" },
  { tool: "ppm_sessions:ppm_task_get", input: { server: "ppm_sessions", tool: "ppm_task_get", arguments: { task: "#1" } }, output: "Unknown task #1 (Codex sees another store)", isError: true },
  { tool: "mcp__ppm-tabs__search_sessions", input: { query: "deploy" }, hold: true, output: "No session matches \"deploy\"." },
];

const shot = async (page, name) => { await page.screenshot({ path: join(artifacts, `${MODE}-${name}.png`) }); };

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  await command("git", ["init", "-q", project]);
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: NAME, path: project }) });
  await api(`/api/tasks/projects/${NAME}/settings`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const other = (await api(`/api/project/${NAME}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "NX-6317 Internal tools" }) })).data.id;
  const sessionId = (await api(`/api/project/${NAME}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "QL demo" }) })).data.id;
  // The manager chat may create and close tasks; another chat may only work on the ones handed to it.
  const assigned = await fetch(`${web}/api/assistant/managers/${NAME}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
  const managerNote = `${assigned.status} ${await assigned.text()}`;
  assert.ok(assigned.ok, `set as manager chat: ${managerNote}`);
  const chatTab = { id: `chat-${sessionId}`, type: "chat", title: "QL demo", projectId: NAME, closable: true, metadata: { projectName: NAME, sessionId, providerId: "claude" } };
  await api(`/api/project/${NAME}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [chatTab], activeTabId: chatTab.id, tabHistory: [chatTab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE || undefined });
  const onboarding = () => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  };

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 2200 }, serviceWorkers: "block" });
  await desktop.addInitScript(onboarding);
  const page = await desktop.newPage();
  const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${web}/project/${NAME}`);
  const composer = page.locator('textarea[aria-label="Message"]:visible').first();
  await composer.waitFor({ timeout: 30000 });

  await api("/__cards-test/script", { method: "POST", body: JSON.stringify({ ops: SCRIPT(other) }) });
  await composer.fill("go through the board");
  await composer.press("Enter");
  await until("the last call is running", async () => (await api("/__cards-test/holding")).holding, 30000);
  const cards = page.locator("[data-tool-ref]");
  await until("every card drawn", async () => (await cards.count()) >= SCRIPT(other).length, 20000);
  const real = (await api("/__cards-test/real")).answers;
  await writeFile(join(artifacts, `${MODE}-real-answers.json`), JSON.stringify({ managerNote, real }, null, 2));

  // One card opened: its input and output, as before.
  const searchCard = cards.first();
  await searchCard.locator("button").first().click();
  await page.waitForTimeout(400);
  await shot(page, "desktop-1440");

  // The phone joins the same turn while the last call still runs.
  const phone = await browser.newContext({ viewport: { width: 390, height: 2600 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  await phone.addInitScript(onboarding);
  const mobile = await phone.newPage();
  await mobile.goto(`${web}/project/${NAME}`);
  await mobile.locator('textarea[aria-label="Message"]:visible').first().waitFor({ timeout: 30000 });
  const mobileCards = mobile.locator("[data-tool-ref]");
  await until("phone: every card drawn", async () => (await mobileCards.count()) >= SCRIPT(other).length, 20000);
  await mobileCards.first().locator("button").first().click();
  await mobile.waitForTimeout(400);
  await shot(mobile, "phone-390");

  if (MODE === "after") {
    const text = async (sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, " ");
    // Every PPM tool reads as a name, never as mcp__ppm-…
    const raw = await page.locator("[data-tool-ref]", { hasText: /mcp__ppm-|ppm_sessions:/ }).count();
    assert.equal(raw, 0, "no card shows a raw PPM tool name");
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-tabs__search_sessions"]'), /Searched sessions “NX-6317”.*3 results/);
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-tabs__read_session_turns"]'), /Read turns 2, 5 · NX-6317 Internal tools/);
    const create = real.find((a) => a.tool.endsWith("ppm_task_create"));
    assert.equal(create?.isError, false, `ppm_task_create answered: ${create?.output}`);
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-sessions__ppm_task_create"]'), /Created task demo\/1 · Fix login on Safari/);
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-sessions__ppm_task_update"]'), /Updated task demo\/1: status → Waiting/);
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-sessions__ppm_task_get"]'), /Read task demo\/1 · Fix login on Safari · Waiting/);
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-sessions__ppm_task_list"]'), /Listed tasks.*1 task/);
    const failedClose = page.locator('[data-ppm-tool-card="mcp__ppm-sessions__ppm_task_close"]');
    assert.equal(await failedClose.locator("[data-ppm-tool-error]").count(), 1, "the failed close says why");
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-sessions__session_schedule_create"]'), /Scheduled prompt #\d+ · “Check CI” · next /);
    assert.match(await text('[data-ppm-tool-card="mcp__ppm-sessions__report_to_assistant"]'), /Reported to Assistant Needs decision · Merge PR #42/);
    assert.match(await text('[data-tool-ref]:has-text("Database query")'), /5 rows/);
    assert.equal(await page.locator('[data-ppm-tool-card="ppm_sessions:ppm_task_get"] [data-ppm-tool-error]').count(), 1, "a Codex-named call gets the card too");
    const held = page.locator("[data-ppm-tool-card=\"mcp__ppm-tabs__search_sessions\"]").last();
    assert.equal(await held.locator(".animate-spin").count(), 1, "the call still running spins");
    assert.match(await text('[data-session-collab-card="create_session"], [data-session-collab-card="send_to_session"]'), /Message to/);
    record("every PPM tool reads as one line from its real input and output; running, error and Codex calls included");

    // No card is wider than the phone's screen.
    const overflow = await mobile.evaluate(() => [...document.querySelectorAll("[data-tool-ref]")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length);
    assert.equal(overflow, 0, "no card overflows a 390px screen");
    record("no card overflows at 390px");
  }

  await api("/__cards-test/release", { method: "POST" });
  await until("turn finished", async () => (await api("/__cards-test/holding")).turns >= 1 && !(await api("/__cards-test/holding")).holding, 20000);
  await page.locator("text=Turn 1:").first().waitFor({ state: "attached", timeout: 15000 });

  if (MODE === "after") {
    // The task code opens the task's quick view, as a task chip does.
    await page.locator('[data-ppm-tool-task="demo/1"]').first().click();
    const peek = page.locator('[role="dialog"]', { hasText: "Fix login on Safari" }).first();
    await peek.waitFor({ timeout: 10000 });
    await page.waitForTimeout(600); // past the popover's fade-in
    await shot(page, "desktop-task-peek");
    await page.keyboard.press("Escape");
    record("a task code opens the task's quick view");

    // A turn read opens the chat it read.
    await page.locator(`[data-ppm-tool-open-chat="${other}"]`).first().click();
    await until("the other chat opened", async () => page.evaluate((id) => JSON.stringify(localStorage).includes(id) && [...document.querySelectorAll("[data-tab-id], [role=tab]")].some((el) => el.textContent?.includes("NX-6317")), other), 10000);
    await shot(page, "desktop-open-chat");
    record("Open chat opens the chat the call named");
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
  }
  await writeFile(join(artifacts, `${MODE}-results.json`), JSON.stringify(results, null, 2));
  console.log(`DONE ${MODE}: ${results.length} checks passed; screenshots in ${artifacts}`);
} catch (e) {
  await writeFile(join(artifacts, `${MODE}-server.log`), serverLog).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  backend.kill("SIGKILL");
}
