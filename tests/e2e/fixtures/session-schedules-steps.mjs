// Session-schedules e2e, the delivery flows on a desktop: the AI schedules a prompt into its own
// chat and the open chat shows the run (a); a busy chat makes a due schedule wait, and two dues
// fold into one turn (b); a fire missed while PPM was off is delivered once after a restart (c);
// the footer chip lists the chat's schedules and pauses and resumes them (d).
import assert from "node:assert/strict";
import { COMPOSER } from "./session-turn-refs-helpers.mjs";

export const PROJECT = "alpha";
export const PROMPT_1 = "Check last night's build and list any failing tests.";
export const PROMPT_2 = "Nightly worker: summarise what changed today.";
export const PROMPT_3 = "Restart check: confirm this arrived exactly once.";

/** Fixture routes and the reads every scenario makes. */
export function schedKit(kit, web) {
  const route = (path) => kit.api(`/__sched-test${path}`);
  const postRoute = (path, body) => kit.post(`/__sched-test${path}`, body);
  const sends = async () => (await route("/sends")).sends;
  const sendsOf = async (sessionId, content) => (await sends()).filter((s) => s.sessionId === sessionId && s.content === content);
  return {
    route, postRoute, sends, sendsOf,
    plan: (key, ...plans) => postRoute("/plan", { key, plans }),
    calls: async () => (await route("/calls")).calls,
    release: (sessionId) => postRoute("/release", { sessionId }),
    due: (id, minutesAgo = 0) => postRoute("/due", { id, minutesAgo }),
    stored: async (id) => (await route(`/schedule?id=${id}`)).schedule,
    live: async (id) => (await route(`/live?sessionId=${encodeURIComponent(id)}`)).live,
    runs: async (id) => (await kit.api(`/api/schedules/${id}/runs`)).data,
    async newSession(title) {
      const created = await kit.post(`/api/project/${PROJECT}/chat/sessions`, { providerId: "claude", title });
      await postRoute("/title", { sessionId: created.data.id, title });
      return { id: created.data.id, title };
    },
    idle: (id, timeout = 20000) => kit.until(`${id} idle`, async () => (await route(`/live?sessionId=${encodeURIComponent(id)}`)).live?.phase === "idle", timeout, 150),
    async open(page, session) {
      await page.goto(`${web}/project/${PROJECT}/chat/claude/${session.id}`);
      await page.locator(`${COMPOSER}:visible`).first().waitFor({ timeout: 30000 });
    },
    async send(page, text) {
      const box = page.locator(`${COMPOSER}:visible`).first();
      await box.fill(text);
      await box.press("Enter");
    },
    runLine: (page, id) => page.locator(`[data-schedule-run="${id}"]:visible`).first(),
  };
}

/** Waits until a schedule has `n` finished runs; answers them. */
async function finishedRuns(ctx, id, n, timeout = 30000) {
  return ctx.kit.until(`${n} finished run(s) of schedule ${id}`, async () => {
    const runs = await ctx.sk.runs(id);
    return runs.length === n && runs.every((r) => r.status !== "running") ? runs : null;
  }, timeout, 250);
}

/** Counts stay where they are for `ms`: nothing ran twice. */
async function stillOnce(ctx, id, sessionId, prompt, ms) {
  await new Promise((r) => setTimeout(r, ms));
  assert.equal((await ctx.sk.runs(id)).length, 1, `schedule ${id} ran exactly once`);
  assert.equal((await ctx.sk.sendsOf(sessionId, prompt)).length, 1, `the prompt of schedule ${id} reached its chat exactly once`);
}

