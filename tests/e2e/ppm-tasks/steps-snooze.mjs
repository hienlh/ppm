// Snooze steps of tests/e2e/ppm-tasks-e2e.mjs (PPM_TASKS_ONLY=snooze runs them alone): a task
// snoozed until tomorrow leaves the urgency groups for the folded "Snoozed (N)" section and comes
// back with Unsnooze — at 1440 from the task page's popover, at 800 from the row's right-click
// menu and a picked day, at 390 from the long-press sheet. Every snooze control is measured
// against the chip row's sizes: a text button 28 px tall (26 px on a phone).
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";
import { dayFromNow } from "./tasks-seed.mjs";

const openDrawerTasks = (page) => page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));

/** Drawn height of every visible element matching `sel`, rounded to a tenth. */
const heights = (page, sel) => page.locator(sel).evaluateAll((els) => els
  .filter((e) => e.getBoundingClientRect().height > 0)
  .map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10));

/** The urgency group a row sits in, or "snoozed" when it is in the Snoozed section, or null. */
const whereIs = (row) => row.evaluate((el) => (el.closest("[data-task-snoozed-section]") ? "snoozed" : el.closest("[data-task-group]")?.getAttribute("data-task-group") ?? null));

/** Makes the task wait on the user, due in a few days, so its row draws the waiting label. */
async function waitOnMe(k, id) {
  const t = await k.task(id);
  const waiting = (await k.settings(t.project)).statuses.find((x) => x.baseGroup === "waiting");
  const r = await k.patch(id, { revision: t.revision, statusId: waiting.id, waitingOnMemberId: "me", dueDate: dayFromNow(3) });
  assert.equal(r.ok, true, `made ${t.ref} wait on the user`);
}

/**
 * In a row both waiting and snoozed, the snooze label sits right after the waiting label and the
 * two never overlap: drawn side by side on one line, or the snooze label on the next line.
 */
