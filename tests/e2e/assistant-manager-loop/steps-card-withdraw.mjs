// Step 15 of the manager loop: a manager replaces a card the user had not answered yet, then
// withdraws another it learns is handled. The replaced card says what replaced it in PPM and on
// Telegram (its copy rewritten, no buttons left, the new card sent as a reply under it), the
// withdrawn card leaves Waiting on you, and Restore in PPM brings one back to the user. Shot at
// 1440 and 390: the replaced card with Restore, the manager chat's tool card, and the rewritten
// Telegram message as the fake Bot API holds it.
import assert from "node:assert/strict";
import { assertNoButtons, telegramCard, until } from "./loop-kit.mjs";

const A = "Pay the photographer's deposit?";
const B = "Pay the photographer's deposit today?";
const C = "Book the venue for the launch?";

/** The rewritten Telegram copy, drawn as a chat bubble so a screenshot can show it. */
async function shootTelegram(k, name, messages) {
  const page = await k.page.context().newPage();
  const bubbles = messages.map((m) => `<div class="b">${m.html ?? m.text.replace(/</g, "&lt;")}${m.reply_to ? `<div class="r">↳ reply to message ${m.reply_to}</div>` : ""}</div>`).join("");
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0e1621;font:15px system-ui;color:#e9eef3;padding:16px}
    .b{background:#182533;border-radius:12px;padding:10px 12px;margin:0 0 10px;max-width:520px;white-space:pre-wrap}
    .r{margin-top:6px;font-size:12px;color:#6ab3f3} i{color:#aab7c4} b{color:#fff}</style>${bubbles}`);
  await page.setViewportSize({ width: k.page.viewportSize().width, height: 600 });
  await page.screenshot({ path: `${k.shotsDir}/${name}.png` });
  await page.close();
}

/** 15. A card replaced and one withdrawn by the manager; the user brings one back with Restore. */
export async function step15(k, s) {
  // A: a decision the user does not get to in time.
  await k.managerTurn("alpha", s.aChat, "s15-a", [{
    session: "report_to_assistant", args: { kind: "needs_decision", title: A, body: "Invoice **12** is due this week." },
  }], "Ask the user about the photographer's deposit");
  const [ra] = await k.answered("s15-a", 1);
  assert.equal(ra.isError, false, ra.text);
  const a = await k.cardOf("needs_decision", A);
  const aOnPhone = await telegramCard(k.tg, k.owner, A);
  await k.idle(s.aChat);

  // B replaces A: the user asked again elsewhere, and the deposit is now due today.
  await k.managerTurn("alpha", s.aChat, "s15-b", [{
    session: "report_to_assistant",
    args: { kind: "needs_decision", title: B, body: "The invoice is due **today**.", supersedes: [a.id] },
  }], "The deposit is due today, ask the user again");
  const [rb] = await k.answered("s15-b", 1);
  assert.equal(rb.isError, false, rb.text);
  const filed = k.parse(rb);
  assert.deepEqual(filed.withdrawn, [{ card: a.id, outcome: "withdrawn" }], "A was withdrawn by the report that replaced it");
  const replaced = await until("A says it was replaced", async () => {
    const c = (await k.cards()).find((x) => x.id === a.id);
    return c?.status === "dismissed" && c.answer?.withdrawn?.supersededBy?.id === filed.cardId ? c : null;
  });
  assert.equal(replaced.answer.by, "manager");
  const waitingIds = async () => (await k.fx.api("/api/assistant/cards/open")).data.cards.map((c) => c.id);
  assert.ok(!(await waitingIds()).includes(a.id), "A left Waiting on you");
  assert.ok((await waitingIds()).includes(filed.cardId), "B waits instead");

  // Telegram: A's copy rewritten with no buttons, B sent as a reply under it.
  const aEdited = await k.tg.waitFor(k.owner, "A's copy says it was replaced", (m) => m.message_id === aOnPhone.message_id && m.text.includes("Replaced by"));
  assertNoButtons(aEdited, "the replaced card can no longer be answered on the phone");
  const bOnPhone = await k.tg.waitFor(k.owner, "B under A", (m) => m.text.includes(B) && m.reply_to === aOnPhone.message_id);
  await k.idle(s.aChat);

  // C: a card the user handles outside PPM, then tells the manager; it withdraws it.
  await k.managerTurn("alpha", s.aChat, "s15-c", [{
    session: "report_to_assistant", args: { kind: "needs_decision", title: C, body: "Two venues are free." },
  }], "Ask the user about the venue");
  await k.answered("s15-c", 1);
  const c = await k.cardOf("needs_decision", C);
  await k.idle(s.aChat);
  await k.managerTurn("alpha", s.aChat, "s15-withdraw", [{
    session: "report_withdraw", args: { cards: [c.id], reason: "You booked the venue yourself" },
  }], "I booked the venue myself");
  const [rw] = await k.answered("s15-withdraw", 1);
  assert.equal(rw.isError, false, rw.text);
  assert.deepEqual(k.parse(rw).withdrawn, [{ card: c.id, title: C, outcome: "withdrawn" }]);
  await until("C withdrawn", async () => (await k.cards()).find((x) => x.id === c.id)?.answer?.withdrawn?.reason === "You booked the venue yourself");
  await k.idle(s.aChat);

  // PPM: the replaced card, opened from its folded line, says what replaced it, with Restore.
  // The step before leaves Settings open as a window, which the page restores over everything:
  // forget it, then start from the Assistant itself.
  await k.page.evaluate(() => localStorage.removeItem("ppm-windows"));
  await k.page.goto(`${k.web}/project/alpha/assistant`, { waitUntil: "domcontentloaded" });
  const fold = k.body().locator("[data-answered-card]", { hasText: A }).last();
  await fold.waitFor({ timeout: 20000 });
  assert.match(await fold.innerText(), /Replaced by/);
  await fold.locator("[data-answered-toggle]").click();
  const opened = fold.locator('[data-assistant-card="needs_decision"]');
  await opened.locator("[data-card-withdrawn-actions]").waitFor({ timeout: 10000 });
  await opened.scrollIntoViewIfNeeded();
  await k.shot("30-replaced-card-restore-1440");
  // Show new card takes the user to B in the set of decisions, which says what it replaces.
  assert.deepEqual((await k.cards()).find((x) => x.id === filed.cardId)?.payload.supersedes, [{ id: a.id, title: A }]);
  await opened.getByRole("button", { name: "Show new card" }).click();
  const replacesLine = k.body().locator("[data-card-replaces]:visible", { hasText: A }).first();
  await replacesLine.waitFor({ timeout: 10000 });
  await replacesLine.scrollIntoViewIfNeeded();
  await k.shot("30b-new-card-replaces-1440");

  // The manager chat, with its report and withdraw tool cards.
  await k.page.goto(`${k.web}/project/alpha?openChat=claude/${s.aChat}`, { waitUntil: "domcontentloaded" });
  const toolCard = k.page.locator('[data-ppm-tool-card*="report_withdraw"]:visible').last();
  await toolCard.waitFor({ timeout: 20000 });
  assert.match(await toolCard.innerText(), /Withdrew cards/);
  await toolCard.scrollIntoViewIfNeeded();
  await k.shot("31-withdraw-tool-card-1440");
  await shootTelegram(k, "32-telegram-replaced-1440", [await k.tg.message(k.owner, aOnPhone.message_id), bOnPhone]);

  // Phone width: the same two views.
  await k.page.setViewportSize({ width: 390, height: 844 });
  // A phone has no floating windows: the manager chat opens as a tab, by its link.
  await k.page.goto(`${k.web}/project/alpha?openChat=claude/${s.aChat}`, { waitUntil: "domcontentloaded" });
  const phoneTool = k.page.locator('[data-ppm-tool-card*="report_withdraw"]:visible').last();
  await phoneTool.waitFor({ timeout: 30000 });
  await phoneTool.scrollIntoViewIfNeeded();
  await k.shot("33-withdraw-tool-card-390");
  await shootTelegram(k, "34-telegram-replaced-390", [await k.tg.message(k.owner, aOnPhone.message_id), bOnPhone]);
  await k.page.goto(`${k.web}/project/alpha/assistant`, { waitUntil: "domcontentloaded" });
  const phoneFold = k.page.locator("[data-answered-card]:visible", { hasText: A }).last();
  await phoneFold.waitFor({ timeout: 30000 });
  await phoneFold.locator("[data-answered-toggle]").click();
  const phoneCard = phoneFold.locator('[data-assistant-card="needs_decision"]');
  await phoneCard.locator("[data-card-withdrawn-actions]").waitFor({ timeout: 10000 });
  await phoneCard.scrollIntoViewIfNeeded();
  await k.shot("35-replaced-card-restore-390");

  // Restore in PPM: A waits again, and goes to the phone once more with its buttons.
  await phoneCard.getByRole("button", { name: "Restore" }).click();
  await until("A waits again", async () => (await waitingIds()).includes(a.id));
  await k.tg.waitFor(k.owner, "A sent again", (m) => m.text.includes(A) && m.message_id !== aOnPhone.message_id && (m.reply_markup?.inline_keyboard?.flat().length ?? 0) > 0);
  await k.page.setViewportSize({ width: 1440, height: 900 });
  await k.page.goto(`${k.web}/project/alpha/assistant`, { waitUntil: "domcontentloaded" });
  k.record("15", "a replacing report withdraws the old card (PPM: Replaced by + Restore; Telegram: copy rewritten, new card under it); report_withdraw takes back a handled card; Restore brings one back", {
    replaced: a.id, by: filed.cardId, withdrawn: c.id,
  });
}

