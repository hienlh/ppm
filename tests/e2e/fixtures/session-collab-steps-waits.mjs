// Session-collaboration e2e, waits that never hold a message back: a waiting chat whose wait is
// ended by another chat's message, which it then reads in the same turn while the reply it waited
// for still arrives later as a message (W1); the user's answer to a card, forwarded from Telegram,
// ending the wait the same way (W2); the Stop waiting button on the card (W3); and a send without
// a wait, whose card says the reply is pending without a spinner (W4). Each card is shot on a
// 1440 px desktop and a 390 px phone.
//
// `runWaitCardShots(ctx, "before")` takes only the waiting and no-wait card shots, so the same
// cards can be compared on a bundle built before the card changed (PPM_COLLAB_WAIT_SHOTS=before).
import assert from "node:assert/strict";
import { resultOf } from "./session-collab-helpers.mjs";

const SEND_CARD = '[data-session-collab-card="send_to_session"]:visible';

/** Three fresh chats, so the earlier scenarios' pair counts and holds play no part. */
async function freshChats(ctx) {
  const { ck, ids } = ctx;
  if (!ids.lead) {
    ids.lead = await ck.newSession("claude", "Lead");
    ids.worker = await ck.newSession("claude", "Worker");
    ids.notes = await ck.newSession("claude", "Notes");
  }
  return { lead: ids.lead, worker: ids.worker, notes: ids.notes };
}

/** The "PPM has new features" step covers the chat on a phone: put it off so the card shows. */
async function dismissFeatureIntro(page) {
  const later = page.getByRole("button", { name: "Later", exact: true });
  for (let i = 0; i < 5 && await later.first().isVisible().catch(() => false); i++) {
    await later.first().click();
    await page.waitForTimeout(300);
  }
}