export async function runAiCreatesAndRuns(ctx) {
  const { kit, sk, page, ids: { A } } = ctx;
  await kit.scenario("a: the AI schedules a prompt into its own chat and the run shows in the open chat", async () => {
    await sk.plan(A.id, { steps: [
      { say: "Setting that up." },
      { call: "session_schedule_create", args: { cron: "0 9 * * 1-5", timezone: "Asia/Saigon", name: "Morning build check", prompt: PROMPT_1 } },
      { say: "Scheduled: weekdays at 09:00, Saigon time." },
    ] });
    await sk.open(page, A);
    await sk.send(page, "Every weekday at 9 in the morning, remind this chat to check the build.");
    const call = await kit.until("session_schedule_create answered", async () =>
      (await sk.calls()).find((c) => c.tool === "session_schedule_create" && c.text !== undefined), 30000, 150);
    assert.equal(call.isError, false, call.text);
    const created = JSON.parse(call.text);
    assert.equal(created.created, true);
    assert.equal(created.timeZone, "Asia/Saigon");
    assert.equal(created.recurring, true);
    ctx.ids.S1 = created.id;
    const listed = (await kit.api(`/api/schedules?session=${A.id}`)).data;
    assert.equal(listed.length, 1, "one schedule for the chat");
    assert.equal(listed[0].kind, "session");
    assert.equal(listed[0].target_title, A.title);
    assert.equal(listed[0].cron_expr, "0 9 * * 1-5");
    await sk.idle(A.id);
    kit.record("a: session_schedule_create saved a weekday schedule for its own chat (REST ?session= lists it)", { id: created.id });

    await sk.due(ctx.ids.S1);
    const [run] = await finishedRuns(ctx, ctx.ids.S1, 1);
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(run.session_id, A.id);
    assert.equal((await sk.sendsOf(A.id, PROMPT_1)).length, 1, "the prompt reached the chat once");
    const row = await sk.stored(ctx.ids.S1);
    assert.equal(row.pending_since, null, "nothing left pending");
    assert(Date.parse(row.next_fire_at) > Date.now(), `next fire is ahead (${row.next_fire_at})`);

    const line = sk.runLine(page, ctx.ids.S1);
    await line.waitFor({ timeout: 20000 });
    const text = await line.innerText();
    assert.match(text, /Schedule\s+Morning build check\s+ran/);
    await sk.idle(A.id);
    await kit.shot(page, "desktop-chat-schedule-run-line");
    await line.locator("button").first().click();
    await line.getByText(PROMPT_1).waitFor({ timeout: 5000 });
    assert.match(await line.innerText(), /0 9 \* \* 1-5/);
    await kit.shot(page, "desktop-chat-schedule-run-line-expanded");
    kit.record("a: the due schedule ran one turn and the open chat shows the Schedule … ran line, which opens to the prompt");

    await page.reload();
    const again = sk.runLine(page, ctx.ids.S1);
    await again.waitFor({ timeout: 30000 });
    await again.locator("button").first().click();
    await again.getByText(PROMPT_1).waitFor({ timeout: 5000 });
    kit.record("a: after a reload the run line is read back from history and still opens to its prompt");
  });
}

export async function runChipPauseResume(ctx) {
  const { kit, sk, page } = ctx;
  await kit.scenario("d: the footer chip counts the chat's schedules; Pause then Resume", async () => {
    const chip = page.locator('[data-testid="session-schedules-chip"]:visible').first();
    await chip.waitFor({ timeout: 15000 });
    assert.match(await chip.innerText(), /1/);
    await chip.click();
    const item = page.locator(`[data-session-schedule="${ctx.ids.S1}"]:visible`).first();
    await item.waitFor({ timeout: 10000 });
    assert.match(await item.innerText(), /Morning build check/);
    await page.waitForTimeout(400); // the popover's enter animation
    await kit.shot(page, "desktop-schedules-chip-popover");
    const toggle = item.locator('[data-testid="session-schedule-toggle"]');
    assert.match(await toggle.innerText(), /Pause/);
    await toggle.click();
    await kit.until("paused in the database", async () => (await sk.stored(ctx.ids.S1)).enabled === 0, 10000);
    await kit.until("the button offers Resume", async () => /Resume/.test(await toggle.innerText()), 10000);
    await toggle.click();
    await kit.until("resumed in the database", async () => (await sk.stored(ctx.ids.S1)).enabled === 1, 10000);
    await kit.until("the button offers Pause again", async () => /Pause/.test(await toggle.innerText()), 10000);
    assert(Date.parse((await sk.stored(ctx.ids.S1)).next_fire_at) > Date.now(), "resumed with a fire ahead");
    await page.keyboard.press("Escape");
    kit.record("d: the chip shows 1, its popover lists the schedule, and Pause then Resume reach the server");
  });
}

