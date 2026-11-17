// The chat's task quick view: a row of the manager chat's Tasks list shows the task beside the
// list (the list stays open) and edits it in place; a task chip in the composer shows the same;
// on a phone the list's own sheet turns into the task's page. The production Vite bundle against
// the disposable server of tests/e2e/ppm-tasks-e2e.mjs, with its neutral demo data (alpha, beta).
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_TASKS_SHOTS=<dir> [PPM_TASKS_VIDEO=<dir>] node tests/e2e/task-peek-e2e.mjs
//
// Runs on Node 20 in the ppm-e2e-chromium image (`--cpus=4 --memory=3g`). Checks, at 1440: a row
// opens the popover right of the list and the list stays; another row moves it; a status and a
// half-typed next step are saved; Escape closes the popover, then the list; Open in window opens
// the task's window and leaves the sidebar alone; the composer chip opens it above the chip. At
// 800: the popover flips (no room on the right) and stays on screen. At 390 and 320: the sheet
// turns into the task's page, back returns to the list, Full screen opens the task's tab. The
// buttons' heights follow docs/design-guidelines.md rule 3 (28 / 26 px text, 24 / 22 px icon).
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild } from "./assistant-telegram/harness.mjs";
import { tasksKit, until } from "./ppm-tasks/tasks-kit.mjs";
import { seedDemo } from "./ppm-tasks/tasks-seed.mjs";
import { cutVideo } from "./ppm-tasks/video-cut.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-task-peek-"));
const shotsDir = resolve(process.env.PPM_TASKS_SHOTS ?? join(sandbox, "shots"));
const videoDir = process.env.PPM_TASKS_VIDEO ? resolve(process.env.PPM_TASKS_VIDEO) : null;
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const dirs = { alpha: join(sandbox, "alpha"), beta: join(sandbox, "beta"), gamma: join(sandbox, "gamma") };
await Promise.all([shotsDir, logs, ppm, home, ...Object.values(dirs), ...(videoDir ? [videoDir] : [])].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
for (const [name, dir] of Object.entries(dirs)) await writeFile(join(dir, "README.md"), `# ${name}\n`);

const OWNER = 1001;
const results = [];
const failures = [];
const record = (id, name, detail = {}) => { results.push({ step: id, name, ...detail }); console.log(`PASS ${id} ${name}`); };
let fake, backend, browser, web, kit;

/** Heights for the page's width, ±1 px: a button with text 28 / 26, an icon button 24 / 22. */
const TEXT = (phone) => (phone ? [25, 27] : [27, 29]);
const ICON = (phone) => (phone ? [21, 23] : [23, 25]);

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });

/** The visible element's height, checked against `[min, max]`; answers it. */
async function heightOf(loc, [min, max], what) {
  await loc.waitFor({ timeout: 15000 });
  const h = Math.round((await box(loc)).height * 10) / 10;
  assert(h >= min && h <= max, `${what}: ${h}px, want ${min}–${max}`);
  return h;
}

const chatUrl = (k, s) => `${k.web}/project/alpha/chat/claude/${s.managers.alpha}`;
const list = (page) => page.locator("[data-manager-tasks-list]:visible");
const rowOpen = (page, id) => page.locator(`[data-chip-task="${id}"] [data-chip-task-open]:visible`);
const peekOf = (page, id) => page.locator(`[data-task-peek-popover="${id}"]`);

async function openList(page) {
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.click();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
}

