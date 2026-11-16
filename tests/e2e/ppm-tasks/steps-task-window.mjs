// Steps of tests/e2e/ppm-tasks-e2e.mjs for how a task opens: in a floating window on a desktop
// (1440 and 800 px), with "Open as tab" in its titlebar, one window per task, the window that shows
// a preview reused by the next selection, and its place remembered across a reload and a close;
// in a bottom sheet on a phone (390 and 320 px) with "Full screen". Button heights are measured
// against the chat footer's row: a button with text 28 px (26 on a phone), an icon button 24 (22).
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";

const WINDOW = '[aria-roledescription="window"]';
const taskWindows = (page) => page.locator(WINDOW, { has: page.locator("[data-task-detail]") });
const windowOf = (page, id) => page.locator(WINDOW, { has: page.locator(`[data-task-detail="${id}"]`) });

/** Drawn heights of every element `selector` matches, rounded to a pixel. */
const heights = (page, selector) => page.locator(selector).evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().height)));

async function assertHeight(page, selector, want, what) {
  const got = await heights(page, selector);
  assert(got.length > 0, `${what}: nothing matches ${selector}`);
  assert(got.every((h) => Math.abs(h - want) <= 1), `${what} is ${want} px tall: ${got}`);
  return got[0];
}

/** Front-most first: the windows' z-index as the layer sets it. */
const zOf = (loc) => loc.evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);

/**
 * The saved rect of the window showing `taskId` (layer coordinates, as `ppm-windows` keeps it),
 * and the rect remembered for the next task window. Read from storage, not from the screen: a
 * window that just opened is still sliding into place.
 */
const savedRects = (page, taskId) => page.evaluate((id) => {
  const panels = JSON.parse(localStorage.getItem("ppm-window-panels") ?? "{}");
  const panelId = Object.keys(panels).find((k) => panels[k]?.tabs?.some((t) => t.metadata?.taskId === id));
  const win = panelId ? JSON.parse(localStorage.getItem("ppm-windows") ?? "[]").find((w) => `__win__:${w.id}` === panelId) : null;
  return { window: win?.rect ?? null, remembered: JSON.parse(localStorage.getItem("ppm-task-window-rect") ?? "null") };
}, taskId);
const sameRect = (a, b) => !!a && !!b && ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) <= 1);

/** No task windows or task tabs left from earlier steps, and the Assistant's window out of the way. */
async function cleanDesktop(page, web) {
  await page.evaluate(() => {
    const panels = JSON.parse(localStorage.getItem("ppm-window-panels") ?? "{}");
    const taskWindowIds = new Set();
    for (const [id, p] of Object.entries(panels)) {
      if (p?.tabs?.some((t) => t.type === "task")) { taskWindowIds.add(id.replace(/^__win__:/, "")); delete panels[id]; }
    }
    localStorage.setItem("ppm-window-panels", JSON.stringify(panels));
    const wins = JSON.parse(localStorage.getItem("ppm-windows") ?? "[]").filter((w) => !taskWindowIds.has(w.id));
    for (const w of wins) w.state = "minimized";
    localStorage.setItem("ppm-windows", JSON.stringify(wins));
    localStorage.removeItem("ppm-task-window-rect");
  });
  await page.goto(`${web}/project/alpha`);
  // Task tabs an earlier step opened in the grid: closed, so this run starts from the chat.
  for (let i = 0; i < 12; i++) {
    const tab = page.locator('[data-tab-item][data-tab-id^="task:"]').first();
    if (!(await tab.count())) break;
    await tab.click({ button: "middle" }).catch(() => {});
    await page.waitForTimeout(150);
  }
}

