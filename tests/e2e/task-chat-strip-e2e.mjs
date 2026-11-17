// The task strip at the top of a chat that works on tasks, and what such a chat may do with the
// task tools. The production Vite bundle against the disposable server of tests/e2e/ppm-tasks-e2e.mjs
// (scripted provider, neutral demo data: alpha and beta with a manager chat each).
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> node tests/e2e/task-chat-strip-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`). Two chats of alpha are
// handed tasks: "Reply worker" one (Waiting on you), "Login worker" three. Checks, at 1440: the
// strip shows "#N title", the wait or status and the due date; a press opens the quick view under
// the strip; "+2" lists the three tasks and a row opens that one; a chat with no task has no strip.
// At 800, 390 and 320: one line, nothing overflows sideways, the phone opens the quick view and the
// list as sheets. Heights follow docs/design-guidelines.md rule 3 (28 / 26 px). Then the working chat
// tries to close its task (refused, naming the manager and propose_close), proposes closing instead
// (the task stays open, the manager is told), and the manager closes it.
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit, until } from "./ppm-tasks/tasks-kit.mjs";
import { seedDemo } from "./ppm-tasks/tasks-seed.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-strip-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

/** A button with text: 28 px on a desktop, 26 px on a phone, ±1 px. */
const TEXT = (onPhone) => (onPhone ? [25, 27] : [27, 29]);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });

async function heightOf(loc, [min, max], what) {
  await loc.waitFor({ timeout: 15000 });
  const h = Math.round((await box(loc)).height * 10) / 10;
  assert(h >= min && h <= max, `${what}: ${h}px, want ${min}–${max}`);
  return h;
}

const chatUrl = (k, project, id) => `${k.web}/project/${project}/chat/claude/${id}`;
const strip = (page) => page.locator("[data-chat-task-strip]:visible").first();

/** Nothing in the strip spills sideways, and it is one line. */
async function fits(page, width) {
  const s = strip(page);
  const m = await s.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, doc: document.documentElement.scrollWidth }));
  assert(m.scroll <= m.client + 1, `the strip does not overflow at ${width}: ${JSON.stringify(m)}`);
  assert(m.doc <= width + 1, `the page does not scroll sideways at ${width}: ${JSON.stringify(m)}`);
  assert(m.height <= 40, `one line at ${width}: ${m.height}px`);
  return m;
}

/** Two chats of alpha with tasks: one with the reply task waiting on the user, one with three. */
async function handOut(k, s) {
  const chat = async (title) => (await k.fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title })).data.id;
  const hand = async (task, sessionId, extra = {}) => {
    const t = await k.task(task.id);
    const r = await k.patch(t.id, { revision: t.revision, workingSessionId: sessionId, ...extra });
    assert.equal(r.ok, true, JSON.stringify(r.body));
  };
  const statuses = (await k.settings("alpha")).statuses;
  const waiting = statuses.find((x) => x.baseGroup === "waiting");
  const active = statuses.find((x) => x.baseGroup === "active");
  s.replyChat = await chat("Reply worker");
  s.loginChat = await chat("Login worker");
  s.idleChat = await chat("Notes");
  await hand(s.t.reply, s.replyChat, { statusId: waiting.id, waitingOnMemberId: "me" });
  await hand(s.t.login, s.loginChat, { statusId: active.id });
  await hand(s.t.release, s.loginChat, { statusId: active.id });
  await hand(s.t.review, s.loginChat);
  // A chat page only shows a session once something was said in it: one scripted turn each.
  for (const [id, text] of [[s.replyChat, "Draft the reply"], [s.loginChat, "Fix the login timeout"], [s.idleChat, "Take notes"]]) {
    await k.script(`hello-${id}`, [{ text: "On it." }], { match: text, sessionId: id });
    await k.say("alpha", id, text);
    await k.idle(id);
  }
}

async function desktop(k, s) {
  const page = k.use(k.desktop);
  await page.goto(chatUrl(k, "alpha", s.replyChat));
  const one = strip(page);
  await one.waitFor({ timeout: 30000 });
  assert.equal(await one.getAttribute("data-chat-task-strip-count"), "1");
  const reply = await k.task(s.t.reply.id);
  assert.match(await one.innerText(), new RegExp(`#${reply.number}\\s*${reply.title.slice(0, 20)}`));
  assert.equal(await one.locator("[data-task-waiting=me]").count(), 1, "waiting on you, instead of the status");
  assert.equal(await one.locator("[data-chat-task-strip-more]").count(), 0, "no +N for one task");
  const heights = { open: await heightOf(one.locator("[data-chat-task-strip-open]"), TEXT(false), "the strip's task button") };
  await fits(page, 1440);
  await k.shot("01-strip-one-task-1440");
  await one.locator("[data-chat-task-strip-open]").click();
  const peek = page.locator(`[data-task-peek-popover="${reply.id}"]`);
  await peek.waitFor({ timeout: 15000 });
  await until("the quick view is placed", async () => (await peek.getAttribute("data-task-peek-side")) !== null, 10000);
  const [sb, pb] = [await box(one), await box(peek)];
  assert(pb.top >= sb.bottom - 1, `the quick view opens under the strip (${pb.top} < ${sb.bottom})`);
  assert(pb.left >= 0 && pb.right <= 1440 && pb.bottom <= 900, `on screen: ${JSON.stringify(pb)}`);
  await peek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await k.shot("02-strip-quick-view-1440");
  await page.keyboard.press("Escape");
  await until("the quick view closed", async () => (await page.locator("[data-task-peek-popover]").count()) === 0, 5000);

  await page.goto(chatUrl(k, "alpha", s.loginChat));
  const many = strip(page);
  await many.waitFor({ timeout: 30000 });
  assert.equal(await many.getAttribute("data-chat-task-strip-count"), "3");
  const login = await k.task(s.t.login.id);
  assert.equal(await many.locator("[data-chat-task-strip-title]").innerText(), login.title, "the most urgent task leads");
  const more = many.locator("[data-chat-task-strip-more]");
  assert.equal((await more.innerText()).trim(), "+2");
  heights.more = await heightOf(more, TEXT(false), "+N");
  await fits(page, 1440);
  await k.shot("03-strip-three-tasks-1440");
  await more.click();
  const rows = page.locator("[data-chat-task-strip-row]:visible");
  await rows.first().waitFor({ timeout: 10000 });
  assert.equal(await rows.count(), 3);
  heights.row = await heightOf(rows.first().locator("button"), TEXT(false), "a row of the +N list");
  await k.shot("04-strip-more-list-1440");
  const review = await k.task(s.t.review.id);
  await page.locator(`[data-chat-task-strip-row="${review.id}"] button`).click();
  const reviewPeek = page.locator(`[data-task-peek-popover="${review.id}"]`);
  await reviewPeek.waitFor({ timeout: 15000 });
  await reviewPeek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await k.shot("05-strip-row-quick-view-1440");
  await page.keyboard.press("Escape");

  await page.goto(chatUrl(k, "alpha", s.idleChat));
  await page.locator("[data-chat-footer]:visible").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator("[data-chat-task-strip]").count(), 0, "a chat with no task has no strip");
  record("1440", "one task: #N title, Waiting on you, quick view under the strip; three: the most urgent leads, +2 lists all, a row opens that task; no task: no strip", { heights });
}

