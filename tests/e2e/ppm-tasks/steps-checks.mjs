// Steps of tests/e2e/ppm-tasks-e2e.mjs on work PPM checks or does by itself: a handed-off child
// that stalls on a waiting loop, one that finishes without reporting, the card when the project has
// no manager, and a "while you were away" card from an unattended Assistant turn with a real Undo.
// The checker runs on the fixture's clock (`k.check(advanceMs)`), never on a timer of its own.
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";

const MIN = 60_000;
const WAITING = (n) => `memory ${n}% used, ${3 + n % 4} jobs queued … waiting for the build slot`;

/** A chat of `project`, handed `task` by the user; `ops` is the chat's first turn. */
async function handOff(k, project, task, title, ops, text) {
  const chat = (await k.fx.post(`/api/project/${project}/chat/sessions`, { providerId: "claude", title })).data.id;
  const t = await k.task(task.id);
  const r = await k.patch(t.id, { revision: t.revision, workingSessionId: chat });
  assert.equal(r.ok, true, JSON.stringify(r.body));
  await k.script(`${title}-turn`, ops, { match: text, sessionId: chat });
  await k.say(project, chat, text);
  await until(`${title}: its turn started`, async () => (await k.fx.turnsOf(`${title}-turn`))[0]);
  // Named the way a person names a chat once it has started (`create_session` and Start chat
  // record the name themselves).
  await k.fx.api(`/api/project/${project}/chat/sessions/${chat}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}

const wakesOf = async (k, managerId, since = 0) => (await k.messages(managerId)).slice(since)
  .filter((m) => /handed-off work in .* needs you/.test(m.text));

/** Scenarios 14, 15 (no manager) (scene 6): a stalled child wakes the manager; gamma gets a card. */
async function stalledChild(k, s) {
  const page = k.page;
  await page.goto(`${k.web}/project/alpha`);
  const child = await handOff(k, "alpha", s.t.release, "Release 2.15 worker", [{ sleep: 1_800_000 }], "Prepare release 2.15 and report back");
  s.releaseChat = child;
  await k.childLines(child, [WAITING(86)]);
  await k.selectTask(s.t.release.title);
  await k.scene("s6", "PPM checks handed-off work", "Every 30 minutes PPM reads the child chat (it never messages it). A loop printing the same “waiting” line is not progress: the manager is woken.");
  const block = k.detail().locator("[data-working-session]").first();
  await block.getByText("Release 2.15 worker").first().waitFor({ timeout: 15000 });
  await k.beat(1500);
  const before = (await k.messages(s.managers.alpha)).length;
  const childBefore = (await k.messages(child)).length;
  await k.check(5 * MIN);
  await k.childLines(child, [WAITING(87)]);
  await k.check(26 * MIN);
  const wake = await until("the manager woken about the stalled child", async () => (await wakesOf(k, s.managers.alpha, before))[0]);
  assert.match(wake.text, /Prepare release 2\.15 for staging/);
  assert.match(wake.text, /stalled|no new output/i);
  assert.ok(["watch", "ppm_ui"].includes(wake.origin), `woken by PPM itself (${wake.origin})`);
  await until("the chip says stalled", async () => (await block.getAttribute("data-working-session")) === "stalled", 15000);
  assert.match(await block.innerText(), /stalled|Stalled/i);
  await k.beat(1500);
  await k.shot("14-stalled-child-1440");
  // gamma has no manager: its idle child becomes one Assistant card instead.
  const card = await until("gamma's handed-off work card", async () => (await k.cards()).find((c) => c.kind === "needs_decision" && c.projectName === "gamma" && /handed-off task/.test(c.title)), 20000);
  assert.ok(card.payload.tasks?.some((x) => x.taskId === s.t.gammaDecision.id), "the card names gamma's task and its chat");
  await k.idle(s.managers.alpha);
  // Show the wake in the manager chat (the task's own "Open chat" is the child's).
  await page.goto(`${k.web}/project/alpha/chat/claude/${s.managers.alpha}`);
  await page.locator("*:visible", { hasText: /^PPM Tasks — handed-off work in alpha needs you/ }).last().waitFor({ timeout: 20000 });
  await k.beat(2000);
  await k.endScene();
  // At three intervals one more wake, then none; the child was never written to.
  for (let n = 88; n < 92; n++) await k.childLines(child, [WAITING(n)]);
  await k.check(60 * MIN);
  await until("a second wake", async () => (await wakesOf(k, s.managers.alpha, before)).length === 2);
  await k.idle(s.managers.alpha);
  await k.check(200 * MIN);
  await k.check(60 * MIN);
  assert.equal((await wakesOf(k, s.managers.alpha, before)).length, 2, "no third wake");
  assert.equal((await k.messages(child)).length, childBefore, "the check never messaged the child");
  // The result ends the checks.
  const t = await k.task(s.t.release.id);
  assert.equal((await k.patch(t.id, { revision: t.revision, result: { text: "Released to staging by hand." } })).ok, true);
  await k.check(MIN);
  k.record("14", "stalled child (repeated waiting lines) → manager woken once, again at 3 intervals, then silence; child never messaged; gamma (no manager) → one Assistant card");
}

/** Scenario 15: a child that finished without reporting; the manager records the result; checks stop. */
async function finishedWithoutReport(k, s) {
  const child = await handOff(k, "alpha", s.t.review, "Review worker", [{ text: "Reviewed: two comments left on #412." }], "Review pull request 412");
  await k.idle(child);
  const before = (await k.messages(s.managers.alpha)).length;
  await k.check(MIN);
  const wake = await until("the manager woken about the silent child", async () => (await wakesOf(k, s.managers.alpha, before))[0]);
  assert.match(wake.text, /Review pull request #412/);
  assert.match(wake.text, /finished|idle|without/i);
  await k.idle(s.managers.alpha);
  const t = await k.task(s.t.review.id);
  const [call] = await k.chatTurn("alpha", s.managers.alpha, "record-result", [{ session: "ppm_task_update", args: { task: t.ref, revision: t.revision, reason: "The review chat finished.", result: "Two comments left on #412; waiting on the author." } }], "Record the review result");
  assert.equal(call.isError, false, call.text);
  await k.idle(s.managers.alpha);
  await k.selectTask(s.t.review.title);
  await k.detail().locator('[data-task-card="result"]').getByText("Two comments left on #412").waitFor({ timeout: 15000 });
  const wakes = (await wakesOf(k, s.managers.alpha, before)).length;
  await k.check(40 * MIN);
  await k.check(100 * MIN);
  assert.equal((await wakesOf(k, s.managers.alpha, before)).length, wakes, "no check after the result");
  k.record("15", "finished without a report → one wake; manager records the result; it shows on the task and the checks stop");
}

/** Scenario 12 (scene 7): an unattended Assistant turn writes tasks → one card with a real Undo. */
async function awayCard(k, s) {
  const page = k.page;
  const logs = await k.task(s.t.logs.id);
  const sprite = await k.task(s.t.sprite.id);
  await k.script("away-turn", [
    { session: "ppm_task_update", args: { task: logs.ref, revision: logs.revision, reason: "Staging disk is at 91%.", urgency: "week" } },
    { session: "ppm_task_update", args: { task: sprite.ref, revision: sprite.revision, reason: "The art review is on Friday.", importance: "must" } },
  ], { match: "A watch fired: staging disk", sessionId: s.main });
  await k.fx.post("/__assistant-test/tasks/watch-turn", { sessionId: s.main, projectName: "__assistant__", text: "A watch fired: staging disk is at 91%. Tidy the task lists." });
  await until("both changes written", async () => {
    const calls = await k.fx.recordsOf("away-turn");
    return calls.length === 2 && calls.every((c) => c.done) ? calls : null;
  });
  for (const c of await k.fx.recordsOf("away-turn")) assert.equal(c.isError, false, c.text);
  const card = await k.cardOf("done", "while you were away", 30000);
  assert.equal(card.provenance, "Written by the PPM Assistant", "the card says the Assistant wrote it");
  assert.equal(card.payload.taskChanges.length, 2);
  const hist = await k.history(s.t.logs.id);
  assert((hist.history ?? hist).some((h) => h.unattended), "the history row is marked unattended");

  await page.goto(`${k.web}/project/alpha/assistant`);
  await k.scene("s7", "Changes made while you were away", "A turn nobody watched may write tasks: every change is listed on one card, each with a real Undo.");
  const body = page.locator("[data-assistant-body]:visible").first();
  const stream = body.locator('[data-assistant-card="done"]', { hasText: "while you were away" }).last();
  await stream.waitFor({ timeout: 30000 });
  await stream.locator("[data-card-provenance]").getByText("Written by the PPM Assistant").waitFor();
  await k.beat(1500);
  await k.shot("12-away-card-1440");
  const change = stream.locator(`[data-card-task-change="${card.payload.taskChanges[0].historyId}"]`);
  await change.getByRole("button", { name: /Undo/ }).click();
  await change.locator("[data-undone], :text('Undone')").first().waitFor({ timeout: 15000 }).catch(async () => change.getByText("Undone").waitFor({ timeout: 5000 }));
  await until("the change undone", async () => (await k.task(s.t.logs.id)).urgency === "later");
  await k.beat(2000);
  await k.endScene();
  k.record("12", "unattended Assistant turn writes 2 tasks → history marked unattended → one card “Written by the PPM Assistant” → Undo restores");
}

export const CHECK_STEPS = [
  { id: "stalled-child", run: stalledChild },
  { id: "finished-no-report", run: finishedWithoutReport },
  { id: "away-card", run: awayCard },
];
