// Steps 13 and 14 of the manager loop: every card a chat waits on reaches the user, and approvals
// the user chose to remember.
//
// 13. A chat waits on a command's card; a session tool's card queued behind it is mirrored with
//     nothing to press; the first card, left unanswered, says since when and rings the phone
//     again; "Allow & remember" on its mirror allows it and makes a rule, the queued card comes to
//     the front (and goes to the phone), and the next request of that kind runs with no card,
//     leaving one line in the chat.
// 14. Three approvals of the same kind by hand, and the fourth card suggests remembering it, in
//     the chat itself; pressed there, the rule shows in Settings → Approvals, where it is removed.
import assert from "node:assert/strict";
import { until } from "./loop-kit.mjs";

const QUEUED_TITLE = "Debug the pension import";

const rules = async (k) => (await k.fx.api("/api/approval-rules")).data;

/**
 * A button's drawn height: the chat footer's chip size for a button with text (28px desktop, 26px
 * phone) and its icon-button size (24 / 22px), design guidelines, Mobile-First rule 3.
 */
async function assertHeight(locator, px, what) {
  const box = await locator.boundingBox();
  assert.ok(box, `${what} is drawn`);
  assert.equal(Math.round(box.height), px, `${what} is ${px}px tall`);
}

/** Opens a chat of project alpha by its id (its name changes once its first message names it). */
async function openChat(k, sessionId) {
  await k.page.goto(`${k.web}/project/alpha/chat/claude/${sessionId}`);
  await k.page.locator('textarea[aria-label="Message"]:visible').first().waitFor({ timeout: 30000 });
}

/** 13. Queued and overdue cards reach the user; Allow & remember makes a rule that then approves by itself. */
export async function step13(k, s) {
  const chat = (await k.fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: "Alpha checks" })).data.id;
  s.checksChat = chat;
  // A card left unanswered counts as overdue after 4 s rather than 3 minutes, for this step only.
  await k.fx.post("/__assistant-test/approval-overdue", { ms: 4000 });
  // The turn goes on after the command (as a turn whose own tool call raised a session tool's card
  // would): PPM's own cards end with the turn that showed them.
  await k.managerTurn("alpha", chat, "s13-status", [{ builtin: "Bash", input: { command: "git status" } }, { sleep: 20000 }], "Check the tree", "default");
  const front = await until("the command's card", async () =>
    (await k.cards()).find((c) => c.kind === "approval" && c.sessionId === chat && c.status === "open"), 30000);
  assert.deepEqual(front.payload.remember, { label: "Run `git status`", suggest: false }, "the card says what it would remember");

  // A session tool's card raised while the command's card is on the chat's screen waits behind it.
  const queued = await k.fx.post("/__assistant-test/collab-card", {
    sessionId: chat, waitMs: 600000,
    input: { kind: "create", title: QUEUED_TITLE, providerId: "claude", model: null, task: "Look at the failing import", depth: 1 },
  });
  const behind = await until("the queued card's mirror", async () =>
    (await k.cards()).find((c) => c.payload.requestId === queued.requestId && c.status === "open"), 15000);
  assert.equal(behind.payload.queued, true, "mirrored as queued");
  const refused = await k.fx.call(`/api/assistant/cards/${behind.id}/answer`, { method: "POST", body: JSON.stringify({ decision: "allow" }) });
  assert.equal(refused.status, 409, "a queued card cannot be answered yet");

  // Left unanswered (the e2e sets PPM_APPROVAL_OVERDUE_MS short): since when, and a ring on the phone.
  await until("the command's card is overdue", async () =>
    (await k.cards()).find((c) => c.id === front.id)?.payload.waitingSince, 20000);
  await k.tg.waitText(k.owner, "Still waiting for you since");

  await k.page.goto(`${k.web}/project/alpha/assistant`);
  const overdue = k.streamCard("approval", "git status");
  await overdue.waitFor({ timeout: 30000 });
  await overdue.locator("[data-card-waiting-since]").waitFor({ timeout: 15000 });
  await k.body().locator("[data-card-queued]").first().waitFor({ timeout: 15000 });
  await overdue.scrollIntoViewIfNeeded();
  await assertHeight(overdue.getByRole("button", { name: "Allow & remember" }), 28, "Allow & remember on a desktop");
  await k.shot("18-waiting-queued-overdue-1440");
  await k.page.setViewportSize({ width: 390, height: 844 });
  await k.page.waitForTimeout(600);
  const onPhone = k.page.locator(`[data-assistant-card="approval"]:visible`, { hasText: "git status" }).last();
  await onPhone.scrollIntoViewIfNeeded();
  await assertHeight(onPhone.getByRole("button", { name: "Allow & remember" }), 26, "Allow & remember on a phone");
  await k.shot("19-waiting-queued-overdue-390");
  await onPhone.getByRole("button", { name: "Allow & remember" }).click();
  await k.page.setViewportSize({ width: 1440, height: 900 });

  const [ran] = await k.answered("s13-status", 1);
  assert.equal(ran.approved, true, "Allow & remember allowed the command");
  const made = await until("the rule", async () => (await rules(k)).rules.find((r) => r.pattern === "git status"), 15000);
  assert.equal(made.createdVia, "assistant_card");
  // The queued card is in front now: answerable, and on the phone.
  await until("the queued card answerable", async () => {
    const c = (await k.cards()).find((x) => x.id === behind.id);
    return c && !c.payload.queued ? c : null;
  }, 15000);
  await k.tg.waitText(k.owner, QUEUED_TITLE);
  await k.fx.api(`/api/assistant/cards/${behind.id}/answer`, { method: "POST", body: JSON.stringify({ decision: "deny" }) });
  await k.fx.post("/__assistant-test/approval-overdue", { ms: null });
  await k.idle(chat);

  // The same kind again, with the chat open: approved by the rule, no card, one line in the chat.
  // (The line is the turn's own event: a chat opened after the turn ended reads its transcript,
  // which does not hold it.)
  await openChat(k, chat);
  const cardsBefore = (await k.cards()).length;
  await k.managerTurn("alpha", chat, "s13-again", [{ builtin: "Bash", input: { command: "git status --short" } }, { sleep: 8000 }], "Check the tree again", "default");
  const [again] = await k.answered("s13-again", 1);
  assert.equal(again.approved, true, "the rule approved it");
  assert.equal((await k.cards()).length, cardsBefore, "no card was made");
  const notice = k.page.locator('[data-testid="auto-approved-notice"]:visible').last();
  await notice.waitFor({ timeout: 30000 });
  assert.match(await notice.innerText(), /Approved by your rule: Run `git status`/);
  await notice.scrollIntoViewIfNeeded();
  await k.shot("20-auto-approved-line-1440");
  await k.idle(chat);
  k.record("13", "a queued card is mirrored with nothing to press and goes to the phone once in front; an overdue card says since when and rings again; Allow & remember on the mirror makes a rule that approves the next request with one line in the chat");
}

