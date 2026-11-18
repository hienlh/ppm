// Script schedules an AI proposes, end to end, on the production Vite bundle against the disposable
// session-schedules fixture (tests/e2e/fixtures/session-schedules-server.ts): its scripted Claude
// calls the real `ppm-sessions` tools with the token each turn is handed, and the real scheduler runs
// the script in a real child process. Covers:
//   a: propose → card in the chat (desktop 1440 and phone 390) → Allow → the schedule exists exactly
//      as shown, runs, and its ctx.ai.chat message reaches the named chat;
//   b: the same card as the Telegram relay formats it: Deny only (no Allow), rendered for a screenshot;
//   c: propose → Deny → no schedule;
//   e: propose from a .ppm-schedule.json that carries `values` → the card shows them, the tool's own
//      inputValues winning → Deny;
//   d: pause the script through session_schedule_set_enabled → at once, no card, the answer names it;
//      turning it on → card with the script → Deny → still off.
// No live credentials, no real PPM data: PPM_HOME, HOME and the projects folder are a fresh temp dir.
//
// Run it in the capped e2e image (see tests/e2e/docker/):
//   docker run --rm --cpus=4 --memory=3g --ulimit core=0 --name ppm-task-schedule-script \
//     -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules -v <out>:/out -v <web>:/web -w /app \
//     -e IS_SANDBOX=1 -e PPM_SCHED_ARTIFACTS=/out -e PPM_SCHED_WEB_DIR=/web ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/schedule-script-proposals-e2e.mjs'
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createKit, pageInit } from "./fixtures/session-turn-refs-helpers.mjs";
import { schedKit } from "./fixtures/session-schedules-steps.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-sched-script-e2e-"));
const artifacts = process.env.PPM_SCHED_ARTIFACTS ? resolve(process.env.PPM_SCHED_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
await Promise.all([artifacts, ppm, home, projects].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}
const webDir = process.env.PPM_SCHED_WEB_DIR ? resolve(process.env.PPM_SCHED_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir, "--emptyOutDir"]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_SCHED_WEB_DIR: webDir, PPM_SCHED_PROJECTS: projects, TZ: process.env.TZ ?? "Asia/Saigon",
};
delete env.PPM_ALLOW_PROD_DB;

const WATCH_MESSAGE = "Review-queue watch: 1 item new since the last check.";
const SCRIPT = [
  "// Wakes the review chat once, on its first run; later runs only log.",
  "export default async function main(ctx) {",
  "  const n = (ctx.state.n ?? 0) + 1;",
  "  ctx.state = { n };",
  "  ctx.log(`tick ${n}`);",
  "  if (n > 1) return;",
  `  const res = await ctx.ai.chat("review-queue", ${JSON.stringify(WATCH_MESSAGE)}, { sessionId: ctx.inputs.sessionId, wait: false });`,
  "  if (!res.ok && !res.busy) throw new Error(res.error ?? \"could not reach the chat\");",
  "}",
  "",
].join("\n");

