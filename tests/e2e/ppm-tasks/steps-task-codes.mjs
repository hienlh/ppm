// Task codes in tests/e2e/ppm-tasks-e2e.mjs: wherever a task's title is shown its code is beside it
// (`#12` in a view of its own project, `alpha/12` where the view spans projects), a click on the
// code copies the full code and says "Copied", and typing a code into the task list's search or the
// command palette jumps to that task. Checked at 1440, in the Assistant's 800 px floating window,
// on a phone at 390 / 360 / 320, and on Telegram; at every size no code wraps or is cut, the title
// giving way first. Screenshots are named `c<NN>-…`.
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";
import { telegramFrame } from "./steps-phone-telegram.mjs";

const LONG_TITLE = "Investigate why the nightly export of every customer's invoices sometimes stops halfway through on the largest accounts and leaves a partial file";

/**
 * Every visible task code under `scope`: its text, whether it wrapped onto two lines, whether its
 * text is cut (wider than its box), and whether it pokes out of the nearest clipping box above it.
 */
function codesIn(page, scope = "body") {
  return page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-task-code]`)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }).map((el) => {
    const r = el.getBoundingClientRect();
    let clip = el.parentElement;
    while (clip && clip !== document.body) {
      const cs = getComputedStyle(clip);
      if (cs.overflowX !== "visible" || cs.overflow !== "visible") break;
      clip = clip.parentElement;
    }
    const c = clip?.getBoundingClientRect();
    return {
      text: el.textContent,
      // Two lines are taller than one line of its own line-height (which a code inherits from the
      // title it sits in, so its font size alone says nothing).
      wrapped: el.getClientRects().length > 1 || r.height > (parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5) * 1.5,
      cut: el.scrollWidth > el.clientWidth + 1,
      outside: c ? r.left < c.left - 1 || r.right > c.right + 1 : false,
      at: `${el.parentElement?.tagName}.${(el.parentElement?.className || "").toString().slice(0, 40)} h=${Math.round(r.height)} lh=${getComputedStyle(el).lineHeight} fs=${getComputedStyle(el).fontSize} rects=${el.getClientRects().length}`,
    };
  }), scope);
}

/**
 * How far each visible code under `scope` sits off the baseline of the text beside it (the
 * `data-task-code-title` of its `data-task-code-pair`), in px. A zero-height inline-block put first
 * in each element lands on that element's first baseline, whatever its font, size or line-height;
 * its bottom is the baseline. The probes are removed again before anything else reads the page.
 */
export function codeBaselineOffsets(page, scope = "body") {
  return page.evaluate((sel) => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const baseline = (el) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline";
      el.insertBefore(probe, el.firstChild);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
    return [...document.querySelectorAll(`${sel} [data-task-code-pair]`)].flatMap((pair) => {
      const code = pair.querySelector("[data-task-code]");
      const title = pair.querySelector("[data-task-code-title]");
      if (!code || !title || !visible(code) || !visible(title)) return [];
      return [{ code: code.textContent, title: (title.textContent ?? "").slice(0, 32), off: Math.round((baseline(code) - baseline(title)) * 10) / 10 }];
    });
  }, scope);
}

/** Fails when a code under `scope` is more than 1 px off its title's baseline; answers how many were measured. */
export async function assertCodesOnBaseline(page, scope, where) {
  const offsets = await codeBaselineOffsets(page, scope);
  const off = offsets.filter((o) => Math.abs(o.off) > 1);
  assert.deepEqual(off, [], `${where}: codes off their title's baseline by more than 1 px: ${JSON.stringify(off)}`);
  return offsets.length;
}

/** Fails when any visible code under `scope` wraps, is cut, overflows its clip or leaves its title's baseline. */
async function assertCodesFit(page, scope, where) {
  await assertCodesOnBaseline(page, scope, where);
  const codes = await codesIn(page, scope);
  assert(codes.length > 0, `${where}: some task code is shown`);
  const bad = codes.filter((c) => c.wrapped || c.cut || c.outside);
  assert.deepEqual(bad, [], `${where}: codes that wrap, are cut or overflow: ${JSON.stringify(bad)}`);
  return codes.map((c) => c.text);
}

