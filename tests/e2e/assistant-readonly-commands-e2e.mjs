// The PPM Assistant runs commands that only read without a card, and asks for everything else.
// Runs the REAL Claude provider and CLI (tests/e2e/fixtures/assistant-readonly-commands-server.ts)
// against a fake api.anthropic.com that turns `RUN:` / `PS:` / `EDIT:` lines into tool calls, so
// every call goes through PPM's real PreToolUse hook. Scratch PPM_HOME and home, nothing else.
//
// Bash leg (any POSIX host; in practice the capped Docker image), driven in a browser:
//   1. `git -C <proj> status` and `ls -la <proj>` run with no approval_request, both results are
//      badged "Read-only · ran without asking", the trace holds two assistant_auto_allowed rows.
//   2. `rm <proj>/a.txt` raises one card; Deny leaves the file.
//   3. A private key, `sqlite3 -readonly ppm.db`, `git -c core.pager=…`, `ls; touch x`,
//      `echo $(id)`: one card each, and no result reaches the CLI before the answer.
//   4. With "Run read-only commands without asking" off, `git -C <proj> status` asks.
//   5. Edit is not offered while "Let the Assistant act on its own" is off (the call is refused,
//      no card, file unchanged); turned on, a NEW session is offered Edit (the CLI's tool list is
//      fixed when it starts) and a user-started turn edits with no card.
//   Screenshots: the Permissions block, its confirm dialog (desktop and phone bottom sheet), and a
//   badged card beside an approval card; a video of steps 1→2.
// PowerShell leg (Windows host only), over a bare chat socket, no browser or bundle:
//   `Get-Process | Select-Object -First 3 Name, Id` runs with no card; `… | Out-File <proj>\x.txt`
//   asks, and Deny leaves no file.
//
// Docker (Linux, bash leg):
//   docker run --rm --name ppm-task-assistant-ro --cpus=4 --memory=3g -e IS_SANDBOX=1 \
//     -v <repo>:/app:ro -v ppm-assistant-ro-nm:/app/node_modules -v <artifacts>:/out -w /app \
//     -e PPM_RO_ARTIFACTS=/out ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/assistant-readonly-commands-e2e.mjs'
// Windows host (PowerShell leg): PPM_RO_LEGS=powershell node tests/e2e/assistant-readonly-commands-e2e.mjs
// PPM_RO_LEGS picks legs (default: bash on POSIX, powershell on Windows); PPM_RO_WEB_DIR reuses a build.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const WIN = process.platform === "win32";
const legs = new Set((process.env.PPM_RO_LEGS ?? (WIN ? "powershell" : "bash")).split(",").map((s) => s.trim()).filter(Boolean));
const sandbox = await mkdtemp(join(tmpdir(), "ppm-ro-e2e-"));
const artifacts = process.env.PPM_RO_ARTIFACTS ? resolve(process.env.PPM_RO_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
const proj = join(projects, "ro");
const webDir = process.env.PPM_RO_WEB_DIR ? resolve(process.env.PPM_RO_WEB_DIR) : join(sandbox, "web");
await Promise.all([artifacts, ppm, join(home, ".ssh"), proj].map((p) => mkdir(p, { recursive: true })));
const BUN = process.env.PPM_BUN || "bun";
const KEY_MARK = "FAKE-PRIVATE-KEY-DO-NOT-LEAK";

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { env: process.env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

// ------------------------------------------------------------------ fixtures on disk
await writeFile(join(home, ".ssh", "id_rsa"), `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_MARK}\n-----END OPENSSH PRIVATE KEY-----\n`);
await writeFile(join(proj, "a.txt"), "keep me\n");
await writeFile(join(proj, "b.txt"), "hello\n");
await command(BUN, ["-e", `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(join(proj, "data.sqlite"))}); db.run("CREATE TABLE t (x)"); db.run("INSERT INTO t VALUES (1)"); db.close();`]);
const git = (...args) => command("git", ["-C", proj, "-c", "user.email=e2e@ppm.test", "-c", "user.name=e2e", ...args]);
await git("init", "-q"); await git("add", "."); await git("commit", "-q", "-m", "first");

if (legs.has("bash") && !process.env.PPM_RO_WEB_DIR) {
  console.log("Building the web bundle…");
  await writeFile(join(artifacts, "build.log"), await command(BUN, ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}

// ------------------------------------------------------------------ fixture server
const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
  PPM_HTML_TEST_PORT: String(port), ...(legs.has("bash") ? { PPM_RO_WEB_DIR: webDir } : {}),
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn(BUN, ["tests/e2e/fixtures/assistant-readonly-commands-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout = 60000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 400)})`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(body)}`); return body;
}
const apiRequests = async () => (await api("/__ro-test/api")).requests;
const autoAllowed = async (sessionId) => (await api(`/api/trace/sessions/${sessionId}`)).data.events.filter((e) => e.type === "assistant_auto_allowed");
const newSession = async () => (await api("/api/project/__assistant__/chat/sessions", { method: "POST", body: JSON.stringify({ providerId: "claude" }) })).data.id;
const settings = async () => (await api("/api/assistant/settings")).data.settings;

const results = [];
const pass = (leg, step, detail = {}) => { results.push({ leg, step, passed: true, ...detail }); console.log(`PASS [${leg}] ${step}`); };
const shots = [];

// ------------------------------------------------------------------ bash leg (browser)
const COMPOSER = ["Ask anything...", "Follow-up...", "Follow-up or Stop..."].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
const BADGE = "Read-only · ran without asking";
const READONLY_LABEL = "Run read-only commands without asking";
const ACT_LABEL = "Let the Assistant act on its own";

let browser = null;
async function bashLeg(pw) {
  browser = await pw.chromium.launch({
    headless: true,
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  const errors = [];
  const onboarding = () => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  /** A device: a page whose chat-socket frames are kept, so a test can say "no approval_request". */
  async function device(name, opts) {
    const context = await browser.newContext(opts);
    await context.addInitScript(onboarding);
    const page = await context.newPage();
    const dev = { name, context, page, frames: [] };
    page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/chat/")) return;
      ws.on("framereceived", (f) => { try { dev.frames.push(JSON.parse(String(f.payload))); } catch { /* not JSON */ } });
    });
    return dev;
  }
  const desktop = { viewport: { width: 1366, height: 900 }, serviceWorkers: "block" };
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" };
  const root = (dev) => dev.page.locator("[data-assistant-body]:visible").first();
  const composer = (dev) => root(dev).locator(COMPOSER).first();
  const card = (dev) => root(dev).locator("[data-approval-request]:visible").last();
  async function open(dev, sessionId) {
    await dev.page.goto(`${web}/assistant?session=claude/${sessionId}`);
    await composer(dev).waitFor({ timeout: 30000 });
  }
  /** Sends `lines` as one message; answers with the index of the first frame of this turn. */
  async function send(dev, lines) {
    const from = dev.frames.length;
    await composer(dev).fill(lines.join("\n"));
    await composer(dev).press("Enter");
    return from;
  }
  const since = (dev, from, type) => dev.frames.slice(from).filter((f) => f.type === type);
  const turnDone = (dev, from, timeout = 120000) => until("turn done", () => since(dev, from, "done").length > 0, timeout);
  async function shot(dev, name, locator) {
    const path = join(artifacts, `${name}.png`);
    await (locator ?? dev.page).screenshot({ path });
    shots.push(path);
  }
  async function openPermissions(dev) {
    await dev.page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
    await dev.page.locator('[data-testid="assistant-settings-tab-general"]:visible').first().click();
    const block = dev.page.locator('[data-testid="assistant-permissions"]:visible').first();
    await block.getByRole("switch", { name: READONLY_LABEL }).waitFor({ timeout: 15000 });
    await block.scrollIntoViewIfNeeded();
    return block;
  }
  async function closeSettings(dev) {
    const win = dev.page.locator('[aria-roledescription="window"][aria-label="Settings"]:visible');
    if (await win.count()) await win.first().locator('button[aria-label="Close window"]').first().dispatchEvent("click");
  }
  const tick = (block, label) => block.getByRole("switch", { name: label });

  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "ro", path: proj }) });
  const sessionId = await newSession();

  // ---- 1 and 2, recorded ---------------------------------------------------------------
  let rec;
  try {
    rec = await device("desktop-video", { ...desktop, recordVideo: { dir: join(sandbox, "video"), size: { width: 1366, height: 900 } } });
  } catch (e) {
    console.log(`Video not recorded: ${e.message.split("\n")[0]}`);
    rec = await device("desktop-video", desktop);
  }
  await open(rec, sessionId);
  const look = await device("phone-look", PHONE);
  await open(look, sessionId);
  let from = await send(rec, [`RUN: git -C ${proj} status`, `RUN: ls -la ${proj}`]);
  await turnDone(rec, from);
  assert.deepEqual(since(rec, from, "approval_request"), [], "a read-only command raised a card");
  const badged = since(rec, from, "tool_result").filter((r) => r.autoApproved === "readonly");
  assert.equal(badged.length, 2, `two badged results expected: ${JSON.stringify(since(rec, from, "tool_result"))}`);
  assert(badged.every((r) => !r.isError), "a read-only command failed");
  await root(rec).getByText(BADGE).nth(1).waitFor({ timeout: 15000 });
  const rows1 = await until("two assistant_auto_allowed rows", async () => { const r = await autoAllowed(sessionId); return r.length >= 2 ? r : null; }, 15000);
  assert.equal(rows1.length, 2); assert(rows1.every((r) => r.payload.via === "readonly" && r.payload.tool === "Bash"));
  assert(!JSON.stringify(rows1).includes(proj), "the trace row carries the command text");
  pass("bash", "1 git status + ls run unasked, badged, traced", { autoAllowedRows: rows1.length });

  from = await send(rec, [`RUN: rm ${proj}/a.txt`]);
  await until("rm card", () => since(rec, from, "approval_request").length === 1, 60000);
  await card(rec).waitFor({ timeout: 15000 });
  assert(existsSync(join(proj, "a.txt")), "rm ran before the answer");
  await shot(rec, "d-readonly-badge-beside-approval-card", root(rec));
  await shot(rec, "d-readonly-badge-beside-approval-card-full");
  // The phone, open on the chat since before turn 1, is tall enough to show the badged results
  // above the waiting card. (A device that opens the chat later rebuilds it from the transcript,
  // which does not carry the badge.)
  await card(look).waitFor({ timeout: 15000 });
  await root(look).getByText(BADGE).first().waitFor({ state: "attached", timeout: 15000 });
  await sleep(400);
  await shot(look, "d-readonly-badge-beside-approval-card-phone");
  await look.context.close();
  await card(rec).getByRole("button", { name: "Deny", exact: true }).click();
  await turnDone(rec, from);
  assert(existsSync(join(proj, "a.txt")), "a denied rm removed the file");
  assert.equal(since(rec, from, "approval_request").length, 1);
  pass("bash", "2 rm asks once; Deny keeps the file");
  const video = rec.page.video();
  await rec.context.close();
  if (video) {
    const target = join(artifacts, "scenario-1-2.webm");
    await rename(await video.path(), target).catch(async () => writeFile(target, await readFile(await video.path())));
    shots.push(target);
  }

  // ---- 3. each of these asks, and nothing runs before the answer ----------------------------
  const dev = await device("desktop", desktop);
  await open(dev, sessionId);
  const asked = [
    `RUN: cat ${home}/.ssh/id_rsa`,
    `RUN: sqlite3 -readonly ${ppm}/ppm.db "select 1"`,
    `RUN: git -c core.pager=cat -C ${proj} log`,
    `RUN: ls ${proj}; touch x`,
    "RUN: echo $(id)",
  ];
  const rowsBefore = (await autoAllowed(sessionId)).length;
  from = await send(dev, asked);
  for (let i = 0; i < asked.length; i++) {
    const req = await until(`card ${i + 1}`, () => since(dev, from, "approval_request")[i], 60000);
    await until(`card ${i + 1} on screen`, async () => (await card(dev).getAttribute("data-approval-request")) === req.requestId, 15000);
    // No result of this call has reached the CLI or the browser yet.
    assert.equal(since(dev, from, "tool_result").length, i, `${asked[i]}: a result arrived before the answer`);
    const leaked = (await apiRequests()).flatMap((r) => r.results).filter((r) => r.text.includes(KEY_MARK) || /uid=\d/.test(r.text));
    assert.deepEqual(leaked, [], `${asked[i]}: output reached the model`);
    await card(dev).getByRole("button", { name: "Deny", exact: true }).click();
  }
  await turnDone(dev, from);
  const denied = since(dev, from, "tool_result");
  assert.equal(denied.length, asked.length);
  assert(denied.every((r) => r.isError && !r.autoApproved), `every asked command was denied: ${JSON.stringify(denied)}`);
  const strayX = [];
  (function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === "x") strayX.push(p); } })(sandbox);
  assert.deepEqual(strayX, [], "touch x ran");
  assert.equal((await autoAllowed(sessionId)).length, rowsBefore, "an asked command was traced as auto-allowed");
  pass("bash", "3 private key, sqlite3 on ppm.db, git -c, ls;touch, $(id): one card each, nothing ran", { cards: asked.length });

  // ---- 4. the switch off: a read asks ------------------------------------------------------
  let block = await openPermissions(dev);
  await shot(dev, "a-settings-permissions-block", block);
  await shot(dev, "a-settings-permissions-full");
  await tick(block, READONLY_LABEL).click();
  await until("read-only switch saved off", async () => (await settings()).auto_readonly_commands === false, 10000);
  await closeSettings(dev);
  from = await send(dev, [`RUN: git -C ${proj} status`]);
  await until("git status card", () => since(dev, from, "approval_request").length === 1, 60000);
  await card(dev).getByRole("button", { name: "Allow", exact: true }).click();
  await turnDone(dev, from);
  const allowed = since(dev, from, "tool_result");
  assert(allowed.length === 1 && !allowed[0].isError && !allowed[0].autoApproved, `approved git status: ${JSON.stringify(allowed)}`);
  block = await openPermissions(dev);
  await tick(block, READONLY_LABEL).click();
  await until("read-only switch saved on", async () => (await settings()).auto_readonly_commands === true, 10000);
  await closeSettings(dev);
  pass("bash", "4 switch off: git status asks, runs once allowed, no badge");

  // ---- 5a. Edit off: not offered, refused without a card -------------------------------------
  const editLine = `EDIT: ${proj}/b.txt | hello | changed`;
  const requestsBefore = (await apiRequests()).length;
  from = await send(dev, [editLine]);
  await turnDone(dev, from);
  const turnRequests = (await apiRequests()).slice(requestsBefore).filter((r) => r.tools.includes("Bash"));
  assert(turnRequests.length > 0 && turnRequests.every((r) => !r.tools.includes("Edit") && !r.tools.includes("Write")), "Edit/Write offered while act_on_own is off");
  assert.deepEqual(since(dev, from, "approval_request"), [], "an edit that is not offered raised a card");
  const editResult = since(dev, from, "tool_result").at(-1);
  assert(editResult?.isError && /No such tool available: Edit/.test(String(editResult.output ?? JSON.stringify(editResult))), `Edit refused: ${JSON.stringify(editResult)}`);
  assert.equal(await readFile(join(proj, "b.txt"), "utf8"), "hello\n", "the file changed");
  pass("bash", "5a act_on_own off: Edit not offered, call refused, no card");

  // ---- 5b. turned on (confirm dialog), a new session edits in a user-started turn ---------------
  block = await openPermissions(dev);
  await tick(block, ACT_LABEL).click();
  const confirm = dev.page.getByRole("button", { name: "Turn on", exact: true });
  await confirm.waitFor({ timeout: 10000 });
  await shot(dev, "b-act-on-own-confirm-dialog");
  await confirm.click();
  await until("act_on_own saved on", async () => (await settings()).act_on_own === true, 10000);
  await closeSettings(dev);
  // Edit/Write are fixed when the CLI starts, so the switch reaches a session started after it.
  const second = await newSession();
  await open(dev, second);
  const before5b = (await apiRequests()).length;
  from = await send(dev, [editLine]);
  await turnDone(dev, from);
  const offered = (await apiRequests()).slice(before5b).filter((r) => r.tools.includes("Bash"));
  assert(offered.length > 0 && offered.every((r) => r.tools.includes("Edit")), "Edit not offered to the new session");
  assert.deepEqual(since(dev, from, "approval_request"), [], "act_on_own still asked for an edit inside a project");
  assert.equal(await readFile(join(proj, "b.txt"), "utf8"), "changed\n", "the edit did not land");
  const actRows = await until("act_on_own trace row", async () => { const r = (await autoAllowed(second)).filter((x) => x.payload.via === "act_on_own"); return r.length ? r : null; }, 15000);
  assert(actRows.some((r) => r.payload.tool === "Edit"));
  pass("bash", "5b act_on_own on: a new session is offered Edit and edits with no card in a user-started turn");

  // ---- phone: the same confirm as a bottom sheet --------------------------------------------
  await api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...(await settings()), act_on_own: false }) });
  const phone = await device("phone", PHONE);
  await open(phone, second);
  const phoneBlock = await openPermissions(phone);
  await tick(phoneBlock, ACT_LABEL).click();
  const phoneConfirm = phone.page.getByRole("button", { name: "Turn on", exact: true });
  await phoneConfirm.waitFor({ timeout: 10000 });
  const box = await phoneConfirm.boundingBox();
  assert(box && box.height >= 44, `the confirm button is a 44px touch target (${box?.height})`);
  await sleep(400); // let the sheet finish sliding in
  await shot(phone, "c-act-on-own-confirm-phone-bottom-sheet");
  await phone.page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await settings()).act_on_own, false, "Cancel turned it on");
  pass("bash", "phone: confirm is a bottom sheet with 44px buttons; Cancel leaves it off");

  assert.deepEqual(errors, [], "page errors");
}