let serverLog = "";
const child = spawn("bun", ["tests/e2e/fixtures/session-schedules-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (s) => serverLog += s); child.stderr.on("data", (s) => serverLog += s);
console.log(`fixture server started, pid ${child.pid}`);

const ctx = { current: null };
const kit = createKit({ web, artifacts, currentPage: () => ctx.current });
const sk = schedKit(kit, web);
const { until, scenario, failures } = kit;
const passed = [];
const ok = (name) => { passed.push(name); console.log(`PASS ${name}`); };
const started = Date.now();
let browser;

/** The answer of the newest call of `tool` by `sessionId` once it returned. */
const answered = (sessionId, tool, after = 0) => until(`${tool} answered`, async () =>
  (await sk.calls()).filter((c) => c.sessionId === sessionId && c.tool === tool && c.seq >= after && c.text !== undefined).at(-1), 60000, 200);
const card = (page) => page.locator('[data-collab-approval="schedule"]:visible').first();

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`, { headers: { Connection: "close" } })).ok, 90000, 300);
  const { alpha } = await sk.route("/project");
  await kit.post("/api/projects", { name: "alpha", path: alpha });
  const A = await sk.newSession("Review queue manager");
  const B = await sk.newSession("QL Review PR");
  const C = await sk.newSession("Another chat");

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(pageInit);
  const page = ctx.current = await desktop.newPage();
  let scheduleId = null;

  await scenario("a: propose, see the whole card, allow, and the schedule exists and runs", async () => {
    await sk.plan(A.id, { steps: [
      { say: "I will propose a script that wakes the review chat only when the queue changes." },
      { call: "session_schedule_propose_script", args: {
        name: "review-queue-watch", description: "Checks the queue every 5 seconds and messages the review chat once.",
        cron: "*/5 * * * * *", timezone: "Europe/London", script: SCRIPT, timeoutMinutes: 2, permissionMode: "default",
        inputs: [{ key: "sessionId", label: "Review chat (session id)", type: "text", required: true }],
        inputValues: { sessionId: B.id },
      } },
      { say: "Done." },
    ] });
    await sk.open(page, A);
    await sk.send(page, "Replace the 15-minute check with a script schedule.");
    await card(page).waitFor({ timeout: 30000 });
    const text = await card(page).innerText();
    for (const part of ["review-queue-watch", "*/5 * * * * *", "Europe/London", "Next 3 runs", "2 minutes per run", alpha, "QL Review PR", WATCH_MESSAGE, "Nobody watches this"]) {
      assert(text.includes(part), `the card shows ${part}`);
    }
    assert.equal(await card(page).locator("button").filter({ hasText: "Allow once" }).count(), 1);
    await card(page).screenshot({ path: join(artifacts, "card-desktop-1440.png") });
    await page.screenshot({ path: join(artifacts, "chat-desktop-1440.png") });
    ok("a1 the card shows the script, folder, cron with zone, next runs, timeout and the chat it messages");

    // The same waiting card on a phone.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await phone.addInitScript(pageInit);
    const p2 = await phone.newPage();
    await sk.open(p2, A);
    await card(p2).waitFor({ timeout: 30000 });
    await p2.screenshot({ path: join(artifacts, "chat-phone-390.png") });
    await card(p2).screenshot({ path: join(artifacts, "card-phone-390.png") });
    await phone.close();
    ok("a2 the card shows on a phone");

    // b: the card as Telegram would get it.
    const tg = (await sk.route(`/telegram-card?sessionId=${A.id}`)).card;
    assert(tg, "the chat's live state carries the card");
    assert.equal(tg.allow, false, "Telegram never offers Allow on a script schedule card");
    assert.deepEqual(tg.buttons, ["Deny", "Open in PPM"]);
    const tgPage = await desktop.newPage();
    await tgPage.setViewportSize({ width: 430, height: 900 });
    await tgPage.setContent(`<html><body style="margin:0;background:#8aa5c4;font:15px -apple-system,Segoe UI,sans-serif">
      <div style="max-width:400px;margin:16px auto;background:#fff;border-radius:12px;padding:10px 12px;white-space:pre-wrap;word-break:break-word">${tg.html.replace(/<pre><code class="language-\w+">/g, "<pre style=\"white-space:pre-wrap;background:#f2f2f2;padding:6px;border-radius:6px\"><code>").replace(/<pre>/g, "<pre style=\"white-space:pre-wrap;background:#f2f2f2;padding:6px;border-radius:6px\">")}</div>
      <div style="max-width:400px;margin:4px auto;display:flex;gap:6px">${tg.buttons.map((b) => `<div style="flex:1;text-align:center;background:rgba(0,0,0,.25);color:#fff;border-radius:8px;padding:9px">${b}</div>`).join("")}</div>
      </body></html>`);
    await tgPage.screenshot({ path: join(artifacts, "card-telegram-simulated.png"), fullPage: true });
    await tgPage.close();
    await writeFile(join(artifacts, "card-telegram.json"), JSON.stringify(tg, null, 2));
    ok("b the Telegram card offers Deny and Open in PPM, never Allow");

    const before = (await sk.calls()).length;
    await card(page).locator("button").filter({ hasText: "Allow once" }).click();
    const call = await answered(A.id, "session_schedule_propose_script");
    assert.equal(call.isError, false, call.text);
    const created = JSON.parse(call.text);
    assert.equal(created.created, true);
    scheduleId = created.schedule.id;
    const row = await sk.stored(scheduleId);
    assert.equal(row.kind, "script");
    assert.equal(row.script, SCRIPT, "the stored script is the one the card showed, byte for byte");
    assert.equal(row.timezone, "Europe/London");
    assert.equal(row.cron_expr, "*/5 * * * * *");
    assert.equal(row.project_path, alpha);
    assert.equal(row.enabled, 1);
    assert.deepEqual(JSON.parse(row.input_values_json), { sessionId: B.id });
    ok(`a3 allowed: schedule ${scheduleId} exists exactly as shown (calls before ${before})`);

    const runs = await until("a finished run", async () => {
      const list = await sk.runs(scheduleId);
      return list.find((r) => r.status === "done") ? list : null;
    }, 60000, 500);
    await until("the watch message reached the review chat", async () => (await sk.sendsOf(B.id, WATCH_MESSAGE)).length === 1, 60000, 300);
    ok(`a4 it runs: ${runs.length} run(s), first ${runs.at(-1).status}; its message reached "${B.title}" once`);
  });

  await scenario("c: propose, deny, and nothing is created", async () => {
    const count = (await kit.api("/api/schedules")).data.length;
    await sk.plan(C.id, { steps: [
      { call: "session_schedule_propose_script", args: { name: "denied-watch", cron: "0 */1 * * * *", script: "export default async (ctx) => ctx.log(1);\n" } },
    ] });
    await sk.open(page, C);
    await sk.send(page, "Propose a script that I will refuse.");
    await card(page).waitFor({ timeout: 30000 });
    await page.screenshot({ path: join(artifacts, "deny-before.png") });
    await card(page).locator("button").filter({ hasText: "Deny" }).click();
    const call = await answered(C.id, "session_schedule_propose_script");
    assert.equal(call.isError, true);
    assert.match(call.text, /No schedule was created/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await kit.api("/api/schedules")).data.length, count, "no schedule was added");
    assert.equal((await kit.api("/api/schedules")).data.some((s) => s.name === "denied-watch"), false);
    ok("c denied: the call says nothing was created and no schedule exists");
  });

  await scenario("e: propose from a .ppm-schedule.json carrying `values`; the card shows them, the tool's own win", async () => {
    await sk.idle(C.id);
    const file = join(alpha, "plans", "review-queue-watch.ppm-schedule.json");
    await mkdir(join(alpha, "plans"), { recursive: true });
    await writeFile(file, await readFile("tests/fixtures/schedule-proposals/review-queue-watch.ppm-schedule.json"));
    const count = (await kit.api("/api/schedules")).data.length;
    await sk.plan(C.id, { steps: [{ call: "session_schedule_propose_script", args: { file, timezone: "Europe/London", inputValues: { days: "7" } } }] });
    await sk.open(page, C);
    await sk.send(page, "Set up the review-queue watch from the file in plans.");
    await card(page).waitFor({ timeout: 30000 });
    const text = await card(page).innerText();
    for (const part of [file, "File SHA-256", "11111111-2222-4333-8444-555555555555", "find_review_queue.py", '"7"', "0 */5 * * * *"]) {
      assert(text.includes(part), `the card shows ${part}`);
    }
    await card(page).screenshot({ path: join(artifacts, "card-from-file-values-1440.png") });
    await card(page).locator("button").filter({ hasText: "Deny" }).click();
    const call = await answered(C.id, "session_schedule_propose_script");
    assert.equal(call.isError, true);
    assert.equal((await kit.api("/api/schedules")).data.length, count);
    ok("e a file with values is read as written; its values and the tool's override show on the card");
  });

  await scenario("d: pause the script at once with no card; turning it on asks", async () => {
    assert(scheduleId, "scenario a created a schedule");
    await sk.idle(A.id);
    const from = (await sk.calls()).length;
    await sk.plan(A.id, { steps: [{ call: "session_schedule_set_enabled", args: { id: scheduleId, enabled: false } }, { say: "Paused it." }] });
    await sk.open(page, A);
    await sk.send(page, "Pause the review-queue watch for now.");
    const call = await answered(A.id, "session_schedule_set_enabled", from);
    assert.equal(call.isError, false, call.text);
    const out = JSON.parse(call.text);
    assert.deepEqual(out.paused, { id: scheduleId, name: "review-queue-watch", kind: "script", project: "alpha" });
    assert.match(out.note, new RegExp(`Paused schedule #${scheduleId} "review-queue-watch" \\(script\\)`));
    assert.equal((await sk.stored(scheduleId)).enabled, 0);
    assert.equal(await card(page).count(), 0, "no card was shown for a pause");
    ok("d1 paused at once, no card, and the answer names the schedule");

    await sk.idle(A.id);
    const from2 = (await sk.calls()).length;
    await sk.plan(A.id, { steps: [{ call: "session_schedule_set_enabled", args: { id: scheduleId, enabled: true } }] });
    await sk.send(page, "Turn the watch back on.");
    await card(page).waitFor({ timeout: 30000 });
    const text = await card(page).innerText();
    assert.match(text, /turn on a schedule/i);
    assert(text.includes("Script (runs exactly as shown)"), "turning a script on shows the script");
    await card(page).screenshot({ path: join(artifacts, "resume-card-desktop-1440.png") });
    await card(page).locator("button").filter({ hasText: "Deny" }).click();
    const again = await answered(A.id, "session_schedule_set_enabled", from2);
    assert.equal(again.isError, true);
    assert.equal((await sk.stored(scheduleId)).enabled, 0);
    ok("d2 turning it on shows a card with the script; denied, it stays paused");
  });

  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  try { await ctx.current?.screenshot({ path: join(artifacts, "failure.png") }); } catch { /* page gone */ }
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  console.log(`fixture server pid ${child.pid} stopped`);
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ passed, failures }, null, 2));
  console.log(`${passed.length} checks passed, ${failures.length} scenario(s) failed in ${Math.round((Date.now() - started) / 1000)} s; artifacts in ${artifacts}`);
}