async function desktop(k, s) {
  const page = k.use(k.desktop);
  await page.goto(chatUrl(k, s));
  await k.scene("p1", "A task from the chat, without leaving it", "A row of the Tasks list opens the task beside the list. The list stays open.");
  const sidebarBefore = await page.locator("[data-tasks-panel]:visible").count();
  assert.equal(sidebarBefore, 0, "the Tasks section of the sidebar is not on screen before (otherwise this check means nothing)");
  await openList(page);
  await k.shot("01-list-1440");

  const login = await k.task(s.t.login.id);
  const release = await k.task(s.t.release.id);
  await rowOpen(page, login.id).click();
  const peek = peekOf(page, login.id);
  await peek.waitFor({ timeout: 15000 });
  await until("the popover is placed", async () => (await peek.getAttribute("data-task-peek-side")) !== null, 10000);
  assert.equal(await list(page).count(), 1, "the list stays open");
  assert.equal(await peek.getAttribute("data-task-peek-side"), "right", "right of the list at 1440");
  const [lb, pb] = [await box(page.locator("[data-footer-popover]:visible").first()), await box(peek)];
  assert(pb.left >= lb.right, `the popover does not cover the list (${pb.left} < ${lb.right})`);
  assert.match(await peek.locator("[data-task-peek-title]").innerText(), new RegExp(`#${login.number}\\s*${login.title}`));
  const heights = {
    openChat: await heightOf(peek.locator("[data-task-peek-chat]"), TEXT(false), "Open chat"),
    openWindow: await heightOf(peek.locator("[data-task-peek-page]"), TEXT(false), "Open in window"),
    close: await heightOf(peek.locator("[data-task-peek-close]"), ICON(false), "×"),
  };
  await k.beat(1200);
  await k.shot("02-peek-right-of-list-1440");

  // Another row moves the popover to that task; there is only ever one.
  await rowOpen(page, release.id).click();
  await peekOf(page, release.id).waitFor({ timeout: 15000 });
  assert.equal(await page.locator("[data-task-peek-popover]").count(), 1);
  await k.beat(1000);
  await k.endScene();

  await k.scene("p2", "Quick edits, saved as you go", "Status saves at once; a next step half-typed is kept when another task is shown.");
  const rel = peekOf(page, release.id);
  const statuses = (await k.settings("alpha")).statuses;
  const target = statuses.find((x) => x.baseGroup === "active" && x.id !== release.statusId) ?? statuses.find((x) => x.baseGroup !== "closed" && x.id !== release.statusId);
  // A chip opens a menu of its field's choices; the pick saves.
  await rel.locator("[data-task-peek-chip=status]").click();
  await page.locator(`[data-task-peek-menu=status] [data-task-peek-choice="${target.id}"]`).click();
  await until("the status is saved", async () => (await k.task(release.id)).statusId === target.id, 15000);
  await until("the popover shows the saved status", async () => (await rel.locator("[data-task-peek-chip=status]").getAttribute("title")) === `Status: ${target.name}`, 10000);
  await rel.locator("[data-task-peek-chip=urgency]").click();
  await page.locator("[data-task-peek-menu=urgency] [data-task-peek-choice=today]").click();
  await until("the urgency is saved", async () => (await k.task(release.id)).urgency === "today", 15000);
  // The next step is folded: a press unfolds it into its field.
  await rel.locator("[data-task-peek-next-step]").click();
  await rel.locator("textarea[aria-label='Next step']").fill("Ask QA for a staging slot");
  await k.beat(800);
  await k.shot("03-peek-editing-1440");
  // Not left: the next row takes the click, and what was typed is saved on the way.
  await rowOpen(page, login.id).click();
  await peekOf(page, login.id).waitFor({ timeout: 15000 });
  await until("the half-typed next step is saved", async () => (await k.task(release.id)).nextStep === "Ask QA for a staging slot", 15000);
  await k.endScene();

  await k.scene("p3", "Escape, one layer at a time", "The first Escape closes the task, the second the list. What was being typed is saved.");
  // Escape with the cursor still in Next step: the field leaves the page without a blur, and what
  // it held is saved all the same.
  const loginPeek = peekOf(page, login.id);
  await loginPeek.locator("[data-task-peek-next-step]").click();
  await loginPeek.locator("textarea[aria-label='Next step']").fill("Retry twice, then show an error");
  assert.equal(await loginPeek.locator("textarea[aria-label='Next step']").evaluate((el) => el === document.activeElement), true, "the cursor is in Next step");
  await page.keyboard.press("Escape");
  await until("the popover closed", async () => (await page.locator("[data-task-peek-popover]").count()) === 0, 5000);
  assert.equal(await list(page).count(), 1, "the first Escape leaves the list");
  await until("the next step typed before Escape is saved", async () => (await k.task(login.id)).nextStep === "Retry twice, then show an error", 15000);
  await k.beat(900);
  await k.shot("04-after-first-escape-1440");
  await page.keyboard.press("Escape");
  await until("the list closed", async () => (await list(page).count()) === 0, 5000);

  // A press outside both closes both, here with the cursor still in the due date.
  await openList(page);
  await rowOpen(page, release.id).click();
  const due = peekOf(page, release.id).locator("input[aria-label='Due date']");
  await due.waitFor({ timeout: 15000 });
  await due.fill("2026-12-24");
  await page.mouse.click(1100, 150);
  await until("the popover and the list closed", async () => (await page.locator("[data-task-peek-popover]").count()) === 0 && (await list(page).count()) === 0, 5000);
  await until("the due date typed before the outside press is saved", async () => (await k.task(release.id)).dueDate === "2026-12-24", 15000);
  await k.endScene();

  // Open chat from the quick view puts the task on the composer; that chip opens it too.
  await k.scene("p4", "The task chip opens the same view", "In the composer and on a sent message, a task chip shows the task above it.");
  await openList(page);
  await rowOpen(page, login.id).click();
  const chatBtn = peekOf(page, login.id).locator("[data-task-peek-chat]");
  // The demo project has a manager chat, which works on the task until it is handed off.
  assert(await chatBtn.isEnabled(), "Open chat is offered for a task the manager works on");
  await chatBtn.click();
  await until("the list closed for the chat", async () => (await list(page).count()) === 0, 5000);
  const composerChip = page.locator(`[data-composer-task-refs] [data-task-chip="${login.id}"]:visible`);
  await composerChip.waitFor({ timeout: 30000 });
  await composerChip.locator("[data-task-chip-open]").click();
  const chipPeek = peekOf(page, login.id);
  await chipPeek.waitFor({ timeout: 15000 });
  await until("the chip's popover is placed", async () => (await chipPeek.getAttribute("data-task-peek-side")) !== null, 10000);
  assert.equal(await chipPeek.getAttribute("data-task-peek-side"), "top", "above the composer's chip");
  const [cb, cp] = [await box(composerChip), await box(chipPeek)];
  assert(cp.bottom <= cb.top, "the popover sits above the chip, clear of it");
  await k.beat(1200);
  await k.shot("05-composer-chip-peek-1440");
  await page.keyboard.press("Escape");
  await until("the chip's popover closed", async () => (await page.locator("[data-task-peek-popover]").count()) === 0, 5000);
  await k.endScene();

  await k.scene("p5", "The whole task, one button away", "Open in window opens the task's window; the sidebar stays as it was.");
  await openList(page);
  await rowOpen(page, release.id).click();
  await peekOf(page, release.id).locator("[data-task-peek-page]").click();
  await k.detail().getByText(release.title).first().waitFor({ timeout: 20000 });
  const win = page.locator('[aria-roledescription="window"]', { has: page.locator(`[data-task-detail="${release.id}"]`) });
  await win.waitFor({ timeout: 10000 });
  assert.equal(await page.locator("[data-tasks-panel]:visible").count(), 0, "the sidebar's Tasks section did not open");
  await k.beat(1400);
  await k.shot("06-open-in-window-1440");
  await k.endScene();
  record("1440", "row → popover right of the list, list stays; another row moves it; status, urgency and a half-typed next step saved; Esc (cursor in Next step) closes popover, saves the text, then the list; a press outside closes both and saves the due date being typed; composer chip opens it above the chip; Open in window opens the window, sidebar untouched", { heights });
}