async function desktop800(k, s) {
  const page = await k.openDesktopAt(800, 900);
  await page.goto(chatUrl(k, "alpha", s.loginChat));
  await strip(page).waitFor({ timeout: 30000 });
  const m = await fits(page, 800);
  const heights = { open: await heightOf(strip(page).locator("[data-chat-task-strip-open]"), TEXT(false), "task button"), more: await heightOf(strip(page).locator("[data-chat-task-strip-more]"), TEXT(false), "+N") };
  await strip(page).locator("[data-chat-task-strip-open]").click();
  const peek = page.locator(`[data-task-peek-popover="${s.t.login.id}"]`);
  await peek.waitFor({ timeout: 15000 });
  await peek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  const pb = await box(peek);
  assert(pb.left >= 0 && pb.right <= 800 && pb.bottom <= 900, `on screen at 800: ${JSON.stringify(pb)}`);
  await k.shot("06-strip-quick-view-800");
  record("800", "one line, nothing overflows, quick view on screen", { heights, strip: m });
}

async function phoneFlow(k, s, width) {
  const page = await k.openPhone(width, width === 320 ? 640 : 844);
  await page.goto(chatUrl(k, "alpha", s.loginChat));
  const st = strip(page);
  await st.waitFor({ timeout: 30000 });
  const m = await fits(page, width);
  const heights = { open: await heightOf(st.locator("[data-chat-task-strip-open]"), TEXT(true), "task button"), more: await heightOf(st.locator("[data-chat-task-strip-more]"), TEXT(true), "+N") };
  // The BETA ribbon takes the top-right 40px square on a phone: "+N" must not sit under it.
  const mb = await box(st.locator("[data-chat-task-strip-more]"));
  assert(mb.right <= width - 40 || mb.top >= 40, `+N clear of the BETA ribbon at ${width}: ${JSON.stringify(mb)}`);
  if (width === 390) await k.shot("07-strip-390");
  else await k.shot(`07-strip-${width}`);
  await st.locator("[data-chat-task-strip-open]").tap();
  const sheet = page.locator(`[data-task-peek="${s.t.login.id}"][data-task-peek-layout="sheet"]:visible`);
  await sheet.waitFor({ timeout: 15000 });
  const fit = await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert(fit, `the sheet does not overflow at ${width}`);
  await page.waitForTimeout(500);
  await k.shot(`08-strip-sheet-${width}`);
  await page.keyboard.press("Escape").catch(() => {});
  await page.goto(chatUrl(k, "alpha", s.loginChat));
  await strip(page).waitFor({ timeout: 30000 });
  await strip(page).locator("[data-chat-task-strip-more]").tap();
  const rows = page.locator("[data-chat-task-strip-row]:visible");
  await rows.first().waitFor({ timeout: 10000 });
  assert.equal(await rows.count(), 3);
  heights.row = await heightOf(rows.first().locator("button"), TEXT(true), "a row of the +N list");
  await page.waitForTimeout(400);
  await k.shot(`09-strip-more-sheet-${width}`);
  record(`phone-${width}`, "one line, nothing overflows; tap opens the task's sheet; +N opens the list as a sheet", { heights, strip: m });
}