/** The text of the codes under `locator`. */
const codesOf = (locator) => locator.locator("[data-task-code]").allInnerTexts();

/** The list, its rows and the task's page at 1440; the all-projects scope; copy; the task tab. */
async function codesInListAndDetail(k, s) {
  const page = k.use(k.desktop);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: k.web });
  s.long = await k.createTask({ project: "alpha", title: LONG_TITLE, urgency: "now", importance: "should" });
  const login = await k.task(s.t.login.id);
  const kids = await Promise.all(s.t.kids.map((x) => k.task(x.id)));
  // The Assistant's window, left open by the earlier steps, would cover the task page in the shots.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("ppm-windows") ?? "[]");
    for (const w of saved) w.state = "minimized";
    localStorage.setItem("ppm-windows", JSON.stringify(saved));
  });
  await page.goto(`${k.web}/project/alpha`);
  await k.openTasks();
  await page.getByRole("tab", { name: "alpha" }).first().click().catch(() => {});
  await k.row(login.title).waitFor({ timeout: 20000 });
  assert.deepEqual(await codesOf(k.row(login.title)), [`#${login.number}`], "the row shows #N in its project's list");
  await k.selectTask(login.title);
  const detail = k.detail();
  const header = await codesOf(detail.locator("header").first());
  assert.deepEqual(header, [`#${login.number}`, `#${login.number}`], `breadcrumb and title carry the code: ${header}`);
  assert.deepEqual(await codesOf(detail.locator("[data-working-session]").first()), [`#${login.number}`], "the Working session block names the task");
  const children = await codesOf(detail.locator('[data-task-card="children"]'));
  assert.deepEqual(children.sort(), kids.map((x) => `#${x.number}`).sort(), `each child shows its code: ${children}`);
  await page.locator(`[title^="#${login.number} ${login.title}"]`).first().waitFor({ timeout: 10000 });
  await assertCodesFit(page, "[data-tasks-panel]", "1440 list");
  await assertCodesFit(page, "[data-task-detail]", "1440 detail");
  await k.shot("c01-list-and-detail-1440");

  // A click on a row's code copies the full code, says so, and leaves the selection where it was.
  await k.row(s.t.review.title).locator("[data-task-code]").click();
  await page.getByText(`Copied alpha/${(await k.task(s.t.review.id)).number}`).first().waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `alpha/${(await k.task(s.t.review.id)).number}`);
  assert.equal(await detail.getAttribute("data-task-detail"), login.id, "copying the code did not open the row");
  await k.shot("c02-copied-toast-1440");

  // A child's page links its parent by code and title.
  await k.selectTask(kids[1].title);
  assert.deepEqual(await codesOf(k.detail().locator("[data-task-parent]")), [`#${login.number}`], "the parent link carries the parent's code");
  await k.shot("c03-child-parent-1440");

  // All projects: every code names its project; the project chip it replaced is gone.
  await page.getByRole("tab", { name: "All projects" }).click();
  const sprite = await k.task(s.t.sprite.id);
  await k.row(sprite.title).waitFor({ timeout: 15000 });
  assert.deepEqual(await codesOf(k.row(sprite.title)), [`beta/${sprite.number}`]);
  assert.deepEqual(await codesOf(k.row(login.title)), [`alpha/${login.number}`]);
  await assertCodesFit(page, "[data-tasks-panel]", "1440 all projects");
  await k.shot("c04-all-projects-1440");
  await page.getByRole("tab", { name: "alpha" }).first().click();
  k.record("codes-1", "codes in rows (#N; project/N in All projects), detail breadcrumb + title, working session, children, parent, tab name; click copies the full code with a toast and opens nothing");
}