/** 1440: a window per task, the preview window reused, Open as tab, focus instead of a duplicate. */
async function desktopWindow(k, s) {
  const page = k.use(k.desktop);
  await cleanDesktop(page, k.web);
  await k.openTasks();
  await page.getByRole("tab", { name: "alpha" }).first().click().catch(() => {});
  const login = await k.task(s.t.login.id), review = await k.task(s.t.review.id), release = await k.task(s.t.release.id);
  await k.row(login.title).waitFor({ timeout: 20000 });
  const gridBefore = await page.locator("[data-tab-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id")));
  await k.scene("w01", "A task opens in a window", "Clicking a task in the list opens it in a floating window. The tab you were working in stays where it was.");

  await k.row(login.title).getByText(login.title, { exact: true }).click();
  await windowOf(page, login.id).waitFor({ timeout: 20000 });
  assert.equal(await taskWindows(page).count(), 1, "one task window");
  const gridAfter = await page.locator("[data-tab-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id")));
  assert.deepEqual(gridAfter, gridBefore, "the grid's tabs did not change");
  await k.beat(1200);
  await k.shot("w01-window-1440");

  // Walking the list swaps the task in that window: still one window.
  await k.row(review.title).getByText(review.title, { exact: true }).click();
  await windowOf(page, review.id).waitFor({ timeout: 20000 });
  assert.equal(await taskWindows(page).count(), 1, "the preview window was reused");
  await k.beat();
  await k.row(release.title).getByText(release.title, { exact: true }).click();
  await windowOf(page, release.id).waitFor({ timeout: 20000 });
  assert.equal(await taskWindows(page).count(), 1, "still one window after a third selection");
  await k.endScene();

  // A double-click keeps the window; the next task gets a window of its own.
  await k.scene("w02", "One window per task", "A double-click keeps a task's window. Opening a task that already has a window brings it to the front instead of opening another.");
  await k.row(release.title).getByText(release.title, { exact: true }).dblclick();
  await k.row(login.title).getByText(login.title, { exact: true }).click();
  await windowOf(page, login.id).waitFor({ timeout: 20000 });
  assert.equal(await taskWindows(page).count(), 2, "a kept window stays and the next task opens beside it");
  await k.beat();
  // Opening the kept task again: its window comes forward, no third window.
  assert((await zOf(windowOf(page, login.id))) > (await zOf(windowOf(page, release.id))), "the newest window is in front");
  await k.row(release.title).getByText(release.title, { exact: true }).click();
  await until("the release window comes to the front", async () => (await zOf(windowOf(page, release.id))) > (await zOf(windowOf(page, login.id))), 10000);
  assert.equal(await taskWindows(page).count(), 2, "no duplicate window for a task already open");
  await k.beat(1200);
  await k.shot("w02-two-windows-1440");
  await k.endScene();

  // The titlebar button: 28 px like every button with text, then the task becomes a tab.
  await k.scene("w03", "Open as tab", "The window's \"Open as tab\" turns the task into a tab in the grid. Opened again, it focuses that tab.");
  const releaseWin = windowOf(page, release.id);
  const button = releaseWin.locator("[data-task-open-as-tab]");
  await button.waitFor({ timeout: 10000 });
  const buttonHeight = await assertHeight(page, `${WINDOW} [data-task-open-as-tab]`, 28, "Open as tab");
  await k.beat();
  await button.click();
  await until("the release window closed", async () => (await windowOf(page, release.id).count()) === 0, 10000);
  const tab = page.locator(`[data-tab-item][data-tab-id="task:${release.id}"]`);
  await tab.waitFor({ timeout: 10000 });
  assert.equal(await tab.getAttribute("aria-selected").catch(() => null) !== "false", true, "the new tab is the active one");
  await page.locator(`[data-task-detail="${release.id}"]:visible`).first().waitFor({ timeout: 10000 });
  assert.equal(await page.locator(`[data-task-detail="${release.id}"]`).locator(`xpath=ancestor::*[@aria-roledescription="window"]`).count(), 0, "the release page is in the grid, not a window");
  await k.beat(1200);
  await k.shot("w03-open-as-tab-1440");
  // Opened again from the list: the tab, not a new window.
  await k.row(review.title).getByText(review.title, { exact: true }).click();
  await windowOf(page, review.id).waitFor({ timeout: 20000 });
  await k.row(release.title).getByText(release.title, { exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal(await windowOf(page, release.id).count(), 0, "a task turned into a tab opens as that tab");
  await k.endScene();
  k.record("window-1", "1440: a task opens in a window and the grid's tabs stay; the preview window is reused by the next selection; a kept window stays and a task already open comes forward instead of a duplicate; Open as tab (28 px) moves it into the grid, after which opening it focuses the tab", { openAsTabHeight: buttonHeight });

  // Reload: the windows come back where they were.
  await k.scene("w04", "Windows come back after a reload", "Task windows keep their place and size. A new task window opens where the last one was left.");
  const reviewWin = windowOf(page, review.id);
  const head = await reviewWin.boundingBox();
  // Drag the titlebar left and down a little: the move a person makes.
  await page.mouse.move(head.x + 200, head.y + 14);
  await page.mouse.down();
  await page.mouse.move(head.x + 120, head.y + 60, { steps: 8 });
  await page.mouse.up();
  const movedBox = await reviewWin.boundingBox();
  assert(Math.abs(movedBox.x - (head.x - 80)) <= 4 && Math.abs(movedBox.y - (head.y + 46)) <= 4, `the window moved: ${JSON.stringify(head)} → ${JSON.stringify(movedBox)}`);
  const saved = await until("the moved rect saved", async () => { const r = await savedRects(page, review.id); return sameRect(r.window, r.remembered) ? r : null; }, 5000)
    .catch(async () => assert.fail(`the moved rect is remembered for the next task window: ${JSON.stringify(await savedRects(page, review.id))}`));
  const moved = saved.window;
  await page.reload();
  // #1's preview window was reused for #8 above, so #8's is the one task window there is.
  await windowOf(page, review.id).waitFor({ timeout: 30000 });
  assert.equal(await taskWindows(page).count(), 1, "the one task window came back");
  const restored = (await savedRects(page, review.id)).window;
  assert(sameRect(restored, moved), `restored where it was: ${JSON.stringify(moved)} vs ${JSON.stringify(restored)}`);
  await k.beat();
  // Close it, then open another task: it lands where the moved one was.
  await windowOf(page, review.id).getByRole("button", { name: "Close window" }).click();
  await until("the window closed", async () => (await windowOf(page, review.id).count()) === 0, 10000);
  const copy = await k.task(s.t.copy.id);
  await k.openTasks();
  await k.row(copy.title).getByText(copy.title, { exact: true }).click();
  await windowOf(page, copy.id).waitFor({ timeout: 20000 });
  const reopened = await savedRects(page, copy.id);
  assert(sameRect(reopened.window, moved), `the next task window opens where the last one was: moved ${JSON.stringify(moved)}, opened ${JSON.stringify(reopened.window)}, remembered ${JSON.stringify(reopened.remembered)}`);
  await page.waitForTimeout(400);
  await k.beat(1200);
  await k.shot("w04-reopened-at-remembered-place-1440");
  await k.endScene();
  k.record("window-2", "1440: a moved task window comes back at the same place after a reload; after closing, the next task window opens at the remembered place");
}

/** 1440: a task window that opens a chat goes to the dock; its dock chip brings it back. */
async function windowOpensChat(k, s) {
  const page = k.use(k.desktop);
  const login = await k.task(s.t.login.id);
  await page.goto(`${k.web}/project/alpha`);
  await k.openTasks();
  await page.getByRole("tab", { name: "alpha" }).first().click().catch(() => {});
  await k.scene("w05", "A task window gets out of the way of its chat", "Open chat in a task window opens the chat and puts the window in the dock. Its chip there brings the task back.");
  await k.row(login.title).getByText(login.title, { exact: true }).click();
  const win = windowOf(page, login.id);
  await win.waitFor({ timeout: 20000 });
  await k.beat();
  await win.locator("[data-working-session]").getByRole("button", { name: "Open chat" }).click();
  // The chat is in front, the window is not: hidden from the layer, kept as a minimized chip.
  await page.locator("[data-composer-task-refs] [data-task-chip]:visible").first().waitFor({ timeout: 20000 });
  await until("the task window went to the dock", async () => !(await win.isVisible()), 10000);
  const chip = page.getByRole("toolbar", { name: "Windows" }).getByRole("button", { name: `#${login.number} ${login.title} (minimized)` });
  await chip.waitFor({ timeout: 10000 });
  // The chat is not covered: its composer takes a click.
  await page.locator("[data-composer-task-refs] [data-task-chip]:visible").first().click({ trial: true });
  await k.beat(1200);
  await k.shot("w05-open-chat-window-in-dock-1440");
  await chip.click();
  await win.waitFor({ state: "visible", timeout: 10000 });
  await k.beat(1200);
  await k.shot("w06-window-back-from-dock-1440");
  await k.endScene();
  k.record("window-chat", "1440: Open chat in a task window opens the chat uncovered and puts the window in the dock (minimized chip); the chip brings the task back");
}

/** 800: the window fits the narrow screen and stacks the page's columns. */
async function desktop800(k, s) {
  const page = await k.openDesktopAt(800, 900);
  await k.openTasks();
  await page.getByRole("tab", { name: "alpha" }).first().click().catch(() => {});
  const login = await k.task(s.t.login.id);
  await k.row(login.title).waitFor({ timeout: 20000 });
  await k.scene("w07", "An 800 px desktop", "The window fits a narrow screen; the task page stacks its two columns.");
  // A remembered place hanging over the list (where a window was once dragged): the new window
  // still opens right of the open list, narrowed to the room there.
  await page.evaluate(() => localStorage.setItem("ppm-task-window-rect", JSON.stringify({ x: -220, y: 24, w: 700, h: 640 })));
  await k.row(login.title).getByText(login.title, { exact: true }).click();
  const win = windowOf(page, login.id);
  await win.waitFor({ timeout: 20000 });
  await page.waitForTimeout(400); // the window slides into place
  const box = await win.boundingBox();
  const listRight = await page.locator("[data-tasks-panel]:visible").first().evaluate((el) => el.getBoundingClientRect().right);
  assert(box.x >= listRight - 1, `the window opens right of the Tasks list: window x ${box.x}, list ends at ${listRight}`);
  assert(box.x >= 0 && box.x + box.width <= 800 + 1, `the window fits the 800 px screen: ${JSON.stringify(box)}`);
  const overflow = await win.locator("[data-task-detail]").evaluate((el) => el.scrollWidth - el.clientWidth);
  assert(overflow <= 1, `nothing in the task page overflows sideways (${overflow} px)`);
  const h = await assertHeight(page, `${WINDOW} [data-task-open-as-tab]`, 28, "Open as tab at 800");
  await k.beat(1200);
  await k.shot("w07-window-800");
  await k.endScene();
  k.record("window-3", "800: the task window opens right of the open Tasks list (even from a remembered place over it) and fits the screen, nothing overflows, Open as tab is 28 px", { openAsTabHeight: h });
}

/** 390 and 320: the sheet over the list, × and Full screen at the chip row's sizes. */
async function phoneSheet(k, s) {
  const page = await k.openPhone();
  const login = await k.task(s.t.login.id), review = await k.task(s.t.review.id);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  const list = page.locator("[data-task-list-mobile]:visible");
  await list.waitFor({ timeout: 30000 });
  await k.scene("w08", "A phone opens a task in a sheet", "On a phone the task opens in a bottom sheet over the list. Swipe it down or tap × to go back to the list.");
  await list.locator("[data-task-row]", { hasText: login.title }).first().getByText(login.title, { exact: true }).tap();
  const sheet = page.locator(`[data-task-open-sheet="${login.id}"]`);
  await sheet.waitFor({ timeout: 20000 });
  await sheet.locator("[data-task-detail-mobile]").waitFor({ timeout: 20000 });
  const full = await assertHeight(page, "[data-task-sheet-full-screen]", 26, "Full screen");
  const close = await assertHeight(page, "[data-task-sheet-close]", 22, "× in the sheet");
  const more = await assertHeight(page, "[data-task-open-sheet] [data-task-actions]", 22, "··· in the sheet");
  assert.equal(await page.getByRole("button", { name: "Back to tasks" }).count(), 0, "the sheet has × rather than a back arrow");
  await k.beat(1200);
  await k.shot("w08-sheet-390");
  // × goes back to the list, which is still there under the sheet.
  await page.locator("[data-task-sheet-close]").tap();
  await until("the sheet closed", async () => (await sheet.count()) === 0, 10000);
  await list.waitFor({ timeout: 10000 });
  await k.beat();
  await k.endScene();

  await k.scene("w09", "Full screen", "\"Full screen\" turns the sheet into the task's page, as a tab.");
  await list.locator("[data-task-row]", { hasText: review.title }).first().getByText(review.title, { exact: true }).tap();
  await page.locator(`[data-task-open-sheet="${review.id}"]`).waitFor({ timeout: 20000 });
  await k.beat();
  await page.locator("[data-task-sheet-full-screen]").tap();
  await until("the sheet closed", async () => (await page.locator("[data-task-open-sheet]").count()) === 0, 10000);
  const pageView = page.locator(`[data-task-detail="${review.id}"][data-task-detail-mobile]:visible`);
  await pageView.waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Back to tasks" }).waitFor({ timeout: 10000 });
  // The drawer stays mounted and slides off the left edge when it closes.
  await until("the drawer closed", async () => (await page.locator("[data-task-list-mobile]").evaluateAll((els) => els.every((el) => el.getBoundingClientRect().right <= 0 || !el.getClientRects().length))), 10000);
  await k.beat(1200);
  await k.shot("w09-full-screen-390");
  await k.endScene();
  k.record("window-4", "390: a task opens in a sheet over the list (Full screen 26 px, ··· and × 22 px); × goes back to the list; Full screen opens the task's page as a tab and closes the drawer", { fullScreenHeight: full, closeHeight: close, moreHeight: more });

  const narrow = await k.openPhone(320, 640);
  await narrow.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  const list320 = narrow.locator("[data-task-list-mobile]:visible");
  await list320.waitFor({ timeout: 30000 });
  await k.scene("w10", "A 320 px phone", "The sheet's header fits the narrowest phone.");
  await list320.locator("[data-task-row]", { hasText: login.title }).first().getByText(login.title, { exact: true }).tap();
  const sheet320 = narrow.locator(`[data-task-open-sheet="${login.id}"]`);
  await sheet320.waitFor({ timeout: 20000 });
  await sheet320.locator("[data-task-detail-mobile]").waitFor({ timeout: 20000 });
  const header = sheet320.locator("[data-task-detail-mobile] > header");
  const spill = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
  assert(spill <= 1, `the sheet's header fits 320 px (${spill} px over)`);
  for (const sel of ["[data-task-sheet-full-screen]", "[data-task-open-sheet] [data-task-actions]", "[data-task-sheet-close]"]) {
    const r = await narrow.locator(sel).boundingBox();
    assert(r && r.x >= 0 && r.x + r.width <= 320 + 1, `${sel} is on screen at 320: ${JSON.stringify(r)}`);
  }
  await assertHeight(narrow, "[data-task-sheet-full-screen]", 26, "Full screen at 320");
  await assertHeight(narrow, "[data-task-sheet-close]", 22, "× at 320");
  await assertHeight(narrow, "[data-task-open-sheet] [data-task-actions]", 22, "··· at 320");
  await k.beat(1200);
  await k.shot("w10-sheet-320");
  await k.endScene();
  k.record("window-5", "320: the sheet's header fits, its three buttons stay on screen (Full screen 26 px, ··· and × 22 px)");
}

export const WINDOW_STEPS = [
  { id: "window-1", run: desktopWindow },
  { id: "window-chat", run: windowOpensChat },
  { id: "window-3", run: desktop800 },
  { id: "window-4", run: phoneSheet },
];
