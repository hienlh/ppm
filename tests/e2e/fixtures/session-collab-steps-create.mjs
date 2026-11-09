// Session-collaboration e2e, part 1: a session creates another behind the card (1), the child's
// first message as a from-session bubble with a turn link while it streams (2), the child's reply
// ending the creator's wait with no extra turn (3), and a message inserted into a running turn
// whose bubble header leads back to the sending turn (4).
import assert from "node:assert/strict";
import { resultOf } from "./session-collab-helpers.mjs";
import { closeLinkedSessions, linkedSessionRow, linkedSessionStatus, openLinkedSessions } from "./linked-sessions-panel-helpers.mjs";

export async function runCreateSteps(ctx) {
  const { page, kit, ck, ids } = ctx;
  const { A } = ids;

  // ── 1: A asks to create B; the card; Allow for this session; the list badge and the Sessions tab ──
  await kit.scenario("1", async () => {
    await ck.plan(A.id, ck.steps(
      { call: "create_session", args: { title: "Write the tests", task: "Write the tests for the parser, then reply to me with the result.", wait: true } },
      { say: "The tests are written." },
    ));
    await ck.plan("title:Write the tests", ck.steps(
      { say: "Working on the parser tests." },
      { hold: true },
      { call: "send_to_session", args: { session_id: A.id, message: "Tests written: 12 passing." } },
      { say: "Replied to Planner." },
    ));
    ctx.fromS1 = (await ck.calls()).length;
    await ck.show(page, [A]);
    await ck.send(page, "Split the work: have another session write the tests.");
    const card = page.locator('[data-collab-approval="create"]:visible');
    await card.waitFor({ timeout: 20000 });
    assert.match(await card.innerText(), /Write the tests/);
    await kit.shot(page, "01a-create-card");
    await card.getByRole("button", { name: "Allow for this session" }).click();
    await card.waitFor({ state: "detached", timeout: 15000 });

    const B = await ck.findListed("Write the tests");
    assert.equal(B.spawnedBy, A.id, "the list names A as B's creator");
    assert.equal(B.parentTitle, "Planner");
    ids.B = { id: B.id, providerId: "claude", title: "Write the tests" };

    // The child is listed in the activity chip's Sessions tab, by title, with no "session" badge.
    await kit.until("B in the Sessions tab", async () => (await (await linkedSessionRow(page, B.id)).count()) > 0, 15000);
    const rowText = await (await linkedSessionRow(page, B.id)).innerText();
    assert.match(rowText, /Write the tests/);
    assert.doesNotMatch(rowText, /\bSESSION\b/);
    await closeLinkedSessions(page);
    const badge = page.locator(`[data-spawned-badge="${A.id}"]:visible`).first();
    await badge.waitFor({ timeout: 15000 });
    await badge.hover();
    const tooltip = page.getByRole("tooltip").first();
    await tooltip.waitFor({ timeout: 5000 });
    ctx.liveTooltip = (await tooltip.innerText()).trim();
    await kit.shot(page, "01b-badge-and-session-chip");
    kit.record("1: the create card in A, Allow for this session creates B titled as asked; B is listed with the badge (tooltip on hover) and in A's activity chip's Sessions tab", { row: rowText.replace(/\s+/g, " "), tooltip: ctx.liveTooltip });
  });

  // The badge's tooltip names the creator: once the list is loaded from the server, and live.
  await kit.scenario("1 (badge names the creator)", async () => {
    await page.reload();
    await page.locator('textarea:is([placeholder="Ask anything..."], [placeholder^="Follow-up"]):visible').first().waitFor({ timeout: 30000 });
    const badge = page.locator(`[data-spawned-badge="${A.id}"]:visible`).first();
    await badge.waitFor({ timeout: 15000 });
    await badge.hover();
    await page.getByRole("tooltip").filter({ hasText: "Created by Planner" }).first().waitFor({ timeout: 5000 });
    kit.record("1: after a reload the badge says Created by Planner");
    assert.equal(ctx.liveTooltip, "Created by Planner", "the badge of a session created while the list was open names its creator");
  });

  // ── 2: B's first message is a from-session bubble with a turn link to A's turn, while B streams ──
  await kit.scenario("2", async () => {
    const { B } = ids;
    assert(B, "B exists");
    await ck.show(page, [B]);
    const bubble = page.locator(`[data-from-session="${A.id}"]:visible`).first();
    await bubble.waitFor({ timeout: 20000 });
    const header = await bubble.locator("button").first().innerText();
    assert.match(header, /From:\s*Planner/);
    assert.match(header, /Claude/);
    const turnChip = bubble.locator("[data-turn-chip]");
    await turnChip.first().waitFor({ timeout: 10000 });
    assert.match(await turnChip.first().innerText(), /Turn 1\b/);
    await page.locator("text=Working on the parser tests.").first().waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Stop response" }).first().waitFor({ timeout: 5000 });
    await kit.shot(page, "02-from-session-bubble-streaming");
    kit.record("2: B opens with a from-session bubble (From: Planner · Claude) carrying a Turn 1 chip to A, while B is still streaming", { header: header.replace(/\s+/g, " ") });
  });

  // ── 3: B replies with send_to_session; A was waiting, so the card shows it and A gets no turn ──
  await kit.scenario("3", async () => {
    const { B } = ids;
    await ck.release(B.id);
    const [create] = await ck.answered(ctx.fromS1, 1, (c) => c.sessionId === A.id && c.tool === "create_session", 30000);
    const created = resultOf(create);
    assert(created, `create answered JSON: ${create.text}`);
    assert.equal(created.reply?.replied, true, create.text);
    assert.equal(created.reply.text, "Tests written: 12 passing.");
    const [reply] = await ck.answered(ctx.fromS1, 1, (c) => c.sessionId === B.id && c.tool === "send_to_session");
    assert.equal(resultOf(reply)?.delivered, "inserted", reply.text);
    await ck.show(page, [A]);
    const card = page.locator('[data-session-collab-card="create_session"]:visible').first();
    await card.locator("[data-collab-reply]", { hasText: "Tests written: 12 passing." }).waitFor({ timeout: 15000 });
    assert.match(await card.innerText(), /replied/);
    await page.locator("text=The tests are written.").first().waitFor({ timeout: 15000 });
    const aTurns = (await ck.sends()).filter((s) => s.sessionId === A.id);
    assert.equal(aTurns.length, 1, `A ran only the user's turn: ${JSON.stringify(aTurns)}`);
    assert.equal(await page.locator("[data-from-session]").count(), 0, "no from-session message landed in A");
    await kit.shot(page, "03-waited-reply-on-card");
    kit.record("3: B's send_to_session ends A's wait (delivered: inserted); A's card shows the reply and A ran no extra turn");
  });

  // ── 4: A messages C mid-turn without waiting; C reads it in the same turn; its header opens A's turn ──
  await kit.scenario("4", async () => {
    const C = ids.C;
    await ck.show(page, [C]);
    await ck.send(page, "Draft the release notes HOLD");
    await page.locator("text=Working on it, step by step.").first().waitFor({ timeout: 15000 });
    const from = (await ck.calls()).length;
    await ck.plan(A.id, ck.steps(
      { call: "send_to_session", args: { session_id: C.id, message: "Add the changelog link to the notes.", wait: false } },
      { say: "Asked Release notes." },
    ));
    await ck.show(page, [A]);
    await ck.send(page, "Tell the release notes session to add the changelog link.");
    const [sent] = await ck.answered(from, 1, (c) => c.sessionId === A.id);
    assert.equal(resultOf(sent)?.delivered, "inserted", sent.text);
    const cSends = await kit.until("C read it inside its turn", async () => {
      const mine = (await ck.sends()).filter((s) => s.sessionId === C.id);
      return mine.some((s) => s.kind === "read_in_turn") ? mine : null;
    }, 15000);
    assert.equal(cSends.filter((s) => s.kind === "turn").length, 1, "C started no second turn for it");
    await page.locator("text=Asked Release notes.").first().waitFor({ timeout: 15000 });
    const aTurn = (await kit.api(`/api/project/alpha/chat/sessions/${A.id}/turns?providerId=claude`)).data.turns.at(-1);
    assert.match(aTurn.prompt, /release notes session/);

    await ck.show(page, [C]);
    const bubble = page.locator(`[data-from-session="${A.id}"]:visible`).first();
    await bubble.waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Stop response" }).first().waitFor({ timeout: 5000 });
    await kit.shot(page, "04a-inserted-into-running-turn");
    await bubble.locator("button").first().click();
    const at = await kit.until("A's sending turn on screen", async () => kit.offsetOf(page, aTurn.turnId), 20000, 100);
    await kit.shot(page, "04b-header-opens-sending-turn");
    await ck.release(C.id);
    kit.record("4: a send without wait to running C is inserted into C's turn (no new turn); the bubble header opens A at the sending turn", { sendingTurn: aTurn.turnId, offset: at.offset, inWindow: at.inWindow });
  });
}