async function waitAndSnoozeApart(row) {
  const box = await row.evaluate((el) => {
    const r = (sel) => { const e = el.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const wait = el.querySelector("[data-task-waiting]");
    const snooze = el.querySelector("[data-task-snooze]");
    // The two are siblings in the meta line, the snooze label after the wait (its date, on a desktop).
    const order = wait && snooze ? !!(wait.compareDocumentPosition(snooze) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    // Text cut to "Wa…": a truncating span narrower than what it holds.
    const cut = [...el.querySelectorAll("[data-task-waiting-words], [data-task-snooze] .truncate")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
    return { wait: r("[data-task-waiting]"), snooze: r("[data-task-snooze]"), row: r(":scope > *"), order, cut };
  });
  assert(box.wait && box.wait.w > 0, "the waiting label is drawn");
  assert(box.snooze && box.snooze.w > 0, "the snooze label is drawn");
  assert(box.order, "the snooze label comes after the waiting label");
  const overlap = box.wait.l < box.snooze.r - 0.5 && box.snooze.l < box.wait.r - 0.5 && box.wait.t < box.snooze.b - 0.5 && box.snooze.t < box.wait.b - 0.5;
  assert(!overlap, `waiting ${JSON.stringify(box.wait)} and snooze ${JSON.stringify(box.snooze)} overlap`);
  assert.deepEqual(box.cut, [], "the wait and the snooze are drawn whole");
  return box;
}

async function openSnoozedSection(page) {
  const toggle = page.locator("[data-task-snoozed-toggle]:visible").first();
  await toggle.waitFor({ timeout: 15000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return toggle;
}

/** 1440: Snooze from the task page → gone from the groups, in the folded section; Unsnooze → back. */
async function snoozeDesktop(k, s) {
  // A page of its own: in the full run the steps before leave other pages in front, and the 1440
  // one with task windows and tabs open.
  const page = await k.openDesktopAt(1440, 900);
  const title = s.t.review.title;
  await k.scene("z1", "Snooze a task until tomorrow", "It keeps its status and leaves the daily list; the folded “Snoozed” section at the bottom holds it.");
  // Earlier steps of the full run may have moved it (another status, a result): what matters is
  // that the snooze leaves both as they were.
  await waitOnMe(k, s.t.review.id);
  const before = await k.task(s.t.review.id);
  await k.selectTask(title);
  const button = k.detail().locator("[data-task-snooze-button]");
  await button.waitFor({ timeout: 15000 });
  assert.deepEqual(await heights(page, "[data-task-detail] [data-task-snooze-button]"), [28], "the Snooze button is 28 px");
  await button.click();
  const popover = page.locator("[data-task-snooze-popover]");
  await popover.waitFor({ timeout: 10000 });
  const labels = await popover.locator("[data-snooze-choice]").allInnerTexts();
  for (const l of ["Tomorrow", "1 week", "Pick a date", "Until a link changes"]) assert(labels.some((x) => x.includes(l)), `the popover offers ${l}: ${labels}`);
  assert(await popover.locator('[data-snooze-choice="link"]').isDisabled(), "Until a link changes is off without a Jira or PR link");
  await k.beat(1200);
  await k.shot("z1-snooze-popover-1440");
  await popover.locator('[data-snooze-choice="tomorrow"]').click();
  await until("the task is snoozed", async () => (await k.task(s.t.review.id)).snoozedUntil === dayFromNow(1));
  const t = await k.task(s.t.review.id);
  assert.equal(t.snoozed, true);
  assert.equal(t.statusName, before.statusName, "the status stays what it was");
  await until("the row left the groups", async () => (await whereIs(k.row(title)).catch(() => null)) !== before.effectiveUrgency);
  const toggle = page.locator("[data-task-snoozed-toggle]:visible").first();
  await toggle.waitFor({ timeout: 15000 });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "the section starts folded");
  assert.match(await toggle.innerText(), /Snoozed\s*1/i);
  assert.equal(await page.locator("[data-tasks-panel]:visible [data-task-row]", { hasText: title }).count(), 0, "folded, the snoozed row is not drawn");
  assert.deepEqual(await heights(page, "[data-task-snoozed-toggle]:visible"), [28], "the section header is 28 px");
  await k.beat(1200);
  await k.shot("z1-snoozed-folded-1440");
  await openSnoozedSection(page);
  const row = page.locator("[data-task-snoozed-rows] [data-task-row]", { hasText: title }).first();
  await row.waitFor({ timeout: 10000 });
  assert.match(await row.innerText(), /Until /, "the row says until when");
  assert.deepEqual(await heights(page, "[data-task-snoozed-rows] [data-task-unsnooze]:visible"), [28], "Unsnooze is 28 px");
  await row.locator("[data-task-unsnooze]").scrollIntoViewIfNeeded();
  await k.beat(1200);
  await k.shot("z1-snoozed-open-1440");
  await waitAndSnoozeApart(row);
  // The project's Telegram /tasks counts it too (the summary it reads).
  const summary = (await k.fx.api("/api/tasks/projects")).data.find((p) => p.name === "alpha");
  assert.equal(summary.snoozed, 1, "the project counts one snoozed task");
  await row.locator("[data-task-unsnooze]").click();
  await until("the task is back", async () => !(await k.task(s.t.review.id)).snoozed);
  await until("the row is back in its group", async () => (await whereIs(k.row(title)).catch(() => null)) === before.effectiveUrgency);
  assert.equal(await page.locator("[data-task-snoozed-section]:visible").count(), 0, "with nothing snoozed the section is gone");
  const history = await k.history(s.t.review.id);
  const rows = history.history ?? history;
  assert(rows.some((h) => h.kind === "snoozed"), "the snooze is in the task's history");
  await k.beat(1200);
  await k.shot("z1-unsnoozed-1440");
  await k.endScene();
  k.record("z1", "1440: Snooze → Tomorrow from the task page; row leaves the groups for a folded Snoozed (1); Unsnooze brings it back; buttons 28 px; beside a wait, never over it");
}

/** 800: the row's right-click menu → Pick a date… → the day; then Unsnooze from the row. */
async function snoozeNarrowDesktop(k, s) {
  const page = await k.openDesktopAt(800, 900);
  const title = s.t.logs.title;
  await k.scene("z2", "Snooze from the row's menu", "Right-click a task: Tomorrow, 1 week, a day you pick, or until a link changes.");
  await k.openTasks();
  const row = k.row(title);
  await row.waitFor({ timeout: 20000 });
  await row.click({ button: "right" });
  const menu = page.locator("[data-task-row-menu]");
  await menu.waitFor({ timeout: 10000 });
  await k.beat(1000);
  await k.shot("z2-row-menu-800");
  await menu.locator('[data-snooze-choice="date"]').click();
  const popover = page.locator("[data-task-snooze-popover]");
  await popover.waitFor({ timeout: 10000 });
  const day = dayFromNow(10);
  await popover.locator('[data-snooze-date-form] input[type="date"]').waitFor({ timeout: 5000 }).catch(async () => {
    await popover.locator('[data-snooze-choice="date"]').click();
  });
  await popover.locator('[data-snooze-date-form] input[type="date"]').fill(day);
  assert.deepEqual(await heights(page, "[data-snooze-date-save]"), [28], "the date's Snooze button is 28 px");
  await k.beat(1000);
  await k.shot("z2-pick-date-800");
  await popover.locator("[data-snooze-date-save]").click();
  await until("snoozed until the picked day", async () => (await k.task(s.t.logs.id)).snoozedUntil === day);
  await openSnoozedSection(page);
  const snoozed = page.locator("[data-task-snoozed-rows] [data-task-row]", { hasText: title }).first();
  await snoozed.waitFor({ timeout: 10000 });
  await snoozed.locator("[data-task-unsnooze]").scrollIntoViewIfNeeded();
  await k.beat(1000);
  await k.shot("z2-snoozed-800");
  await snoozed.locator("[data-task-unsnooze]").click();
  await until("back", async () => !(await k.task(s.t.logs.id)).snoozed);
  await k.endScene();
  k.record("z2", "800: right-click → Pick a date… → snoozed until that day, in the section; Unsnooze");
}

/** 390: long-press sheet → Snooze until… → Tomorrow; the Snoozed section in the drawer; Unsnooze. */
async function snoozePhone(k, s) {
  const page = await k.openPhone();
  const title = s.t.reply.title;
  await waitOnMe(k, s.t.reply.id);
  await openDrawerTasks(page);
  const list = page.locator("[data-task-list-mobile]:visible");
  await list.waitFor({ timeout: 30000 });
  await k.scene("z3", "Snooze on a phone", "Long-press a task: “Snooze until…” opens its choices in the same bottom sheet.");
  const row = page.locator("[data-task-row]", { hasText: title }).first();
  await row.dispatchEvent("contextmenu");
  const sheet = page.locator("[data-task-action-sheet]");
  await sheet.waitFor({ timeout: 10000 });
  await sheet.getByRole("button", { name: /Snooze until/ }).tap();
  const choices = sheet.locator("[data-task-action-snooze]");
  await choices.waitFor({ timeout: 5000 });
  await k.beat(1200);
  await k.shot("z3-sheet-snooze-390");
  await choices.locator('[data-snooze-choice="tomorrow"]').tap();
  await until("snoozed from the phone", async () => (await k.task(s.t.reply.id)).snoozedUntil === dayFromNow(1));
  const prompt = page.locator("[data-task-manager-prompt]");
  if (await prompt.first().waitFor({ timeout: 4000 }).then(() => true, () => false)) await prompt.getByRole("button", { name: "Next turn" }).first().tap();
  if (!(await list.count())) await openDrawerTasks(page);
  const toggle = page.locator("[data-task-snoozed-toggle]:visible").first();
  await toggle.waitFor({ timeout: 15000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
  const snoozed = page.locator("[data-task-snoozed-rows] [data-task-row]", { hasText: title }).first();
  await snoozed.waitFor({ timeout: 10000 });
  assert.deepEqual(await heights(page, "[data-task-snoozed-rows] [data-task-unsnooze]:visible"), [26], "Unsnooze is 26 px on a phone");
  await snoozed.locator("[data-task-unsnooze]").scrollIntoViewIfNeeded();
  await k.beat(1200);
  await k.shot("z3-snoozed-390");
  await waitAndSnoozeApart(snoozed);
  // The phone page's own Snooze button, at the phone size.
  await snoozed.getByText(title).first().tap();
  const detail = page.locator("[data-task-open-sheet] [data-task-detail-mobile]:visible");
  await detail.waitFor({ timeout: 15000 });
  assert.deepEqual(await heights(page, "[data-task-detail-mobile] [data-task-snooze-button]:visible"), [26], "the phone page's Snooze button is 26 px");
  await k.beat(1200);
  await k.shot("z3-detail-390");
  await detail.locator("[data-task-snooze-button]").tap();
  const phoneSheet = page.locator("[data-task-snooze-sheet]");
  await phoneSheet.waitFor({ timeout: 10000 });
  await k.beat(1000);
  await k.shot("z3-snooze-sheet-390");
  await phoneSheet.locator('[data-snooze-choice="clear"]').tap();
  await until("back from the phone", async () => !(await k.task(s.t.reply.id)).snoozed);
  await k.endScene();
  k.record("z3", "390: long-press → Snooze until… → Tomorrow, in the drawer's Snoozed section; Unsnooze 26 px; the page's Snooze sheet unsnoozes; beside a wait, never over it");
}

export const SNOOZE_STEPS = [
  { id: "z1", run: snoozeDesktop },
  { id: "z2", run: snoozeNarrowDesktop },
  { id: "z3", run: snoozePhone },
];
