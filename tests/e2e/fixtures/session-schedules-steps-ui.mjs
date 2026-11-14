// Session-schedules e2e, the surfaces: Settings → Schedules names each session schedule's chat in
// its Session line and offers the Chat kind in its form (e), on a desktop and on a phone, plus the
// phone's run line and the chip's bottom sheet. Screenshots for both layouts.
import assert from "node:assert/strict";
import { PROJECT, PROMPT_3 } from "./session-schedules-steps.mjs";

/** The New schedule form, set to the Chat kind with this project and chat picked. */
async function fillChatKindForm(page, chatTitle, tap) {
  const press = (locator) => (tap ? locator.tap() : locator.click());
  await press(page.getByRole("button", { name: "Add", exact: true }).filter({ visible: true }).first());
  const chatKind = page.getByRole("button", { name: "Chat", exact: true }).filter({ visible: true }).first();
  await chatKind.waitFor({ timeout: 10000 });
  await press(chatKind);
  assert.equal(await chatKind.getAttribute("aria-pressed"), "true", "the Chat kind is selected");
  await press(page.getByRole("combobox").filter({ hasText: "Select project" }).first());
  await press(page.getByRole("option", { name: PROJECT, exact: true }));
  const chatPicker = page.getByRole("combobox").filter({ hasText: /Select chat|Loading chats/ }).first();
  await chatPicker.waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await press(chatPicker);
  await press(page.getByRole("option", { name: new RegExp(chatTitle) }).first());
  await page.getByRole("combobox").filter({ hasText: chatTitle }).first().waitFor({ timeout: 5000 });
}

/** Every session schedule's Session line names its chat and project. */
async function assertSessionLines(page, chats) {
  for (const chat of chats) {
    const line = page.locator(`[data-schedule-target="${chat.id}"]:visible`).first();
    await line.waitFor({ timeout: 15000 });
    const text = await line.innerText();
    assert.match(text, /Session/, `a Session line for ${chat.title}`);
    assert(text.includes(chat.title), `the line names "${chat.title}" (${text})`);
    assert(text.includes(PROJECT), `the line names the project (${text})`);
  }
}

export async function runSettingsDesktop(ctx) {
  const { kit, page, ids: { A, B } } = ctx;
  await kit.scenario("e: Settings → Schedules shows the Session column and the Chat kind (desktop)", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.locator('[data-testid="settings-rail-schedules"]').click();
    await assertSessionLines(page, [A, B]);
    await page.getByText("Morning build check").first().waitFor();
    await kit.shot(page, "desktop-settings-schedules-session-column");
    await fillChatKindForm(page, A.title, false);
    await kit.shot(page, "desktop-settings-schedule-form-chat-kind");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Close window" }).first().click();
    kit.record("e: Settings → Schedules names each schedule's chat (Session) and its form picks a chat under the Chat kind");
  });
}

export async function runPhone(ctx) {
  const { kit, sk, browser, artifacts, ids: { A, B } } = ctx;
  await kit.scenario("phone: run line, chip bottom sheet and Settings → Schedules at 390x844", async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
    await phone.addInitScript(ctx.pageInit);
    const page = ctx.current = await phone.newPage();
    try {
      await sk.open(page, A);
      // The restart check's run: it went out late, which is the note a phone moves into the panel.
      const line = sk.runLine(page, ctx.ids.S3);
      await line.waitFor({ timeout: 30000 });
      // The answers render once the markdown chunk has loaded; until then they are placeholder bars.
      await page.getByText(/Scheduled: weekdays at 09:00/).first().waitFor({ timeout: 15000 });
      await line.scrollIntoViewIfNeeded();
      const button = line.locator("button").first();
      const box = await button.boundingBox();
      assert(box.height >= 44, `the run line is a 44px touch target (${box.height})`);
      const collapsed = await button.innerText();
      assert.match(collapsed, /Restart check/, `the schedule's name is shown in full (${collapsed})`);
      assert.doesNotMatch(collapsed, /sent late/, "on a phone the note waits in the opened panel");
      const name = await button.locator("span.truncate").evaluate((el) => el.scrollWidth <= el.clientWidth);
      assert(name, "the name is not cut short");
      await page.screenshot({ path: `${artifacts}/phone-chat-schedule-run-line.png` });
      await button.tap();
      await line.getByText(PROMPT_3).waitFor({ timeout: 5000 });
      assert.match(await line.innerText(), /sent late/, "the opened panel says it was sent late");
      await page.screenshot({ path: `${artifacts}/phone-chat-schedule-run-line-expanded.png` });
      kit.record("phone: the run line is a 44px target showing the whole name, and opens to its prompt with the sent-late note");

      const chip = page.locator('[data-testid="session-schedules-chip"]:visible').first();
      await chip.waitFor({ timeout: 15000 });
      assert.match(await chip.innerText(), /2/, "chat A has two schedules now");
      await chip.tap();
      const item = page.locator(`[data-session-schedule="${ctx.ids.S1}"]:visible`).first();
      await item.waitFor({ timeout: 10000 });
      const toggle = await item.locator('[data-testid="session-schedule-toggle"]').boundingBox();
      assert(toggle.height >= 44, `Pause is a 44px target in the sheet (${toggle.height})`);
      await page.waitForTimeout(400); // the sheet's slide-up
      await page.screenshot({ path: `${artifacts}/phone-schedules-chip-sheet.png` });
      // A phone has no Escape: a tap on the dimmed backdrop above the sheet closes it.
      await page.touchscreen.tap(195, 40);
      await item.waitFor({ state: "detached", timeout: 5000 });
      kit.record("phone: the chip opens a bottom sheet listing the chat's schedules");

      await page.locator('button[aria-label="Open menu"]').click();
      await page.locator("button", { hasText: /^Settings$/ }).filter({ visible: true }).first().tap();
      await page.locator('[data-testid="settings-index-schedules"]').tap();
      await assertSessionLines(page, [A, B]);
      await page.screenshot({ path: `${artifacts}/phone-settings-schedules-session-column.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `no sideways scroll (${overflow}px)`);
      await fillChatKindForm(page, A.title, true);
      await page.screenshot({ path: `${artifacts}/phone-settings-schedule-form-chat-kind.png` });
      kit.record("phone: Settings → Schedules shows the Session lines without sideways scroll, and the Chat kind form fits");
    } finally {
      ctx.current = ctx.page;
      await phone.close();
    }
  });
}