/** Search box and command palette: `#N`, `project/N` in any case, another project's code, a wrong one. */
async function searchByCode(k, s) {
  const page = k.page;
  const review = await k.task(s.t.review.id);
  const sprite = await k.task(s.t.sprite.id);
  const release = await k.task(s.t.release.id);
  await k.openTasks();
  const panel = page.locator("[data-tasks-panel]:visible").first();
  const search = panel.getByRole("textbox", { name: "Search tasks" });
  if (!(await search.isVisible().catch(() => false))) await panel.getByRole("button", { name: "Search tasks" }).click();
  await search.fill(`#${review.number}`);
  await until("only the coded task is listed", async () => (await panel.locator("[data-task-row]").count()) === 1);
  assert.deepEqual(await codesOf(panel.locator("[data-task-row]").first()), [`#${review.number}`]);
  // A desktop jumps at once: the task opens beside the list, the search keeps the focus.
  await until("the task opened", async () => (await k.detail().getAttribute("data-task-detail").catch(() => null)) === review.id, 15000);
  assert.equal(await search.evaluate((el) => el === document.activeElement), true, "the search field keeps the focus");
  await k.shot("c05-search-code-1440");

  // Another project's code is not in alpha's list; Enter finds it anyway.
  await search.fill(`BETA/${sprite.number}`);
  await panel.getByText(`BETA/${sprite.number} is not in this list. Press Enter to open it.`).waitFor({ timeout: 10000 });
  await search.press("Enter");
  await until("beta's task opened", async () => (await k.detail().getAttribute("data-task-detail").catch(() => null)) === sprite.id, 15000);
  await search.fill(`Alpha/#${release.number}`);
  await until("release listed", async () => (await panel.locator("[data-task-row]").count()) === 1 && (await panel.locator("[data-task-row]").first().innerText()).includes(release.title));
  await search.fill("#9999");
  await panel.getByText("No task #9999 here").waitFor({ timeout: 10000 });
  await search.press("Enter");
  await page.getByText("No task #9999").last().waitFor({ timeout: 10000 });
  // Bare digits stay a title search: "412" finds the review by its title, not task 412.
  await search.fill("412");
  await until("title search for 412", async () => (await panel.locator("[data-task-row]").allInnerTexts()).join("\n").includes(review.title), 15000);
  await search.fill("");
  await search.press("Escape");
  await k.selectTask(review.title);

  // The palette: the code's task first, Enter opens it.
  await page.evaluate((q) => window.dispatchEvent(new CustomEvent("open-command-palette", { detail: q })), `#${release.number}`);
  const input = page.getByPlaceholder(/Search actions & files/);
  await input.waitFor({ timeout: 10000 });
  // The palette's own row, not the task page's title behind it (which reads the same).
  const palette = page.locator("div.max-w-md", { has: input });
  await palette.locator("button", { hasText: `#${release.number} ${release.title}` }).first().waitFor({ timeout: 15000 });
  await k.shot("c06-palette-code-1440");
  await input.press("Enter");
  await until("the palette opened the task", async () => (await k.detail().getAttribute("data-task-detail").catch(() => null)) === release.id, 15000);
  await page.evaluate((q) => window.dispatchEvent(new CustomEvent("open-command-palette", { detail: q })), `beta/${sprite.number}`);
  await palette.locator("button", { hasText: `beta/${sprite.number} ${sprite.title}` }).first().waitFor({ timeout: 15000 });
  await input.press("Escape");
  k.record("codes-2", "search #N filters to one task and opens it (focus kept); BETA/N from alpha opens on Enter; Alpha/#N; wrong code says so; bare digits stay a title search; palette #N and beta/N put the task first and Enter opens it");
}