/** 14. The fourth card of a kind allowed by hand three times suggests remembering it; Settings lists and removes rules. */
export async function step14(k, s) {
  const chat = s.checksChat;
  for (let i = 1; i <= 3; i++) {
    await k.managerTurn("alpha", chat, `s14-hand-${i}`, [{ builtin: "Bash", input: { command: "bun test tests/unit" } }], `Run the unit tests ${i}`, "default");
    const card = await until(`hand card ${i}`, async () =>
      (await k.cards()).find((c) => c.kind === "approval" && c.sessionId === chat && c.status === "open" && c.payload.deciding?.text === "bun test tests/unit"), 30000);
    assert.equal(card.payload.remember?.suggest, false, `card ${i} does not suggest yet`);
    await k.fx.api(`/api/assistant/cards/${card.id}/answer`, { method: "POST", body: JSON.stringify({ decision: "allow" }) });
    await k.answered(`s14-hand-${i}`, 1);
    await k.idle(chat);
  }

  await openChat(k, chat);
  await k.managerTurn("alpha", chat, "s14-fourth", [{ builtin: "Bash", input: { command: "bun test tests/unit" } }], "Run the unit tests 4", "default");
  const offer = k.page.locator('[data-remember-offer="suggest"]:visible').last();
  await offer.waitFor({ timeout: 30000 });
  assert.match(await offer.innerText(), /You have allowed this 3 times/);
  await offer.scrollIntoViewIfNeeded();
  await assertHeight(offer.getByRole("button", { name: "Allow & remember" }), 28, "Allow & remember in the chat on a desktop");
  await k.shot("21-chat-card-suggest-1440");
  await k.page.setViewportSize({ width: 390, height: 844 });
  await k.page.waitForTimeout(600);
  const phoneOffer = k.page.locator('[data-remember-offer="suggest"]:visible').last();
  await phoneOffer.scrollIntoViewIfNeeded();
  await assertHeight(phoneOffer.getByRole("button", { name: "Allow & remember" }), 26, "Allow & remember in the chat on a phone");
  await k.shot("22-chat-card-suggest-390");
  await phoneOffer.getByRole("button", { name: "Allow & remember" }).click();
  await k.page.setViewportSize({ width: 1440, height: 900 });
  const [fourth] = await k.answered("s14-fourth", 1);
  assert.equal(fourth.approved, true);
  const made = await until("the bun test rule", async () => (await rules(k)).rules.find((r) => r.pattern === "bun test"), 15000);
  assert.equal(made.createdVia, "chat", "made by a press in the chat");
  await k.idle(chat);

  await k.page.goto(`${k.web}/project/alpha?openSettings=approvals`);
  const pane = k.page.locator('[data-testid="remembered-approvals-section"]:visible').first();
  await pane.waitFor({ timeout: 30000 });
  await pane.locator(`[data-rule-id="${made.id}"]`).waitFor({ timeout: 15000 });
  await assertHeight(pane.locator(`[data-rule-id="${made.id}"]`).getByRole("button", { name: /Remove/ }), 24, "a rule's Remove on a desktop");
  await k.shot("23-settings-approvals-1440");
  // A phone opens Settings as a tab of its own, not a window: opened again at that width.
  await k.page.setViewportSize({ width: 390, height: 844 });
  await k.page.goto(`${k.web}/project/alpha?openSettings=approvals`);
  await k.page.locator(`[data-testid="remembered-approvals-section"]:visible [data-rule-id="${made.id}"]`).waitFor({ timeout: 30000 });
  await assertHeight(k.page.locator(`[data-rule-id="${made.id}"]:visible`).getByRole("button", { name: /Remove/ }), 22, "a rule's Remove on a phone");
  await k.shot("24-settings-approvals-390");
  await k.page.setViewportSize({ width: 1440, height: 900 });
  await k.page.locator(`[data-rule-id="${made.id}"]:visible`).getByRole("button", { name: /Remove/ }).click();
  await until("the rule removed", async () => !(await rules(k)).rules.some((r) => r.id === made.id), 15000);
  k.record("14", "after three approvals by hand the fourth card suggests remembering, in the chat (1440 and 390); pressed there it makes a rule listed in Settings → Approvals (1440 and 390), where it is removed");
}