// ------------------------------------------------------------------ PowerShell leg (socket)
async function powershellLeg() {
  if (!WIN) { console.log("SKIP [powershell] the PowerShell tool and PowerShell's own parser exist only on Windows"); return; }
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "ro", path: proj }) });
  const sessionId = await newSession();
  const socket = new WebSocket(`${web.replace("http", "ws")}/ws/project/__assistant__/chat/${sessionId}?providerId=claude&clientId=ps-leg`);
  const frames = [];
  socket.onmessage = (m) => { try { frames.push(JSON.parse(String(m.data))); } catch { /* not JSON */ } };
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.send(JSON.stringify({ type: "ready" }));
  const since = (from, type) => frames.slice(from).filter((f) => f.type === type);
  const turn = (lines) => { const from = frames.length; socket.send(JSON.stringify({ type: "message", content: lines.join("\n") })); return from; };
  try {
    let from = turn(["PS: Get-Process | Select-Object -First 3 Name, Id"]);
    await until("PowerShell read turn done", () => since(from, "done").length > 0, 120000);
    assert.deepEqual(since(from, "approval_request"), [], "Get-Process | Select-Object raised a card");
    const ran = since(from, "tool_result");
    assert(ran.length === 1 && ran[0].autoApproved === "readonly" && !ran[0].isError, `badged PowerShell result: ${JSON.stringify(ran)}`);
    const offered = (await apiRequests()).filter((r) => r.answeredWith?.name === "PowerShell");
    assert(offered.length >= 1 && offered.every((r) => r.tools.includes("PowerShell")), "the CLI did not offer its PowerShell tool");
    const rows = await until("PowerShell auto-allowed row", async () => { const r = await autoAllowed(sessionId); return r.length ? r : null; }, 15000);
    assert(rows.some((r) => r.payload.tool === "PowerShell" && r.payload.via === "readonly"));
    pass("powershell", "Get-Process | Select-Object -First 3 Name, Id runs unasked, badged, traced");

    const target = join(proj, "x.txt");
    from = turn([`PS: Get-Process | Out-File ${target}`]);
    const req = await until("Out-File card", () => since(from, "approval_request")[0], 120000);
    assert.equal(req.tool, "PowerShell");
    assert(!existsSync(target), "Out-File ran before the answer");
    socket.send(JSON.stringify({ type: "approval_response", requestId: req.requestId, approved: false }));
    await until("Out-File turn done", () => since(from, "done").length > 0, 120000);
    assert(!existsSync(target), "a denied Out-File wrote the file");
    assert(since(from, "tool_result").every((r) => r.isError && !r.autoApproved));
    pass("powershell", "Get-Process | Out-File asks; Deny writes nothing");
  } finally {
    socket.close();
  }
}

