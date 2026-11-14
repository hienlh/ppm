// Session-schedules e2e, Stop on a queued scheduled message (f): a person's turn starts between a
// schedule's quiet check and its send, so the scheduled message waits in the provider's queue
// behind it; the person presses Stop, which takes the provider down with that queue. The fire
// must not be counted as run by the end of the person's turn: it stays pending and goes out
// exactly once, in a turn of its own, once the chat is idle.
import assert from "node:assert/strict";
import { finishedRuns, stillOnce } from "./session-schedules-steps.mjs";

export const PROMPT_4 = "Queued check: confirm this arrived once, after the stopped turn.";
/** The person's turn the racing provider opens ahead of the scheduled message (racing provider). */
const PERSON_TURN = "HOLD: the person's own question, typed a moment before the schedule went in.";

export async function runStopDropsQueuedSchedule(ctx) {
  const { kit, sk, page, ids: { B } } = ctx;
  await kit.scenario("f: Stop takes down a scheduled message queued behind a person's turn; it runs once afterwards", async () => {
    await sk.open(page, B);
    await sk.idle(B.id);
    assert.equal((await sk.live(B.id))?.phase, "idle", "B is idle with its provider still running from scenario b");

    await sk.postRoute("/race", { sessionId: B.id });
    const created = await kit.post("/api/schedules", {
      kind: "session", target_session_id: B.id, name: "Queued check", prompt: PROMPT_4, cron_expr: "0 3 1 1 *", timezone: "Asia/Saigon",
    });
    const id = ctx.ids.S4 = created.data.id;
    await sk.due(id);
    await kit.until("the person's turn running ahead of the scheduled message", async () =>
      (await sk.sendsOf(B.id, PERSON_TURN)).length === 1 && (await sk.live(B.id))?.phase !== "idle", 15000, 150);
    await new Promise((r) => setTimeout(r, 1000));
    assert((await sk.stored(id)).pending_since, "the fire is still pending while its message waits in the queue");
    assert.equal((await sk.runs(id)).length, 0, "no run is counted for a message still queued");
    assert.equal((await sk.sendsOf(B.id, PROMPT_4)).length, 0, "the scheduled prompt did not join the person's turn");
    kit.record("f: the scheduled message waits queued behind the person's turn, its fire pending and no run counted");

    const stop = page.locator('button[aria-label="Stop response"]:visible').first();
    await stop.waitFor({ timeout: 10000 });
    await stop.click();
    await kit.until("the stopped turn is over", async () => (await sk.live(B.id))?.phase === "idle", 15000, 150);
    assert.equal((await sk.runs(id)).filter((r) => r.status === "running").length, 0, "the stopped turn was not recorded as the schedule's run");

    const [run] = await finishedRuns(ctx, id, 1, 30000);
    assert.equal(run.status, "done", JSON.stringify(run));
    await stillOnce(ctx, id, B.id, PROMPT_4, 4000);
    assert.equal((await sk.stored(id)).pending_since, null, "spent once its own turn ran");
    kit.record("f: after Stop the fire stayed pending and ran exactly once, in a turn of its own");
  });
}
