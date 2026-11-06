// Session-collaboration e2e, part 2: the pair limit card and "Allow 20 more" (5), depth 4 and a
// sixth running child refused (6), Stop cancelling a wait while the child runs on, then "Stop all
// child sessions" (7), and Codex and Claude creating each other (8).
import assert from "node:assert/strict";
import { resultOf } from "./session-collab-helpers.mjs";

export async function runLimitSteps(ctx) {
  const { page, kit, ck, ids } = ctx;
  const { A } = ids;

  // ── 5: ping-pong to the 20-message pair limit; the card in the sender; Allow 20 more goes on ──
  await kit.scenario("5", async () => {
    const D = ids.D;
    const pings = Array.from({ length: 11 }, (_, i) => ({ call: "send_to_session", args: { session_id: D.id, message: `ping ${i + 1}`, wait: true } }));
    await ck.plan(A.id, ck.steps(...pings, { say: "Review ping-pong finished." }));
    await ck.plan(D.id, ...Array.from({ length: 11 }, (_, i) => ck.steps({ call: "send_to_session", args: { session_id: A.id, message: `pong ${i + 1}` } })));
    const from = (await ck.calls()).length;
    await ck.show(page, [A]);
    await ck.send(page, "Run the review ping-pong with Reviewer.");
    const card = page.locator('[data-collab-approval="pair_limit"]:visible');
    await card.waitFor({ timeout: 60000 });
    const done = (await ck.calls()).slice(from).filter((c) => c.sessionId === A.id && c.text !== undefined);
    assert.equal(done.length, 10, `ten pings answered before the card: ${done.length}`);
    assert.match(await card.innerText(), /20 of 20/);
    await kit.shot(page, "05-pair-limit-card");
    await card.getByRole("button", { name: "Allow 20 more" }).click();
    const mine = await ck.answered(from, 11, (c) => c.sessionId === A.id, 30000);
    for (const [i, c] of mine.entries()) {
      const r = resultOf(c);
      assert.equal(r?.reply?.text, `pong ${i + 1}`, `ping ${i + 1}: ${c.text}`);
    }
    await page.locator("text=Review ping-pong finished.").first().waitFor({ timeout: 15000 });
    kit.record("5: ten round trips reach the 20-message pair limit, the card appears in the sender, and Allow 20 more lets ping 11 through with its pong");
  });

  // ── 6: a create at depth 4 is refused; a sixth running AI-created session is refused ──
  await kit.scenario("6", async () => {
    const chain = [];
    for (const title of ["Root", "Level 1", "Level 2", "Level 3"]) chain.push(await ck.newSession("claude", title));
    const { depths } = await ck.postRoute("/spawn-chain", { ids: chain.map((s) => s.id) });
    assert.deepEqual(depths, [1, 2, 3]);
    const L3 = chain[3];
    await ck.plan(L3.id, ck.steps({ call: "create_session", args: { title: "Level 4", task: "Go one level deeper." } }, { say: "Could not go deeper." }));
    let from = (await ck.calls()).length;
    await ck.show(page, [L3]);
    await ck.send(page, "Hand this to a new session.");
    const [deep] = await ck.answered(from, 1, (c) => c.sessionId === L3.id);
    assert.equal(deep.isError, true, deep.text);
    assert.match(deep.text, /3 levels deep/);
    await page.locator('[data-session-collab-card="create_session"]:visible', { hasText: "3 levels deep" }).first().waitFor({ timeout: 15000 });
    await kit.shot(page, "06a-depth-4-refused");

    const creates = Array.from({ length: 6 }, (_, i) => ({ call: "create_session", args: { title: `Worker ${i + 1}`, task: `Process shard ${i + 1}. HOLD` } }));
    await ck.plan(A.id, ck.steps(...creates, { say: "Fan-out done." }));
    from = (await ck.calls()).length;
    await ck.show(page, [A]);
    await ck.send(page, "Fan out the shards to workers.");
    const six = await ck.answered(from, 6, (c) => c.sessionId === A.id, 60000);
    six.slice(0, 5).forEach((c, i) => assert.equal(c.isError, false, `worker ${i + 1}: ${c.text}`));
    assert.equal(six[5].isError, true, six[5].text);
    assert.match(six[5].text, /5 AI-created sessions of this project are already running/);
    await page.locator('[data-session-collab-card="create_session"]:visible', { hasText: "already running" }).first().waitFor({ timeout: 15000 });
    await kit.shot(page, "06b-sixth-child-refused");
    await ck.release();
    kit.record("6: create at depth 4 is refused (3 levels deep), and a sixth AI-created session while five run is refused");
  });

  // ── 7: Stop in A cancels its wait and B keeps running; Stop all child sessions stops B ──
  await kit.scenario("7", async () => {
    const { B } = ids;
    await ck.plan(A.id, ck.steps({ call: "send_to_session", args: { session_id: B.id, message: "Run the slow suite and report back. HOLD", wait: true } }, { say: "Got it." }));
    const from = (await ck.calls()).length;
    await ck.show(page, [A]);
    await ck.send(page, "Ask the tests session to run the slow suite.");
    await page.locator("[data-collab-waiting]:visible").first().waitFor({ timeout: 20000 });
    const chip = page.locator(`[data-linked-sessions-bar] [data-linked-session="${B.id}"]:visible`);
    await kit.until("B running", async () => (await chip.getAttribute("data-linked-status")) === "running", 15000);
    await page.getByRole("button", { name: "Stop response" }).first().click();
    const [wait] = await ck.answered(from, 1, (c) => c.sessionId === A.id, 20000);
    assert.deepEqual(resultOf(wait)?.reply, { replied: false, reason: "cancelled" }, wait.text);
    await page.waitForTimeout(1500);
    assert.equal((await ck.live(B.id))?.phase !== "idle", true, "B keeps running after A stopped");
    assert.equal(await chip.getAttribute("data-linked-status"), "running");
    kit.record("7: Stop in A cancels its wait (the tool answers reason cancelled) while B keeps running");
    await kit.shot(page, "07a-stop-cancels-wait");
    // The card is the user's only view of what the stop did to the wait.
    const card = page.locator('[data-session-collab-card="send_to_session"]:visible').last();
    const cardText = (await card.innerText()).replace(/\s+/g, " ");
    assert.equal(await card.locator('[data-collab-no-reply="cancelled"]').count(), 1, `A's card shows the wait as cancelled; it reads: "${cardText}"`);
    kit.record("7 (card): A's tool card says the wait was cancelled");
  });

  await kit.scenario("7b", async () => {
    const { B } = ids;
    const chip = page.locator(`[data-linked-sessions-bar] [data-linked-session="${B.id}"]:visible`);
    assert.equal((await ck.live(B.id))?.phase !== "idle", true, "B is still running");
    await page.getByRole("button", { name: "Stop all child sessions" }).first().click();
    await page.getByRole("button", { name: "Stop all", exact: true }).first().click();
    await kit.until("B stopped", async () => (await ck.live(B.id))?.phase === "idle", 15000);
    await kit.until("B's chip idle", async () => (await chip.getAttribute("data-linked-status")) !== "running", 15000);
    await kit.shot(page, "07b-stop-all-children");
    kit.record("7b: Stop all child sessions (after its confirmation) stops B");
  });

  // ── 8: a Codex parent creates a Claude child, and a Claude parent a Codex child ──
  await kit.scenario("8", async () => {
    const X = ids.X;
    await ck.plan(X.id, ck.steps({ call: "create_session", args: { title: "Claude helper", task: "Summarise the README.", provider: "claude" } }, { say: "Handed to Claude." }));
    let from = (await ck.calls()).length;
    await ck.show(page, [X]);
    await ck.send(page, "Get a Claude session to summarise the README.");
    const card = page.locator('[data-collab-approval="create"]:visible');
    await card.waitFor({ timeout: 20000 });
    assert.match(await card.innerText(), /Claude helper/);
    await card.getByRole("button", { name: "Allow once" }).click();
    const [byCodex] = await ck.answered(from, 1, (c) => c.tool === "create_session" && c.args.title === "Claude helper");
    assert.equal(resultOf(byCodex)?.providerId, "claude", byCodex.text);
    const xThread = await ck.canonical(X.id);
    const claudeChild = await ck.findListed("Claude helper");
    assert.equal(claudeChild.providerId, "claude");
    assert.equal(claudeChild.spawnedBy, xThread, "the Codex parent is named by its thread id");
    await page.locator("text=Handed to Claude.").first().waitFor({ timeout: 15000 });
    await kit.shot(page, "08a-codex-creates-claude");

    await ck.plan(A.id, ck.steps({ call: "create_session", args: { title: "Codex helper", task: "Check the lockfile.", provider: "codex" } }, { say: "Handed to Codex." }));
    from = (await ck.calls()).length;
    await ck.show(page, [A]);
    await ck.send(page, "Get a Codex session to check the lockfile.");
    const [byClaude] = await ck.answered(from, 1, (c) => c.sessionId === A.id);
    assert.equal(resultOf(byClaude)?.providerId, "codex", byClaude.text);
    const codexChild = await ck.findListed("Codex helper");
    assert.equal(codexChild.providerId, "codex");
    assert.equal(codexChild.spawnedBy, A.id);
    await ck.show(page, [{ id: codexChild.id, providerId: "codex", title: "Codex helper" }]);
    const bubble = page.locator(`[data-from-session="${A.id}"]:visible`).first();
    await bubble.waitFor({ timeout: 15000 });
    assert.match(await bubble.locator("button").first().innerText(), /Planner[\s\S]*Claude/);
    await kit.shot(page, "08b-claude-creates-codex");
    kit.record("8: a Codex parent creates a Claude child (spawnedBy = its thread id) and a Claude parent creates a Codex child, whose first message names Planner · Claude", { xThread, codexChild: codexChild.id });
  });
}
