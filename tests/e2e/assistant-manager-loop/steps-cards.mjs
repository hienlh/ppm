// Steps 3–6 of the manager loop: a decision card on both surfaces and its counts, a Telegram reply
// forwarded word for word, a manager's approval allowed in PPM, a done report and a late reply as
// wake turns answered "[no reply]".
import assert from "node:assert/strict";
import { labelsOf } from "../assistant-telegram/harness.mjs";
import { assertNoButtons, telegramCard, until } from "./loop-kit.mjs";

const NEWS_OPENER = "[PPM] News from manager chats";
const DECISION = "Slack draft to the client about the release";

const wakeTurns = async (k, s) => (await k.turnsIn(s.main)).filter((t) => t.message.includes(NEWS_OPENER));
const rail = (k, label) => k.page.locator(`button[aria-label="${label}"]`).first();

/** 3. A's manager reports needs_decision with a draft: a card in PPM and on Telegram; rail, dock and chip say 1. */
export async function step3(k, s) {
  await k.managerTurn("alpha", s.aChat, "s3-report", [{
    session: "report_to_assistant",
    args: { kind: "needs_decision", title: DECISION, body: "The fix is ready.", draft: { to: "#client-devs → Lead", text: "The pension fix is ready; it goes to staging today." } },
  }], "Draft the client update for the release");
  const [report] = await k.answered("s3-report", 1);
  assert.equal(report.isError, false, report.text);
  const card = await k.cardOf("needs_decision", DECISION);
  assert.equal(card.provenance, "Written by the alpha manager AI");
  s.decisionCard = card;
  await k.streamCard("needs_decision", DECISION).waitFor({ timeout: 20000 });
  const onPhone = await telegramCard(k.tg, k.owner, DECISION);
  assert.ok(onPhone.text.includes("Written by the alpha manager AI"));
  assert.ok(labelsOf(onPhone).includes("OK, send"), `Telegram offers OK (${labelsOf(onPhone).join(", ")})`);
  s.decisionMessage = onPhone.message_id;
  assert.equal((await k.waiting()).total, 1);
  await rail(k, "PPM Assistant · 1 waiting").waitFor({ timeout: 15000 });
  const chip = k.body().locator('[data-manager-chip="alpha"]');
  await until("chip count", async () => /· 1 waiting$/.test(await chip.getAttribute("aria-label") ?? ""), 15000);
  const dock = k.page.locator('[role="toolbar"][aria-label="Windows"] button[data-chip]:visible', { hasText: "Assistant" });
  await until("dock count", async () => /· 1 waiting$/.test(await dock.first().getAttribute("aria-label") ?? ""), 15000);
  await k.shot("05-decision-card-counts");
  k.record("3", "needs_decision with a draft: card in PPM and on Telegram (with OK), rail, dock and chip show 1");
}

/** 4. The user replies to the card on Telegram: the manager gets the exact words, and the card is answered everywhere. */
export async function step4(k, s) {
  const text = "Change “today” to “tomorrow morning”, then send it 👍";
  await k.tg.send(k.owner, text, { extra: { reply_to_message: { message_id: s.decisionMessage, chat: { id: k.owner, type: "private" }, date: 0 } } });
  const got = await until("the manager got the reply", async () => (await k.turnsIn(s.aChat)).find((t) => t.blocks.content === text), 30000);
  assert.equal(got.blocks.userWords?.channel, "telegram", "carried as the user's own words");
  assert.equal(got.blocks.userWords?.cardId, s.decisionCard.id, "naming the card it answers");
  assert.equal(got.blocks.fromSession, null, "not another session's message");
  await until("card answered", async () => (await k.cards()).find((c) => c.id === s.decisionCard.id)?.status === "answered");
  await k.body().locator('[data-assistant-card="needs_decision"][data-card-status="answered"]', { hasText: DECISION }).waitFor({ timeout: 15000 });
  const edited = await k.tg.waitFor(k.owner, "the card lost its buttons", (m) => m.message_id === s.decisionMessage && !labelsOf(m).includes("OK, send"));
  assertNoButtons(edited, "no button is left on the answered card");
  await k.tg.waitText(k.owner, "word for word");
  assert.equal((await k.waiting()).total, 0);
  await rail(k, "PPM Assistant").waitFor({ timeout: 15000 });
  await k.shot("06-decision-answered");
  k.record("4", "a Telegram reply to the card reaches the manager byte for byte as the user's words; the card is answered in PPM and on Telegram");
}

