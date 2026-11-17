// The task quick view, compact: its fields as chips that edit in place, the next step folded, and
// the task's links with their live state, folded into "+N" past four. A task with every field set
// and six links of every kind (two Jira keys, two PRs, a Slack URL, a chat), each with the state the
// link checker would have left, opened from the manager chat's Tasks list at 1440 and 800 and in
// the phone's sheet at 390. The production Vite bundle against the disposable server of
// tests/e2e/ppm-tasks-e2e.mjs.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> PPM_PEEK_SHOT_TAG=after node tests/e2e/task-peek-compact-e2e.mjs
//
// PPM_PEEK_SHOT_TAG names the screenshots (`before-…`, `after-…`). With `before` it only takes them,
// so the same scene can be shot on a build from before the change; with `after` (the default) it
// also checks: six chips, the popover on screen and nothing overflowing sideways at each width, a
// chip's menu editing its field, "+2" showing every link, a chat link opening the chat, and on the
// phone a 32 px chip that takes a press 6 px above it (a 44 px target).
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`).
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit, until } from "./ppm-tasks/tasks-kit.mjs";
import { dayFromNow, seedDemo } from "./ppm-tasks/tasks-seed.mjs";

const TAG = process.env.PPM_PEEK_SHOT_TAG ?? "after";
const CHECK = TAG !== "before";
const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-peek-compact-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs)].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const JIRA_SITE = "https://jira.example.com";
const TITLE = "Merge data of 4 COM perm pairs into temp (ACS, Accept, Start People, SG Personnel)";
const NEXT_STEP = "Reported in the main Slack thread that SG is merged too (Andy asked for a progress update). Then: ask whether the remaining two pairs can go in the same run, or wait for the export fix on Monday before touching them.";
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const chatUrl = (s) => `${web}/project/alpha/chat/claude/${s.managers.alpha}`;
const rowOpen = (page, id) => page.locator(`[data-chip-task="${id}"] [data-chip-task-open]:visible`);
const shot = (page, name) => page.screenshot({ path: join(shotsDir, `${TAG}-${name}.png`) });
/** The quick view alone, with a margin of the page around it. */
async function shotOf(page, loc, name, pad = 16) {
  const b = await box(loc);
  const vw = page.viewportSize();
  const x = Math.max(0, b.left - pad), y = Math.max(0, b.top - pad);
  await page.screenshot({ path: join(shotsDir, `${TAG}-${name}.png`), clip: { x, y, width: Math.min(vw.width - x, b.width + 2 * pad), height: Math.min(vw.height - y, b.height + 2 * pad) } });
}

async function openList(page, tap = false) {
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await (tap ? chip.tap() : chip.click());
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
}

/** Six chips, their labels, the popover inside the viewport and nothing in it wider than it. */
async function checkCompact(page, peek, width, height) {
  const chips = await peek.locator("[data-task-peek-chip]").evaluateAll((els) => els.map((e) => e.getAttribute("data-task-peek-chip")));
  assert.deepEqual(chips, ["status", "urgency", "importance", "assignee", "waiting", "due"], "six chips");
  const rows = await peek.locator("[data-task-peek-chip]").evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
  assert(rows <= 2, `the chips take ${rows} rows, want at most 2`);
  const pb = await box(peek);
  assert(pb.left >= 0 && pb.top >= 0 && pb.right <= width + 0.5 && pb.bottom <= height + 0.5, `on screen at ${width}: ${JSON.stringify(pb)}`);
  const sideways = await peek.evaluate((el) => [el, ...el.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== "visible" && !e.matches("[data-link-kind] *, [data-link-kind]")).map((e) => e.outerHTML.slice(0, 80)));
  assert.deepEqual(sideways, [], `nothing scrolls sideways at ${width}`);
  const folded = await peek.locator("[data-task-peek-next-step-text]").evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  assert(folded <= 2.05, `the next step is folded to two lines (${folded.toFixed(2)})`);
  return { rows, height: Math.round(pb.height), width: Math.round(pb.width) };
}

async function desktopAt(k, s, width, height) {
  const page = width === 1440 ? k.use(k.desktop) : await k.openDesktopAt(width, height);
  await page.goto(chatUrl(s));
  await openList(page);
  await rowOpen(page, s.full.id).click();
  const peek = page.locator(`[data-task-peek-popover="${s.full.id}"]`);
  await peek.waitFor({ timeout: 15000 });
  await peek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await until("the popover is placed", async () => (await peek.getAttribute("data-task-peek-side")) !== null, 10000);
  await shot(page, `${width}-page`);
  await shotOf(page, peek, `${width}-popover`);
  if (!CHECK) return record(String(width), "shots taken");
  const layout = await checkCompact(page, peek, width, height);
  const chipH = Math.round((await box(peek.locator("[data-task-peek-chip=status]"))).height);
  assert(chipH >= 27 && chipH <= 29, `a chip is 28 px (${chipH})`);

  // Links: three and "+3", each with its state; "+3" shows all six.
  assert.equal(await peek.locator("[data-task-peek-links] [data-link-kind]").count(), 3);
  assert.equal(await peek.locator("[data-task-peek-links-more]").innerText(), "+3");
  assert.match(await peek.locator("[data-task-peek-links] [data-link-kind=jira]").first().innerText(), /In Review/);
  assert.equal(await peek.locator("[data-task-peek-links] [data-link-kind=jira]").first().getAttribute("href"), `${JIRA_SITE}/browse/AL-6284`);
  if (width === 1440) {
    await peek.locator("[data-task-peek-links-more]").click();
    assert.equal(await peek.locator("[data-task-peek-links] [data-link-kind]").count(), 6);
    await page.waitForTimeout(300);
    await shotOf(page, peek, `${width}-links-expanded`);
    const after = await box(peek);
    assert(after.bottom <= height + 0.5, "still on screen with every link shown");

    // A chip's menu edits its field where it is.
    await peek.locator("[data-task-peek-chip=urgency]").click();
    const menu = page.locator("[data-task-peek-menu=urgency]");
    await menu.waitFor({ timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(page, `${width}-chip-menu-page`);
    const mb = await box(menu);
    const pb = await box(peek);
    await page.screenshot({ path: join(shotsDir, `${TAG}-${width}-chip-menu.png`), clip: { x: pb.left - 16, y: pb.top - 16, width: Math.max(pb.right, mb.right) - pb.left + 32, height: Math.max(pb.bottom, mb.bottom) - pb.top + 32 } });
    await menu.locator("[data-task-peek-choice=now]").click();
    await until("the urgency is saved", async () => (await k.task(s.full.id)).urgency === "now", 15000);
    assert.equal(await peek.count(), 1, "picking from the menu leaves the quick view open");
    await until("the chip shows the saved urgency", async () => (await peek.locator("[data-task-peek-chip=urgency]").getAttribute("title")) === "Urgency: Now", 10000);
    // Back to Today, so the phone's shots show the task as the 1440 ones did.
    await peek.locator("[data-task-peek-chip=urgency]").click();
    await page.locator("[data-task-peek-menu=urgency] [data-task-peek-choice=today]").click();
    await until("the urgency is saved again", async () => (await k.task(s.full.id)).urgency === "today", 15000);

    // Due's menu: a date it offers saves at once (then the seeded date is put back for the phone's shots).
    const dueBefore = (await k.task(s.full.id)).dueDate;
    await peek.locator("[data-task-peek-chip=due]").click();
    const dueMenu = page.locator("[data-task-peek-menu=due]");
    await dueMenu.waitFor({ timeout: 5000 });
    assert.deepEqual(await dueMenu.locator("[data-task-peek-choice]").evaluateAll((els) => els.map((e) => e.getAttribute("data-task-peek-choice"))), ["Today", "Tomorrow", "In a week", "pick", "none"]);
    await dueMenu.locator("[data-task-peek-choice=Tomorrow]").click();
    await until("the due date picked from the menu is saved", async () => (await k.task(s.full.id)).dueDate === dayFromNow(1), 15000);
    await until("the chip shows it", async () => /Tomorrow/.test(await peek.locator("[data-task-peek-chip=due]").innerText()), 10000);
    const t = await k.task(s.full.id);
    assert.equal((await k.patch(s.full.id, { revision: t.revision, dueDate: dueBefore })).ok, true);
    await until("the seeded due date is back", async () => (await k.task(s.full.id)).dueDate === dueBefore, 15000);

    // The folded next step unfolds into its field and folds back once left.
    await peek.locator("[data-task-peek-next-step]").click();
    const field = peek.locator("textarea[aria-label='Next step']");
    assert.equal(await field.evaluate((el) => el === document.activeElement), true, "the unfolded next step takes the cursor");
    await field.fill(`${NEXT_STEP} Done by Friday.`);
    await peek.locator("[data-task-peek-title]").click();
    await until("the next step is saved", async () => (await k.task(s.full.id)).nextStep === `${NEXT_STEP} Done by Friday.`, 15000);
    assert.equal(await field.count(), 0, "folded again once left");

    // A chat link opens the chat, as on the task page.
    await page.locator(`[data-task-peek-popover="${s.full.id}"] [data-task-peek-links] button[data-link-kind=session]`).click();
    await until("the quick view closed for the chat", async () => (await page.locator("[data-task-peek-popover]").count()) === 0, 5000);
  }
  record(String(width), `six chips in ${layout.rows} rows, on screen (${layout.width}×${layout.height}), 3 links + "+3"${width === 1440 ? ", +3 shows six, urgency menu saves, Due menu saves, next step unfolds and saves, chat link opens the chat" : ""}`, layout);
}

async function phoneAt(k, s, width) {
  const page = await k.openPhone(width, 844);
  await page.goto(chatUrl(s));
  await openList(page, true);
  await rowOpen(page, s.full.id).tap();
  const sheet = page.locator(`[data-task-peek="${s.full.id}"][data-task-peek-layout="sheet"]:visible`);
  await sheet.waitFor({ timeout: 15000 });
  await sheet.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, `${width}-sheet`);
  if (!CHECK) return record(`phone-${width}`, "shots taken");
  const layout = await checkCompact(page, sheet, width, 844);
  const status = sheet.locator("[data-task-peek-chip=status]");
  const sb = await box(status);
  assert(sb.height >= 31 && sb.height <= 33, `a chip is 32 px on a phone (${sb.height})`);
  // The chip takes a press 6 px above and below it: a 44 px target.
  // Measured and probed in one go: the sheet may still be settling between two round trips.
  const reach = await status.evaluate((chip) => {
    const r = chip.getBoundingClientRect();
    return [r.top - 5.5, r.bottom + 5.5].map((y) => {
      const hit = document.elementFromPoint(r.left + r.width / 2, y);
      return hit?.closest("[data-task-peek-chip=status]") ? "status" : (hit?.outerHTML ?? "nothing").slice(0, 120);
    });
  });
  assert.deepEqual(reach, ["status", "status"], "the status chip takes presses 5.5 px above and below it (a 44 px target)");
  await sheet.locator("[data-task-peek-links-more]").scrollIntoViewIfNeeded();
  await sheet.locator("[data-task-peek-links-more]").tap();
  assert.equal(await sheet.locator("[data-task-peek-links] [data-link-kind]").count(), 6);
  await page.waitForTimeout(300);
  await shot(page, `${width}-sheet-links-expanded`);
  await status.scrollIntoViewIfNeeded();
  await status.tap();
  const menu = page.locator("[data-task-peek-menu=status]");
  await menu.waitFor({ timeout: 5000 });
  const rowH = Math.round((await box(menu.locator("[role=menuitemradio]").first())).height);
  assert(rowH >= 44, `a menu row is 44 px on a phone (${rowH})`);
  await page.waitForTimeout(250);
  await shot(page, `${width}-sheet-chip-menu`);
  // A tap on a choice saves it, and the sheet stays on the task (the menu sits outside the sheet's
  // panel in the page, inside it in React, so the tap does not reach the sheet's backdrop).
  const todo = (await k.settings("alpha")).statuses.find((x) => x.baseGroup === "not_started");
  await menu.locator(`[data-task-peek-choice="${todo.id}"]`).tap();
  await until("the status picked on the phone is saved", async () => (await k.task(s.full.id)).statusId === todo.id, 15000);
  await until("the menu closed", async () => (await menu.count()) === 0, 5000);
  assert.equal(await sheet.count(), 1, "the sheet still shows the task");
  record(`phone-${width}`, `six chips in ${layout.rows} rows, 32 px chip with a 44 px target, ${rowH} px menu rows, nothing sideways; +3 shows six; a tapped choice saves`, { ...layout, chip: sb.height, rowH });
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
  const statuses = (await kit.settings("alpha")).statuses;
  const active = statuses.find((x) => x.baseGroup === "active");
  const created = await kit.createTask({
    project: "alpha", title: TITLE, urgency: "today", importance: "must", dueDate: dayFromNow(3), nextStep: NEXT_STEP,
    assigneeMemberId: "me", waitingOnMemberId: "me",
    links: [
      { kind: "jira", ref: "AL-6284" },
      { kind: "pr", ref: "alpha/beta-backend#11195" },
      { kind: "pr", ref: "alpha/beta-frontend#2424" },
      { kind: "url", ref: "https://acme.slack.com/archives/C0123/p1763390000" },
      { kind: "session", ref: s.managers.alpha, label: "alpha manager" },
      { kind: "jira", ref: "AL-6290" },
    ],
  });
  if (active) assert.equal((await kit.patch(created.id, { revision: created.revision, statusId: active.id })).ok, true, "the task is in progress");
  await fx.post("/__assistant-test/tasks/link-world", {
    projectPath: dirs.alpha, jiraBaseUrl: `${JIRA_SITE}/`,
    states: [
      { kind: "jira", ref: "AL-6284", state: { status: "In Review", category: "indeterminate", assignee: null, updated: null, summary: "Merge the COM perm pairs" } },
      { kind: "pr", ref: "alpha/beta-backend#11195", state: { state: "open", checks: { total: 4, failing: 0, pending: 1 } } },
      { kind: "pr", ref: "alpha/beta-frontend#2424", state: { state: "merged", checks: { total: 3, failing: 0, pending: 0 } } },
      { kind: "jira", ref: "AL-6290", state: { status: "Done", category: "done", assignee: null, updated: null, summary: "Temp table for SG" } },
    ],
  });
  s.full = await kit.task(created.id);
  assert.equal(s.full.links.length, 6, "six links");
  await kit.openDesktop();
  const steps = [["1440", (k, x) => desktopAt(k, x, 1440, 900)], ["800", (k, x) => desktopAt(k, x, 800, 900)], ["390", (k, x) => phoneAt(k, x, 390)]];
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
  await writeFile(join(shotsDir, `${TAG}-results.json`), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