// ------------------------------------------------------------------ run
let failed = null;
try {
  await until("fixture ready", async () => { try { return (await fetch(web + "/api/health")).ok; } catch { return false; } }, 90000);
  if (legs.has("bash")) {
    const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
    const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
    await bashLeg(pw);
  } else console.log("SKIP [bash] not in PPM_RO_LEGS");
  if (legs.has("powershell")) await powershellLeg();
  else console.log("SKIP [powershell] not in PPM_RO_LEGS");
} catch (error) {
  failed = error; console.error(error); process.exitCode = 1;
  let n = 0;
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: join(artifacts, `failure-${n++}.png`) }).catch(() => {});
} finally {
  await writeFile(join(artifacts, `results-${[...legs].join("-")}.json`), JSON.stringify({ platform: process.platform, results, shots, failed: failed ? String(failed.stack ?? failed) : null }, null, 2));
  await writeFile(join(artifacts, `server-${[...legs].join("-")}.log`), serverLog);
  await browser?.close().catch(() => {});
  await fetch(`${web}/__ro-test/exit`, { method: "POST" }).catch(() => {});
  await sleep(300); backend.kill();
}
console.log(JSON.stringify({ passed: !failed, platform: process.platform, legs: [...legs], results, shots: shots.map((s) => s.split(/[\\/]/).pop()) }, null, 2));