async function permissions(k, s) {
  const login = await k.task(s.t.login.id);
  const [closed] = await k.chatTurn("alpha", s.loginChat, "child-close", [{ session: "ppm_task_close", args: { task: login.ref, revision: login.revision, reason: "Fixed and merged.", as: "done" } }], "Close the login task");
  assert.equal(closed.isError, true, `the working chat may not close its task: ${closed.text}`);
  assert.match(closed.text, /manager chat/);
  assert.match(closed.text, /propose_close/);
  await k.idle(s.loginChat);
  const [due] = await k.chatTurn("alpha", s.loginChat, "child-due", [{ session: "ppm_task_update", args: { task: login.ref, revision: login.revision, reason: "Need more time.", due_date: "2099-01-01", urgency: "later" } }], "Push the login task back");
  assert.equal(due.isError, true, due.text);
  assert.match(due.text, /may not change urgency, due_date/);
  await k.idle(s.loginChat);
  const still = await k.task(login.id);
  assert.equal(still.baseGroup, "active", "still open");
  assert.equal(still.urgency, login.urgency, "urgency unchanged");
  const before = (await k.messages(s.managers.alpha)).length;
  const [proposed] = await k.chatTurn("alpha", s.loginChat, "child-propose", [{ session: "ppm_task_update", args: { task: login.ref, revision: still.revision, reason: "Retry with backoff merged; slow-network test passes.", result: "Merged the retry; the slow-path test passes.", propose_close: "done" } }], "Propose closing the login task");
  assert.equal(proposed.isError, false, proposed.text);
  assert.match(proposed.text, /Proposed closing/);
  await k.idle(s.loginChat);
  const after = await k.task(login.id);
  assert.equal(after.baseGroup, "active", "a proposal does not close the task");
  const history = await k.history(login.id);
  assert.equal(history[0].kind, "close_proposed");
  const told = await until("the manager is told of the proposal", async () => (await k.messages(s.managers.alpha)).slice(before).find((m) => /closing it as done proposed/.test(m.text)), 30000);
  await k.idle(s.managers.alpha);
  const [mgr] = await k.chatTurn("alpha", s.managers.alpha, "mgr-close", [{ session: "ppm_task_close", args: { task: after.ref, revision: after.revision, reason: "Checked the result and the PR.", as: "done" } }], "Close the login task after checking");
  assert.equal(mgr.isError, false, mgr.text);
  assert.equal((await k.task(login.id)).baseGroup, "closed");
  // The strip follows: login is closed, release now leads, "+1".
  const page = k.use(k.desktop);
  await page.goto(chatUrl(k, "alpha", s.loginChat));
  await until("the strip drops the closed task", async () => (await strip(page).getAttribute("data-chat-task-strip-count").catch(() => null)) === "2", 20000);
  await k.shot("10-strip-after-close-1440");
  record("permissions", "the working chat is refused closing and urgency/due date (manager and propose_close named); its proposal leaves the task open and reaches the manager; the manager closes it; the strip follows", { told: told.text.split("\n").find((l) => /proposed/.test(l)) });
}

try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
    PPM_ASSISTANT_MANAGER_LOOP: "1", PPM_ASSISTANT_TASKS: "1",
    PPM_ASSISTANT_FAKE_TELEGRAM: "1", PPM_TELEGRAM_API_BASE: fakeInfo.api, PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
    PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(OWNER), String(OWNER), "Phone"]]),
    PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "200", PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
  };
  delete env.PPM_ALLOW_PROD_DB;
  delete env.PPM_ASSISTANT_FIXTURE_RESUME;
  const b = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(logs, "fixture.log"), ready: /Assistant fixture ready/ });
  backend = b.child;
  await b.ready;
  const fx = fixtureApi(web);
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  kit = tasksKit({ web, fx, tg: phone(fakeInfo.control), browser, shotsDir, videoDir: null, owner: OWNER, record });
  const s = await seedDemo(kit, dirs);
  await handOut(kit, s);
  await kit.openDesktop();
  const steps = [["1440", desktop], ["800", desktop800], ["390", (k, x) => phoneFlow(k, x, 390)], ["320", (k, x) => phoneFlow(k, x, 320)], ["permissions", permissions]];
  for (const [id, run] of steps) {
    try {
      await run(kit, s);
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL ${id} ${error.stack ?? error}`);
      await kit.failureShots(id);
    }
  }
  const unexpected = kit.pageErrors().filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) failures.push({ step: "page-errors", error: unexpected.join("\n") });
} catch (error) {
  failures.push({ step: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  await kit?.closeAll().catch(() => []);
  await browser?.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (fake && fake.exitCode === null) fake.kill();
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