/** 5. B's manager asks for a provider approval: a card; Allow in PPM runs it; the Telegram copy loses its buttons. */
export async function step5(k, s) {
  await k.managerTurn("beta", s.bChat, "s5-deploy", [{ builtin: "Bash", input: { command: "npm run deploy" } }], "Deploy beta to staging", "default");
  const card = await k.cardOf("approval");
  assert.equal(card.payload.deciding?.text, "npm run deploy");
  const onPhone = await k.tg.waitFor(k.owner, "approval on Telegram", (m) => m.text.includes("npm run deploy") && labelsOf(m).includes("Allow"));
  const inPpm = k.streamCard("approval", "npm run deploy");
  await inPpm.waitFor({ timeout: 20000 });
  await k.shot("07-approval-card");
  await inPpm.getByRole("button", { name: "Allow" }).click();
  const [bash] = await k.answered("s5-deploy", 1);
  assert.equal(bash.approved, true, "the command was allowed");
  await until("card answered", async () => (await k.cards()).find((c) => c.id === card.id)?.status === "answered");
  const closed = await k.tg.waitFor(k.owner, "approval lost its buttons", (m) => m.message_id === onPhone.message_id && labelsOf(m).length === 0);
  assertNoButtons(closed, "Telegram can no longer answer it");
  await k.idle(s.bChat);
  k.record("5", "B's provider approval: card in PPM and on Telegram; Allow in PPM runs it; Telegram loses its buttons");
}

/** 6. B reports done: one wake turn answered [no reply], folded, not on Telegram; a late reply is one more wake. */
export async function step6(k, s) {
  const before = (await wakeTurns(k, s)).length;
  await k.managerTurn("beta", s.bChat, "s6-done", [{ session: "report_to_assistant", args: { kind: "done", title: "Staging deploy finished", body: "All smoke tests green." } }], "Tell the Assistant when staging is done", "default");
  await k.cardOf("done", "Staging deploy finished");
  await telegramCard(k.tg, k.owner, "Staging deploy finished");
  const wake = await until("a wake turn for the report", async () => (await wakeTurns(k, s)).find((t) => (t.sharedContext ?? "").includes("Staging deploy finished")));
  await k.idle(s.main);
  await k.body().locator("[data-wake-turn]").first().waitFor({ timeout: 15000 });
  assert.match(await k.body().locator("[data-wake-turn]").last().innerText(), /Assistant read/);

  // An ask nobody waits for: the manager's answer comes back later, as one more wake.
  const ask = "Is beta's nightly job green?";
  await k.script("s6-beta-answers", [], { match: ask, sessionId: s.bChat, reply: "Beta: the nightly job is green." });
  await k.askAssistant("s6-ask-beta", [{ session: "send_to_session", args: { session_id: s.bChat, message: ask } }], "Ask beta about the nightly job");
  const [asked] = await k.answered("s6-ask-beta", 1);
  assert.equal(asked.isError, false, asked.text);
  const late = await until("a wake turn for the late reply", async () => (await wakeTurns(k, s)).find((t) => (t.sharedContext ?? "").includes("the nightly job is green")), 60000);
  assert.match(late.sharedContext, /answered your earlier message/);
  await k.idle(s.main);
  const wakes = (await wakeTurns(k, s)).length - before;
  assert.equal(wakes, 2, "one wake for the report, one for the late reply");
  assert.ok(wake.at < late.at);
  const sent = (await k.tg.sent(k.owner)).map((m) => m.text);
  assert.ok(!sent.some((t) => t.includes("[no reply]")), "a [no reply] answer never reaches Telegram");
  await k.shot("08-wake-turns-folded");
  k.record("6", "done report → card + one wake turn answered [no reply], folded in PPM, not on Telegram; a late reply → one more wake", { wakes });
}
