// Scenarios e–g of the restart-news e2e: the Settings switch off, and quiet hours on the moved
// clock — urgent (a chat was cut off) goes at once, nothing cut off waits, and two restarts while
// waiting become one news.
import assert from "node:assert/strict";
import { HOUR, NO_REPLY, assertCutOffNews, hhmm, until } from "./restart-kit.mjs";
import { cutAndStop, sendScript } from "./steps-reasons.mjs";

const quietScript = (s, label) => ({ label, match: "Restart news:", sessionId: s.main, ops: [], reply: NO_REPLY });

/** e. Settings → PPM Assistant → restart news off: no wake turn, the run still recorded. */
export async function scenarioOff(k, s) {
  await k.patchSettings({ restart_news: false });
  assert.equal((await k.settings()).restart_news, false);
  await cutAndStop(k, s, "crash", "rn-e-cut");
  await k.start({}, [quietScript(s, "rn-e-unexpected")]);
  await k.noNewsTurn(s.main, "switched off");
  const state = await k.state();
  assert.equal(state.pending, null, "e: no news is kept for later either");
  assert.equal(state.restart.kind, "crash", "e: the run log still reads the crash");
  assert.equal(state.runs.length, k.run, "e: the run log still holds every run");
  assert.match(k.logOf(), /restart news is switched off/, "e: the server says why nothing was sent");
  await k.patchSettings({ restart_news: true });
  k.record("e", "switched off: a crash with a cut-off chat starts no wake turn and keeps no news; the run log is still written");
}

/** f. Quiet hours with a chat cut off: urgent, so the news and the manager message go at once. */
export async function scenarioQuietUrgent(k, s) {
  const now = await k.now();
  // Six hours of quiet starting a minute from now, on the clock every run below continues.
  await k.patchSettings({ timezone: "UTC", quiet_hours: { enabled: true, start: hhmm(now + 60_000), end: hhmm(now + 6 * HOUR) } });
  await k.advance(2 * 60_000);
  s.quietEnds = now + 6 * HOUR;
  await cutAndStop(k, s, "crash", "rn-f-cut");
  const label = "rn-f-send";
  await k.start({}, [sendScript(s, label)]);
  assert.ok((await k.now()) < s.quietEnds, "f: the restarted run is inside quiet hours");
  const turn = await k.oneNewsTurn(s.main, "quiet hours, chat cut off");
  await assertCutOffNews(k, s, { turn, label, expect: ["the PPM server crashed"] });
  await until("f: the delivered news is cleared", async () => (await k.state()).pending === null);
  k.record("f", "quiet hours with a cut-off chat: the news is urgent and goes at once, and the Assistant's message to the manager passes quiet hours");
}

/** g. Quiet hours, nothing cut off, two restarts: held, merged into one news, sent once quiet ends. */
export async function scenarioQuietMerge(k, s) {
  await k.settle([s.main, s.manager]);
  await k.advance(HOUR + 60_000);
  await k.stop("crash");
  await k.start();
  await k.noNewsTurn(s.main, "quiet hours, nothing cut off (first restart)");
  let state = await k.state();
  assert.equal(state.pending?.restarts.length, 1, "g: the first restart's news is held");
  assert.equal(state.pending.chats.length, 0, "g: no chat was cut off");

  await k.advance(HOUR + 60_000);
  await k.stop("crash");
  await k.start({}, [{ label: "rn-g-merged", match: "PPM restarted 2 times", sessionId: s.main, ops: [], reply: NO_REPLY }]);
  assert.ok((await k.now()) < s.quietEnds, "g: both restarts are inside quiet hours");
  await k.noNewsTurn(s.main, "quiet hours, nothing cut off (second restart)");
  state = await k.state();
  assert.equal(state.pending?.restarts.length, 2, "g: the second restart merged into the held news");

  await k.advance(s.quietEnds - (await k.now()) + 30 * 60_000);
  const turn = await k.oneNewsTurn(s.main, "quiet hours over");
  assert.equal(turn.label, "rn-g-merged", "g: one turn carries both restarts");
  const ctx = turn.sharedContext;
  assert.ok(ctx.includes("PPM restarted 2 times since you were last told:"), `g: both restarts in one news\n${ctx}`);
  assert.ok(ctx.includes("Chats cut off mid-turn: none."), "g: nothing cut off");
  assert.equal(ctx.split("the PPM server crashed").length - 1, 2, "g: one line per restart");
  await until("g: the delivered news is cleared", async () => (await k.state()).pending === null);
  k.record("g", "quiet hours with nothing cut off: held across two restarts, merged into one news, one wake turn once quiet hours end");
}