/** The manager chat: the Tasks chip's list and the composer's task chip. */
async function managerChatCodes(k, s) {
  const page = k.page;
  const login = await k.task(s.t.login.id);
  await page.goto(`${k.web}/project/alpha/chat/claude/${s.managers.alpha}`);
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.click();
  const rows = page.locator("[data-chip-task]:visible");
  await rows.first().waitFor({ timeout: 15000 });
  const codes = await codesOf(page.locator("[data-manager-tasks-list]:visible"));
  assert(codes.includes(`#${login.number}`) && codes.every((c) => /^#\d+$/.test(c)), `the chip's list shows #N codes: ${codes}`);
  await assertCodesFit(page, "[data-manager-tasks-list]", "1440 chip list");
  await k.shot("c07-manager-chip-1440");
  await page.keyboard.press("Escape");

  // "Open chat" on the task's page puts the task on the manager composer as a chip.
  await k.selectTask(login.title);
  await k.detail().locator("[data-working-session]").getByRole("button", { name: /Open chat/ }).click();
  const taskChip = page.locator("[data-task-chip]:visible").first();
  await taskChip.waitFor({ timeout: 20000 });
  assert.deepEqual(await codesOf(taskChip), [`#${login.number}`], "the composer's chip shows the task's code");
  assert.equal(await assertCodesOnBaseline(page, "[data-composer-task-refs]", "1440 composer chip"), 1, "the composer chip's code is measured");
  await k.shot("c08-composer-chip-1440");
  k.record("codes-3", "manager Tasks chip list rows #N; composer task chip #N");
}

/** "Waiting on you" and the Assistant's stream, at 1440 and in an 800 px floating window. */
async function assistantCodes(k, s) {
  const page = k.page;
  await page.goto(`${k.web}/project/alpha/assistant`);
  const body = page.locator("[data-assistant-body]:visible").first();
  await body.waitFor({ timeout: 30000 });
  // The cards come from the check steps; a run of the code steps alone (PPM_TASKS_ONLY) has none.
  const full = !process.env.PPM_TASKS_ONLY;
  const away = body.locator('[data-assistant-card="done"]', { hasText: "while you were away" }).last();
  if (full) {
    await away.waitFor({ timeout: 30000 });
    const awayCodes = await codesOf(away);
    assert(awayCodes.length >= 2 && awayCodes.every((c) => /^(alpha|beta)\/\d+$/.test(c)), `the away card's changes show project/N: ${awayCodes}`);
    await assertCodesOnBaseline(page, "[data-assistant-body]", "1440 Assistant cards");
  }
  const gamma = full ? await k.task(s.t.gammaDecision.id) : null;
  const handed = page.locator("[data-card-tasks]:visible").first();
  if (gamma && await handed.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    assert.deepEqual(await codesOf(handed), [`gamma/${gamma.number}`]);
    assert.match(await handed.innerText(), new RegExp(gamma.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  await k.shot("c09-assistant-1440");

  // The same window floating at 800 px wide (its saved rect, as a drag of its edge would leave it).
  const win = page.locator('[aria-roledescription="window"]', { has: page.locator("[data-assistant-body]") }).first();
  await win.waitFor({ timeout: 15000 });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("ppm-windows") ?? "[]");
    for (const w of saved) if (w.kind === "tab-host") { w.state = "normal"; delete w.restoreTo; w.rect = { ...w.rect, w: 800, h: 840, y: 8, x: Math.max(0, w.rect.x + w.rect.w - 800) }; }
    localStorage.setItem("ppm-windows", JSON.stringify(saved));
  });
  await page.reload();
  await win.waitFor({ timeout: 30000 });
  if (full) await page.locator("[data-assistant-body]:visible [data-assistant-card]").first().waitFor({ timeout: 30000 });
  const box = await win.boundingBox();
  assert(Math.abs(box.width - 800) <= 16, `the window is about 800 px wide (${box.width})`);
  if (full) await assertCodesFit(page, '[aria-roledescription="window"]', "800 window");
  await k.shot("c10-assistant-800", win);
  k.record("codes-4", "Assistant cards: away changes project/N, handed-off work project/N + title; 800 px floating window: no code wraps or is cut");
}

/** The phone: list, long-press sheet, detail, the chip sheet, at 390 / 360 / 320 with a long title. */
async function phoneCodes(k, s) {
  const page = await k.openPhone();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: k.web });
  const login = await k.task(s.t.login.id);
  const long = await k.task(s.long.id);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));
  const list = page.locator("[data-task-list-mobile]:visible");
  await list.waitFor({ timeout: 30000 });
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
    await page.waitForTimeout(300);
    await assertCodesFit(page, "[data-task-list-mobile]", `phone ${width} list`);
    // The long title gives way: its code whole, the title cut with an ellipsis.
    const row = page.locator("[data-task-row]", { hasText: LONG_TITLE.slice(0, 30) }).first();
    assert.deepEqual(await codesOf(row), [`#${long.number}`]);
    const titleCut = await row.locator("button[tabindex='-1']").evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.equal(titleCut, true, `the long title is ellipsized at ${width}`);
    await k.shot(`c11-phone-list-${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.locator("[data-task-row]", { hasText: login.title }).first();
  await row.dispatchEvent("contextmenu");
  const sheet = page.locator("[data-task-action-sheet]");
  await sheet.waitFor({ timeout: 10000 });
  assert.deepEqual(await codesOf(sheet), [`#${login.number}`], "the long-press sheet names the task by code");
  await assertCodesOnBaseline(page, "[data-task-action-sheet]", "phone sheet");
  await k.shot("c12-phone-sheet-390");
  await page.keyboard.press("Escape");
  await page.locator("[data-task-action-sheet]").waitFor({ state: "detached", timeout: 5000 }).catch(() => page.mouse.click(5, 5));
  await page.locator("[data-task-row]").getByText(login.title).first().tap();
  const detail = page.locator("[data-task-detail-mobile]:visible");
  await detail.waitFor({ timeout: 15000 });
  const codes = await codesOf(detail);
  assert(codes.filter((c) => c === `#${login.number}`).length >= 3, `header, title and working session carry #N: ${codes}`);
  await assertCodesFit(page, "[data-task-detail-mobile]", "phone detail");
  // A tap on the header's code copies it.
  await detail.locator("header [data-task-code]").first().tap();
  await page.getByText(`Copied alpha/${login.number}`).first().waitFor({ timeout: 10000 });
  await k.shot("c13-phone-detail-390");
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(300);
    await assertCodesFit(page, "[data-task-detail-mobile]", `phone ${width} detail`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Open chat from the task page: the manager composer takes the task as a chip.
  await detail.locator("[data-working-session]").scrollIntoViewIfNeeded();
  await detail.locator("[data-working-session]").getByRole("button", { name: /Open chat/ }).tap();
  const phoneChip = page.locator("[data-composer-task-refs] [data-task-chip]:visible").first();
  await phoneChip.waitFor({ timeout: 20000 });
  assert.deepEqual(await codesOf(phoneChip), [`#${login.number}`]);
  assert.equal(await assertCodesOnBaseline(page, "[data-composer-task-refs]", "phone 390 composer chip"), 1);
  await assertCodesFit(page, "[data-composer-task-refs]", "phone 390 composer chip");
  await k.shot("c16-phone-composer-chip-390");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${k.web}/project/alpha/chat/claude/${s.managers.alpha}`);
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  await chip.tap();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
  await assertCodesFit(page, "[data-manager-tasks-list]", "phone 320 chip sheet");
  await k.shot("c14-phone-chip-sheet-320");
  await page.setViewportSize({ width: 390, height: 844 });
  k.record("codes-5", "phone 390/360/320: list, long title ellipsized with its code whole, sheet, detail (tap copies), chip sheet — no code wraps or is cut");
}

/** Telegram `/tasks`: the deck card leads with the code, in monospace. */
async function telegramCodes(k, s) {
  const { tg, owner } = k;
  await tg.send(owner, "/tasks");
  const deck = await tg.waitFor(owner, "a /tasks deck", (m) => /\d+ of \d+ · What to do first/.test(m.text) && (m.message_id ?? 0) > 0, 30000);
  const titleLine = deck.text.split("\n")[1] ?? "";
  assert.match(titleLine, /^[A-Za-z0-9_.-]+\/\d+ \S/, `the card's title line starts with its code: ${titleLine}`);
  assert.match(deck.html ?? "", /<code>[A-Za-z0-9_.-]+\/\d+<\/code> <b>/, "the code is sent as <code>, which a tap copies");
  const shown = [{ text: "/tasks", from_user: true }, { ...deck, caption: "The first card" }];
  await k.openFrame(telegramFrame(shown, "PPM Assistant"));
  await k.shot("c15-telegram-tasks");
  k.record("codes-6", "Telegram /tasks card: `project/N Title`, the code as <code>");
}

export const CODE_STEPS = [
  { id: "codes-list-detail", run: codesInListAndDetail },
  { id: "codes-search", run: searchByCode },
  { id: "codes-manager-chat", run: managerChatCodes },
  { id: "codes-assistant", run: assistantCodes },
  { id: "codes-phone", run: phoneCodes },
  { id: "codes-telegram", run: telegramCodes },
];
