// Session-schedules e2e, Stop on a queued scheduled message (f): a person's turn starts between a
// schedule's quiet check and its send, so the scheduled message waits in the provider's queue
// behind it; the person presses Stop, which takes the provider down with that queue. The fire
// must not be counted as run by the end of the person's turn, and must not be sent again a few
// seconds later into the chat the person just stopped: it stays pending until the chat's next
// turn ends, then goes out exactly once, in a turn of its own.
import assert from "node:assert/strict";
import { finishedRuns, stillOnce } from "./session-schedules-steps.mjs";

export const PROMPT_4 = "Queued check: confirm this arrived once, after the stopped turn.";
/** The person's next message after Stop: its turn ending is what releases the held schedule. */
const NEXT_TURN = "Thanks, that can wait. Anything else?";
/** The person's turn the racing provider opens ahead of the scheduled message (racing provider). */
const PERSON_TURN = "HOLD: the person's own question, typed a moment before the schedule went in.";

export async function runStopDropsQueuedSchedule(ctx) {
  const { kit, sk, page, ids: { B } } = ctx;
  await kit.scenario("f: Stop takes down a scheduled message queued behind a person's turn; it waits for the next turn, then runs once", async () => {
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

    // Well past the 3 s look that finds the queued message gone: the Stop holds it, nothing is resent.
    await new Promise((r) => setTimeout(r, 7000));
    assert.equal((await sk.sendsOf(B.id, PROMPT_4)).length, 0, "not sent again after the person stopped the chat");
    assert.equal((await sk.runs(id)).length, 0, "no run while the Stop holds it");
    assert((await sk.stored(id)).pending_since, "the fire is still pending after Stop");
    kit.record("f: 7 s after Stop the scheduled message was not sent again; its fire is still pending");

    // The person's next turn ends: the hold is released and the schedule goes in a turn of its own.
    await sk.send(page, NEXT_TURN);
    await kit.until("the person's next turn reached the chat", async () => (await sk.sendsOf(B.id, NEXT_TURN)).length === 1, 15000, 150);
    const [run] = await finishedRuns(ctx, id, 1, 30000);
    assert.equal(run.status, "done", JSON.stringify(run));
    await stillOnce(ctx, id, B.id, PROMPT_4, 4000);
    assert.equal((await sk.stored(id)).pending_since, null, "spent once its own turn ran");
    const order = (await sk.sends()).filter((s) => s.sessionId === B.id).map((s) => s.content);
    assert(order.indexOf(NEXT_TURN) < order.lastIndexOf(PROMPT_4), "the schedule went after the person's next turn, not before");
    kit.record("f: after the person's next turn ended the fire ran exactly once, in a turn of its own");
  });
}
