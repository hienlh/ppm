// The AI's database tools, end to end, on the production Vite bundle against a disposable API/ws
// server whose only provider is scripted (tests/e2e/fixtures/db-tools-server.ts): each turn calls
// the real /api/db-tools-mcp endpoint with the token the turn was handed, against a SQLite file in
// the sandbox. Covers the tool cards under both providers' names, approving a change with PPM's
// password (a wrong one first), declining one, a Query tab opened with the AI's script and run on
// the readonly connection with "Run with write access (once)", the audit history, and the
// approval card on a phone. No live credentials, no real PPM data.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/e2e/ai-db-tools-e2e.mjs
//
// PPM_DB_TOOLS_WEB_DIR=<dir> reuses a scratch build (with Monaco staged under assets/monaco/vs).
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-db-tools-e2e-"));
const artifacts = process.env.PPM_DB_TOOLS_ARTIFACTS ? resolve(process.env.PPM_DB_TOOLS_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
await Promise.all([artifacts, ppm, home, project].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

let webDir = process.env.PPM_DB_TOOLS_WEB_DIR;
if (!webDir) {
  webDir = join(sandbox, "web");
  await writeFile(join(artifacts, "build.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
  cpSync(resolve("node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), "Monaco is not staged in the web build");

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const password = randomBytes(12).toString("hex");
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_DB_TOOLS_WEB_DIR: webDir, PPM_DB_TOOLS_E2E_TOKEN: password,
};
delete env.PPM_ALLOW_PROD_DB;
delete env.NOTIFY_SOCKET;
const backend = spawn("bun", ["tests/e2e/fixtures/db-tools-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
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
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` } });
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}
const rows = async () => (await api("/__db-test/rows")).rows;

const NAME = "dbtools";
const results = [];
const record = (name, detail = {}) => { results.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser, current;

let turns = 0;
/** Sends one message whose scripted turn makes `ops` calls; `finished()` resolves with their records. */
async function startTurn(page, ops, message) {
  const before = (await api("/__db-test/calls")).calls.length;
  await api("/__db-test/script", { method: "POST", body: JSON.stringify({ ops }) });
  const box = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
  await box.fill(message);
  await box.press("Enter");
  const n = ++turns;
  return async () => {
    const calls = await until(`${message}: answered`, async () => {
      const mine = (await api("/__db-test/calls")).calls.slice(before);
      return mine.length === ops.length && mine.every((c) => c.text !== undefined) ? mine : null;
    }, 60000);
    await page.locator(`text=Turn ${n}:`).first().waitFor({ state: "attached", timeout: 15000 });
    return calls;
  };
}

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 60000);
  const { path: dbPath } = await api("/__db-test/seed", { method: "POST" });
  const conn = (await api("/api/db/connections", {
    method: "POST", body: JSON.stringify({ type: "sqlite", name: "Prod", connectionConfig: { type: "sqlite", path: dbPath }, groupName: "Live", color: "#e11d48" }),
  })).data;
  assert.equal(conn.readonly, 1, "a new connection is readonly");
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: NAME, path: project }) });
  const created = await api(`/api/project/${NAME}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "DB tools test" }) });
  const sessionId = created.data.id;
  const chatTab = { id: `chat-${sessionId}`, type: "chat", title: "DB tools test", projectId: NAME, closable: true, metadata: { projectName: NAME, sessionId, providerId: "claude" } };
  await api(`/api/project/${NAME}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [chatTab], activeTabId: chatTab.id, tabHistory: [chatTab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true });
  const signedIn = ([token]) => {
    if (window.top !== window) return;
    localStorage.setItem("ppm-auth-token", token);
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  };

  // ---------------------------------------------------------------- desktop
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(signedIn, [password]);
  const page = current = await desktop.newPage();
  await page.goto(`${web}/project/${NAME}`);
  await page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 30000 });

  {
    const finished = await startTurn(page, [
      { tool: "db_query", args: { connection: "Prod", sql: "SELECT id, name FROM items ORDER BY id" } },
      { tool: "db_query", as: "codex", args: { connection: "prod", sql: "SELECT COUNT(*) AS n FROM items" } },
    ], "read the items");
    const [read, count] = await finished();
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /```tsv\nid\tname\n1\ta\n2\tb\n3\tc\n```/);
    assert.match(count.text, /```tsv\nn\n3\n```/);
    const cards = page.locator("[data-tool-ref]", { hasText: "Database query" });
    await until("two query cards", async () => (await cards.count()) === 2);
    assert.match(await cards.first().innerText(), /Prod/);
    record("db_query reads rows as data, and both providers' calls get a database card");
  }

  {
    const sql = "UPDATE items SET name = 'z' WHERE id = 1";
    const finished = await startTurn(page, [{ tool: "db_execute", args: { connection: "Prod", sql, reason: "Rename the first item", expected_rows: 1 } }], "rename it");
    // The title's span, its header row, then the card.
    const card = page.getByText("Approve a database change", { exact: true }).locator("xpath=../..");
    await card.waitFor({ timeout: 20000 });
    const text = await card.innerText();
    for (const part of ["Prod", "Live", "readonly", "Rename the first item", sql, "Rolled back unless exactly 1 row change"]) assert.ok(text.includes(part), `the card shows ${part}`);
    // The call's own card is in the turn while it waits, not only once it has run.
    await page.locator("[data-tool-ref]", { hasText: "Database change" }).first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(artifacts, "desktop-approval.png") });
    await page.getByLabel("PPM password").fill("not-the-password");
    await page.getByRole("button", { name: "Run once" }).click();
    await page.getByText("Wrong password", { exact: true }).waitFor();
    assert.deepEqual((await rows())[0], { id: 1, name: "a" }, "nothing ran on a wrong password");
    await page.getByLabel("PPM password").fill(password);
    await page.getByRole("button", { name: "Run once" }).click();
    const [call] = await finished();
    assert.equal(call.isError, false, call.text);
    assert.match(call.text, /was committed: 1 row changed in all/);
    await page.getByText("Approve a database change", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual((await rows())[0], { id: 1, name: "z" });
    await page.locator("[data-tool-ref]", { hasText: "Database change" }).first().waitFor();
    record("db_execute shows the change, keeps waiting through a wrong password, and commits after the right one");
  }

  {
    const finished = await startTurn(page, [{ tool: "db_execute", args: { connection: "Prod", sql: "DELETE FROM items", reason: "Clear the table" } }], "clear it");
    await page.getByText("Approve a database change", { exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Decline" }).click();
    const [call] = await finished();
    assert.equal(call.isError, true);
    assert.match(call.text, /declined the change, so nothing ran/);
    assert.equal((await rows()).length, 3);
    record("declining runs nothing");
  }

  {
    const sql = "DELETE FROM items WHERE id = 3";
    const finished = await startTurn(page, [{ tool: "open_query", args: { connection: "Prod", sql } }], "give me the delete");
    const [call] = await finished();
    assert.equal(call.isError, false, call.text);
    assert.match(call.text, /Nothing ran/);
    const layout = await page.evaluate((name) => JSON.parse(localStorage.getItem(`ppm-panels-${name}`) ?? "null"), NAME);
    const queryTab = Object.values(layout.panels).flatMap((p) => p.tabs).find((t) => t.type === "db-query");
    assert.ok(queryTab, "a Query tab was opened");
    assert.equal(queryTab.metadata.currentSql, sql);
    assert.equal(queryTab.metadata.connectionId, conn.id);
    const chatPanel = Object.values(layout.panels).find((p) => p.tabs.some((t) => t.type === "chat"));
    assert.ok(!chatPanel.tabs.some((t) => t.type === "db-query"), "the Query tab opened beside the chat, not over it");
    assert.equal((await rows()).length, 3, "opening the tab ran nothing");

    // Run reads the script from the editor, so it waits for Monaco to show it.
    await page.locator(".monaco-editor .view-lines", { hasText: "DELETE FROM items WHERE id = 3" }).first().waitFor({ timeout: 30000 });
    await page.locator('button[title^="Run the whole script"]:visible').click();
    const lift = page.getByRole("button", { name: "Run with write access (once)" });
    await lift.waitFor({ timeout: 15000 });
    await page.screenshot({ path: join(artifacts, "desktop-write-once-offer.png") });
    await lift.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("PPM password").fill(password);
    await page.screenshot({ path: join(artifacts, "desktop-write-once-dialog.png") });
    await dialog.getByRole("button", { name: "Run once" }).click();
    await until("row 3 deleted", async () => (await rows()).length === 2);
    await lift.waitFor({ state: "detached" });
    record("open_query puts the script in a Query tab beside the chat, and Run with write access (once) runs it on the readonly connection");
  }

  {
    const history = (await api(`/api/db/connections/${conn.id}/history`)).data.items;
    const byAi = history.filter((i) => i.byAgent).map((i) => i.sql);
    assert.ok(byAi.includes("SELECT id, name FROM items ORDER BY id"), JSON.stringify(byAi));
    assert.ok(byAi.includes("UPDATE items SET name = 'z' WHERE id = 1"), JSON.stringify(byAi));
    assert.ok(history.some((i) => !i.byAgent && i.sql === "DELETE FROM items WHERE id = 3" && i.status === "ok"), JSON.stringify(history));
    record("the Query tab's History lists the AI's runs beside the user's", { entries: history.length });
  }

  {
    // Settings → Tools. Last on the desktop: its window stays open over the workspace.
    await page.locator('button[aria-label="Settings"]').click();
    await page.locator('[data-testid="settings-rail-tools"]').click();
    const toolSwitch = (label) => page.getByRole("switch", { name: new RegExp(label) });
    await toolSwitch("Change databases").waitFor({ timeout: 15000 });
    const labels = ["Open files", "Show pages", "Show running apps", "Read terminals", "Type commands", "Read databases", "Open Query tabs", "Change databases"];
    const states = Object.fromEntries(await Promise.all(labels.map(async (l) => [l, await toolSwitch(l).getAttribute("aria-checked")])));
    // open_file and open_preview follow the older single switch, off here; every other tool starts on.
    assert.deepEqual(states, {
      "Open files": "false", "Show pages": "false", "Show running apps": "true", "Read terminals": "true", "Type commands": "true",
      "Read databases": "true", "Open Query tabs": "true", "Change databases": "true",
    });
    await toolSwitch("Change databases").click();
    await until("db_execute saved off", async () => (await api("/api/settings/ai")).data.ppm_tools?.db_execute === false);
    await until("switch shows off", async () => (await toolSwitch("Change databases").getAttribute("aria-checked")) === "false");
    await page.waitForTimeout(300); // the switch's own transition
    await page.screenshot({ path: join(artifacts, "desktop-settings-tools.png") });
    const finished = await startTurn(page, [{ tool: "db_execute", args: { connection: "Prod", sql: "DELETE FROM items", reason: "Clear the table" } }], "clear it while the tool is off");
    const [call] = await finished();
    assert.equal(call.handed, true, "the other database tools are still on");
    assert.equal(call.isError, true);
    assert.match(call.text, /turned off db_execute in PPM's settings \(Settings → Tools\)/);
    assert.equal((await rows()).length, 2, "nothing ran");
    await toolSwitch("Change databases").click();
    await until("db_execute saved on", async () => (await api("/api/settings/ai")).data.ppm_tools?.db_execute === true);
    await until("switch shows on", async () => (await toolSwitch("Change databases").getAttribute("aria-checked")) === "true");
    record("Settings → Tools shows each tool's switch, and a tool switched off there is refused in the chat", { states });
  }
  await desktop.close();

  // ---------------------------------------------------------------- phone
  {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await phone.addInitScript(signedIn, [password]);
    await api(`/api/project/${NAME}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [chatTab], activeTabId: chatTab.id, tabHistory: [chatTab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });
    const mobile = current = await phone.newPage();
    await mobile.goto(`${web}/project/${NAME}`);
    await mobile.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 30000 });
    const finished = await startTurn(mobile, [{ tool: "db_execute", args: { connection: "Prod", sql: "UPDATE items SET name = 'p' WHERE id = 2", reason: "Rename the second item", expected_rows: 1 } }], "rename the second");
    const title = mobile.getByText("Approve a database change", { exact: true });
    await title.waitFor({ timeout: 20000 });
    await title.scrollIntoViewIfNeeded();
    const run = mobile.getByRole("button", { name: "Run once" });
    const input = mobile.getByLabel("PPM password");
    await run.scrollIntoViewIfNeeded();
    await mobile.screenshot({ path: join(artifacts, "phone-approval.png") });
    const runBox = await run.boundingBox();
    const fontSize = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(runBox.height >= 44, `Run once is a 44px target (${runBox.height})`);
    assert.ok(fontSize >= 16, `the password field does not zoom iOS (${fontSize}px)`);
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);
    await input.fill(password);
    await run.tap();
    const [call] = await finished();
    assert.equal(call.isError, false, call.text);
    assert.deepEqual((await rows())[1], { id: 2, name: "p" });
    record("phone: the approval card fits, its button is a 44px target, and approving works", { run: runBox, fontSize });

    await mobile.locator('button[aria-label="Open menu"]').click();
    await mobile.locator("button", { hasText: /^Settings$/ }).filter({ visible: true }).first().tap();
    await mobile.locator('[data-testid="settings-index-tools"]').tap();
    const toolSwitch = mobile.getByRole("switch", { name: /Change databases/ });
    await toolSwitch.waitFor({ timeout: 15000 });
    await mobile.screenshot({ path: join(artifacts, "phone-settings-tools.png") });
    const rowBox = await toolSwitch.locator("xpath=..").boundingBox();
    const toolsOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(rowBox.height >= 44, `a tool's row is a 44px target (${rowBox.height})`);
    assert.ok(toolsOverflow <= 0, `no sideways scroll in Settings → Tools (${toolsOverflow}px)`);
    record("phone: Settings → Tools fits, each row a 44px target", { row: rowBox });
    await phone.close();
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  try { await current?.screenshot({ path: join(artifacts, "failure.png") }); } catch { /* the page may be gone */ }
} finally {
  await browser?.close();
  backend.kill();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.length} passed; artifacts in ${artifacts}`);
}