export async function runBusyChatCoalesces(ctx) {
  const { kit, sk, page, ids: { B } } = ctx;
  await kit.scenario("b: a due schedule waits for a running turn and two dues run once", async () => {
    await sk.open(page, B);
    const before = (await sk.sends()).filter((s) => s.sessionId === B.id).length;
    await sk.send(page, "HOLD: run the long migration check and keep going.");
    await kit.until("B's held turn started", async () => (await sk.sends()).filter((s) => s.sessionId === B.id).length > before, 20000);
    await kit.until("B is running", async () => (await sk.live(B.id))?.phase !== "idle", 10000);

    const created = await kit.post("/api/schedules", {
      kind: "session", target_session_id: B.id, name: "Nightly summary", prompt: PROMPT_2, cron_expr: "0 3 1 1 *", timezone: "Asia/Saigon",
    });
    const id = ctx.ids.S2 = created.data.id;
    await sk.due(id, 5);
    const first = await kit.until("first fire pending", async () => (await sk.stored(id)).pending_since, 10000);
    await sk.due(id, 2);
    await kit.until("second fire seen by the timer", async () => Date.parse((await sk.stored(id)).next_fire_at) > Date.now(), 10000);
    assert.equal((await sk.stored(id)).pending_since, first, "the second fire folded into the pending one");
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await sk.runs(id)).length, 0, "nothing ran while the turn was running");
    assert.equal((await sk.sendsOf(B.id, PROMPT_2)).length, 0, "the prompt did not go into the running turn");
    assert.notEqual((await sk.live(B.id))?.phase, "idle", "the held turn is still running");
    kit.record("b: while B's turn runs, two dues leave one pending fire and nothing is sent");

    await sk.release(B.id);
    const [run] = await finishedRuns(ctx, id, 1);
    assert.equal(run.status, "done", JSON.stringify(run));
    await stillOnce(ctx, id, B.id, PROMPT_2, 4000);
    assert.equal((await sk.stored(id)).pending_since, null);
    const line = sk.runLine(page, id);
    await line.waitFor({ timeout: 20000 });
    assert.match(await line.innerText(), /sent late/);
    kit.record("b: once the turn ended the schedule ran exactly once, marked sent late");
  });
}

export async function runRestartCatchUp(ctx) {
  const { kit, sk, page, ids: { A } } = ctx;
  await kit.scenario("c: a fire missed while PPM was off runs exactly once after the restart", async () => {
    const created = await kit.post("/api/schedules", {
      kind: "session", target_session_id: A.id, name: "Restart check", prompt: PROMPT_3, cron_expr: "0 3 1 1 *", timezone: "Asia/Saigon",
    });
    const id = ctx.ids.S3 = created.data.id;
    const s1Runs = (await sk.runs(ctx.ids.S1)).length;
    await ctx.restart({ backdate: `${id}=${new Date(Date.now() - 10 * 60_000).toISOString()}` });
    const [run] = await finishedRuns(ctx, id, 1, 40000);
    assert.equal(run.status, "done", JSON.stringify(run));
    await stillOnce(ctx, id, A.id, PROMPT_3, 5000);
    assert.equal((await sk.runs(ctx.ids.S1)).length, s1Runs, "a schedule whose fire is still ahead did not run");
    const row = await sk.stored(id);
    assert.equal(row.pending_since, null);
    assert(Date.parse(row.next_fire_at) > Date.now(), "counted on from now");
    // The page last showed chat B: open the chat the schedule ran in, read back after the restart.
    await sk.open(page, A);
    const line = sk.runLine(page, id);
    await line.waitFor({ timeout: 30000 });
    assert.match(await line.innerText(), /Restart check[\s\S]*sent late/);
    kit.record("c: after the restart the missed fire ran once, the other schedules did not, and the chat shows it sent late");
  });
}