/** The newest send card of the chat on screen, on the desktop page and on a phone, as PNGs. */
async function shootCard(ctx, chat, name) {
  const { page, kit, ck } = ctx;
  await dismissFeatureIntro(page);
  const card = page.locator(SEND_CARD).last();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${ctx.artifacts}/${name}-desktop-1440.png` });
  await kit.shot(page, `${name}-desktop-1440-page`);
  const phone = await ctx.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  try {
    await phone.addInitScript(ctx.pageInit);
    const phonePage = await phone.newPage();
    // `show` clears the panel layout in localStorage, which a blank page has none of.
    await phonePage.goto(`${ctx.web}/project/alpha`);
    await ck.show(phonePage, [chat]);
    const phoneCard = phonePage.locator(SEND_CARD).last();
    await phoneCard.waitFor({ timeout: 20000 });
    await dismissFeatureIntro(phonePage);
    await phoneCard.scrollIntoViewIfNeeded();
    await phoneCard.screenshot({ path: `${ctx.artifacts}/${name}-phone-390.png` });
    await phonePage.screenshot({ path: `${ctx.artifacts}/${name}-phone-390-page.png` });
  } finally {
    await phone.close();
  }
  await ck.show(page, [chat]);
}

/** Lead sends to Worker with `wait: true` and stands in the wait; answers the call record's index. */
async function leadWaitsOnWorker(ctx, { workerSteps, leadAfter }) {
  const { page, ck } = ctx;
  const { lead, worker } = await freshChats(ctx);
  // A scenario that failed midway leaves a turn held: end it so this one starts from idle chats.
  await ck.release(lead.id);
  await ck.release(worker.id);
  await ctx.kit.until("Lead and Worker idle", async () => {
    const [a, b] = [await ck.live(lead.id), await ck.live(worker.id)];
    return (!a || a.phase === "idle") && (!b || b.phase === "idle");
  }, 15000);
  await ck.plan(worker.id, ck.steps(...workerSteps));
  await ck.plan(lead.id, ck.steps(
    { call: "send_to_session", args: { session_id: worker.id, message: "Review the parser change, then reply to me.", wait: true } },
    ...leadAfter,
  ));
  const from = (await ck.calls()).length;
  await ck.show(page, [lead]);
  await ck.send(page, "Ask Worker to review the parser change.");
  await page.locator(`${SEND_CARD} [data-collab-waiting]`).last().waitFor({ timeout: 20000 });
  // The wait is registered: Worker's turn has started with the message.
  await ctx.kit.until("Worker read the message", async () => (await ck.sends()).some((s) => s.sessionId === worker.id && /Review the parser change/.test(s.content)), 15000);
  return from;
}

export async function runWaitCardShots(ctx, phase) {
  const { page, ck, kit } = ctx;
  const { lead, worker } = await freshChats(ctx);

  await kit.scenario(`W-shots (${phase})`, async () => {
    await leadWaitsOnWorker(ctx, {
      workerSteps: [{ say: "Reviewing." }, { hold: true }, { say: "Reviewed." }],
      leadAfter: [{ say: "Back to the plan." }],
    });
    await shootCard(ctx, lead, `${phase}-01-waiting-card`);
    // Worker finishes without replying: the wait ends and Lead's turn finishes.
    await ck.release(worker.id);
    await page.locator("text=Back to the plan.").first().waitFor({ timeout: 20000 });

    await ck.plan(worker.id, ck.steps({ say: "On it." }, { hold: true }, { say: "Done." }));
    await ck.plan(lead.id, ck.steps(
      { call: "send_to_session", args: { session_id: worker.id, message: "Also check the lexer.", wait: false } },
      { say: "Asked Worker." },
    ));
    await ck.send(page, "Hand the lexer to Worker too.");
    await page.locator("text=Asked Worker.").first().waitFor({ timeout: 20000 });
    await shootCard(ctx, lead, `${phase}-02-sent-no-wait-card`);
    await ck.release(worker.id);
    kit.record(`W-shots (${phase}): the waiting card and the no-wait card, desktop 1440 and phone 390`);
  });
}

export async function runWaitSteps(ctx) {
  const { page, kit, ck } = ctx;
  await runWaitCardShots(ctx, "after");
  const { lead, worker, notes } = await freshChats(ctx);

  // ── W1: another chat writes to Lead mid-wait: the wait ends at once, Lead reads it, and Worker's reply still arrives ──
  await kit.scenario("W1", async () => {
    const from = await leadWaitsOnWorker(ctx, {
      workerSteps: [
        { say: "Reviewing." }, { hold: true },
        { call: "send_to_session", args: { session_id: lead.id, message: "Review done: two nits." } },
        { say: "Replied to Lead." },
      ],
      leadAfter: [{ say: "Reading the new message first." }, { hold: true }, { say: "All read." }],
    });
    const card = page.locator(SEND_CARD).last();
    await card.getByRole("button", { name: "Stop waiting" }).waitFor({ timeout: 10000 });

    await ck.plan(notes.id, ck.steps(
      { call: "send_to_session", args: { session_id: lead.id, message: "The changelog link is in.", wait: false } },
      { say: "Told Lead." },
    ));
    await ck.postRoute("/user-message", { sessionId: notes.id, text: "Tell Lead the changelog link is in." });

    const [waited] = await ck.answered(from, 1, (c) => c.sessionId === lead.id && c.tool === "send_to_session", 20000);
    const out = resultOf(waited);
    assert.equal(out?.reply?.reason, "interrupted", waited.text);
    assert.equal(out.reply.by.kind, "session");
    assert.equal(out.reply.by.title, "Notes");
    assert.match(out.reply.note, /If it replies with send_to_session, that arrives as a new message/);
    assert(waited.endedAt - waited.startedAt < 15000, "the wait ended long before its timeout");
    await kit.until("Lead read Notes' message in the same turn", async () =>
      (await ck.sends()).some((s) => s.sessionId === lead.id && s.kind === "read_in_turn" && /changelog link is in/.test(s.content)), 15000);
    await card.locator('[data-collab-no-reply="interrupted"]').waitFor({ timeout: 10000 });
    assert.match(await card.innerText(), /Notes/);
    await shootCard(ctx, lead, "after-03-interrupted-by-chat");

    // Worker replies after the wait is gone: delivered to Lead as a message, read in its turn.
    await ck.release(worker.id);
    await kit.until("Worker's reply reached Lead as a message", async () =>
      (await ck.sends()).some((s) => s.sessionId === lead.id && s.kind === "read_in_turn" && /two nits/.test(s.content)), 20000);
    await ck.release(lead.id);
    await page.locator("text=All read.").first().waitFor({ timeout: 15000 });
    kit.record("W1: a message from another chat ends Lead's wait at once (reason interrupted, by Notes); Lead reads it in the same turn, and Worker's later reply still reaches Lead as a message", { waitedMs: waited.endedAt - waited.startedAt });
  });

  // ── W2: the user answers a card from Telegram (forwarded words): the wait ends, Lead reads the answer ──
  await kit.scenario("W2", async () => {
    const from = await leadWaitsOnWorker(ctx, {
      workerSteps: [{ say: "Reviewing." }, { hold: true }, { say: "Reviewed." }],
      leadAfter: [{ say: "Reading the user's answer." }, { hold: true }, { say: "Done." }],
    });
    await ck.postRoute("/user-words", { sessionId: lead.id, text: "OK, merge it." });
    const [waited] = await ck.answered(from, 1, (c) => c.sessionId === lead.id && c.tool === "send_to_session", 20000);
    const out = resultOf(waited);
    assert.equal(out?.reply?.reason, "interrupted", waited.text);
    assert.equal(out.reply.by.kind, "user");
    await kit.until("Lead read the forwarded answer in the same turn", async () =>
      (await ck.sends()).some((s) => s.sessionId === lead.id && s.kind === "read_in_turn" && /OK, merge it\./.test(s.content)), 15000);
    await ck.release(worker.id);
    await ck.release(lead.id);
    await page.locator("text=Done.").last().waitFor({ timeout: 15000 });
    kit.record("W2: the user's card answer forwarded from Telegram ends the wait (by the user) and Lead reads it in the same turn", { waitedMs: waited.endedAt - waited.startedAt });
  });

  // ── W3: Stop waiting on the card: the call returns, Lead goes on, Worker keeps running ──
  await kit.scenario("W3", async () => {
    const from = await leadWaitsOnWorker(ctx, {
      workerSteps: [{ say: "Reviewing." }, { hold: true }, { say: "Reviewed." }],
      leadAfter: [{ say: "Carrying on without the review." }],
    });
    const card = page.locator(SEND_CARD).last();
    await card.getByRole("button", { name: "Stop waiting" }).click();
    const [waited] = await ck.answered(from, 1, (c) => c.sessionId === lead.id && c.tool === "send_to_session", 15000);
    const out = resultOf(waited);
    assert.equal(out?.reply?.reason, "interrupted", waited.text);
    assert.equal(out.reply.by.stopped, true);
    await page.locator("text=Carrying on without the review.").first().waitFor({ timeout: 15000 });
    await card.locator('[data-collab-no-reply="interrupted"]').waitFor({ timeout: 10000 });
    assert.equal(await card.getByRole("button", { name: "Stop waiting" }).count(), 0, "the button goes once the wait is over");
    const live = await ck.live(worker.id);
    assert(live && live.phase !== "idle", `Worker still runs: ${JSON.stringify(live)}`);
    await shootCard(ctx, lead, "after-04-stopped-waiting");
    await ck.release(worker.id);
    kit.record("W3: Stop waiting ends the call (interrupted, stopped by the user), Lead carries on, Worker is left running");
  });

  // ── W4: a send without a wait: "Sent · awaiting reply", no spinner, an Open session button ──
  await kit.scenario("W4", async () => {
    await ck.plan(worker.id, ck.steps({ say: "On it." }, { hold: true }, { say: "Done." }));
    await ck.plan(lead.id, ck.steps(
      { call: "send_to_session", args: { session_id: worker.id, message: "Check the tokenizer too.", wait: false } },
      { say: "Asked Worker about the tokenizer." },
    ));
    await ck.show(page, [lead]);
    await ck.send(page, "Hand the tokenizer to Worker.");
    await page.locator("text=Asked Worker about the tokenizer.").first().waitFor({ timeout: 20000 });
    const card = page.locator(SEND_CARD).last();
    await card.locator("[data-collab-sent]").waitFor({ timeout: 10000 });
    assert.match(await card.innerText(), /awaiting reply/i);
    assert.equal(await card.locator(".animate-spin").count(), 0, "no spinner on a send nobody waits on");
    await card.getByRole("button", { name: "Open session" }).waitFor({ timeout: 5000 });
    await ck.release(worker.id);
    kit.record("W4: a send without wait shows Sent · awaiting reply with no spinner, and Open session");
  });
}