async function desktop800(k, s) {
  const page = await k.openDesktopAt(800, 900);
  await page.goto(chatUrl(k, s));
  await k.scene("p6", "On an 800 px screen", "No room right of the list: the task flips to where there is room, and stays on screen.");
  await openList(page);
  await rowOpen(page, s.t.login.id).click();
  const peek = peekOf(page, s.t.login.id);
  await peek.waitFor({ timeout: 15000 });
  // Placed again once the task's fields have arrived and the popover has its real height.
  await peek.locator("[data-task-peek-fields]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await until("the popover is placed", async () => (await peek.getAttribute("data-task-peek-side")) !== null, 10000);
  const side = await peek.getAttribute("data-task-peek-side");
  const mode = await peek.getAttribute("data-task-peek-mode");
  assert.notEqual(side, "right", "no room on the right at 800");
  assert.notEqual(mode, "overlap", "there is room somewhere at 800: the popover does not cover the list");
  const pb = await box(peek);
  assert(pb.left >= 0 && pb.top >= 0 && pb.right <= 800 && pb.bottom <= 900, `on screen: ${JSON.stringify(pb)}`);
  const lb = await box(page.locator("[data-footer-popover]:visible").first());
  if (mode !== "overlap") {
    const apart = pb.right <= lb.left || pb.left >= lb.right || pb.bottom <= lb.top || pb.top >= lb.bottom;
    assert(apart, `the popover does not cover the list: ${JSON.stringify({ pb, lb })}`);
  }
  assert.equal(await list(page).count(), 1, "the list stays open");
  await k.beat(1400);
  await k.shot("07-peek-flipped-800");
  await k.endScene();
  record("800", `popover flips (${side}, ${mode}) and stays on screen; the list stays`, { side, mode });
}

async function phoneFlow(k, s, width) {
  const page = await k.openPhone(width, width === 320 ? 640 : 844);
  await page.goto(chatUrl(k, s));
  if (width === 390) await k.scene("p7", "On a phone: the same sheet", "A tap turns the list's sheet into the task's page: back returns to the list, Full screen opens the task.");
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.tap();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
  await k.shot(`08-phone-list-${width}`);
  await rowOpen(page, s.t.login.id).tap();
  const pagePeek = page.locator(`[data-task-peek="${s.t.login.id}"][data-task-peek-layout="sheet"]:visible`);
  await pagePeek.waitFor({ timeout: 15000 });
  assert.equal(await list(page).count(), 0, "the sheet shows the task, not the list");
  assert.equal(await page.locator("[data-task-peek-popover]").count(), 0, "no second sheet or popover");
  const heights = {
    back: await heightOf(pagePeek.locator("[data-task-peek-back]"), ICON(true), "‹ back"),
    openChat: await heightOf(pagePeek.locator("[data-task-peek-chat]"), TEXT(true), "Open chat"),
    fullScreen: await heightOf(pagePeek.locator("[data-task-peek-page]"), TEXT(true), "Full screen"),
  };
  const fit = await pagePeek.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert(fit, `nothing overflows sideways at ${width}`);
  await k.beat(1200);
  await k.shot(`09-phone-task-page-${width}`);
  await pagePeek.locator("[data-task-peek-back]").tap();
  await list(page).waitFor({ timeout: 10000 });
  await rowOpen(page, s.t.release.id).tap();
  const rel = page.locator(`[data-task-peek="${s.t.release.id}"]:visible`);
  await rel.waitFor({ timeout: 15000 });
  await rel.locator("[data-task-peek-page]").tap();
  await until("the sheet closed", async () => (await page.locator("[data-task-peek]:visible").count()) === 0, 10000);
  await page.locator(`[data-task-detail="${s.t.release.id}"]:visible`).first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator("[data-task-open-sheet]").count(), 0, "a tab, not the task sheet");
  await k.beat(1200);
  await k.shot(`10-phone-full-screen-${width}`);
  if (width === 320) await k.endScene();
  record(`phone-${width}`, "tap → the sheet becomes the task's page, ‹ back to the list, Full screen opens the task's tab", { heights });
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
    headless: true, args: ["--disable-dev-shm-usage"], ...(videoDir ? { slowMo: 60 } : {}),
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
  });
  kit = tasksKit({ web, fx, tg: phone(fakeInfo.control), browser, shotsDir, videoDir, owner: OWNER, record });
  const s = await seedDemo(kit, dirs);
  await kit.openDesktop();
  const steps = [["1440", desktop], ["800", desktop800], ["390", (k, x) => phoneFlow(k, x, 390)], ["320", (k, x) => phoneFlow(k, x, 320)]];
  for (const [id, run] of steps) {
    try {
      await run(kit, s);
    } catch (error) {
      failures.push({ step: id, error: String(error.stack ?? error) });
      console.error(`FAIL ${id} ${error.stack ?? error}`);
      await kit.failureShots(id);
      break;
    }
  }
  const unexpected = kit.pageErrors().filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) failures.push({ step: "page-errors", error: unexpected.join("\n") });
} catch (error) {
  failures.push({ step: "setup", error: String(error.stack ?? error) });
  console.error(`FAIL setup ${error.stack ?? error}`);
} finally {
  const scenes = await kit?.closeAll().catch(() => []);
  await browser?.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (fake && fake.exitCode === null) fake.kill();
  if (videoDir && scenes?.length) {
    try {
      await cutVideo(scenes, videoDir);
      await rename(join(videoDir, "ppm-tasks-walkthrough.mp4"), join(videoDir, "task-peek-walkthrough.mp4")).catch(() => {});
    } catch (e) { failures.push({ step: "video", error: String(e.stack ?? e) }); }
  }
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ results, failures }, null, 2));
  for (const f of failures) console.error(`FAILED ${f.step}: ${f.error.split("\n")[0]}`);
  console.log(`${results.length} checks passed, ${failures.length} failed; screenshots in ${shotsDir}; logs in ${logs}`);
  process.exit(failures.length ? 1 : 0);
}
