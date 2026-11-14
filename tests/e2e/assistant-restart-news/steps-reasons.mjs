// Scenarios 0 and a–d of the restart-news e2e: the first start, then one restart per start reason,
// each cutting the manager's child chat off mid-turn and checking the one wake turn that follows.
import assert from "node:assert/strict";
import { HOUR, assertCutOffNews, until } from "./restart-kit.mjs";

/** A match script for the main session's restart-news turn: one card-free message to the manager. */
export const sendScript = (s, label) => ({
  label, match: "Restart news:", sessionId: s.main,
  ops: [{ session: "send_to_session", args: { session_id: s.manager, message: `PPM restarted (${label}). Please check ${s.child} and have it resume its task.` } }],
  reply: "Asked alpha's manager chat to resume the chat the restart cut off.",
});

/** Leaves the child mid-turn, moves the clock past the hourly caps, and ends the run. */
export async function cutAndStop(k, s, how, label, stopOpts = {}) {
  await k.settle([s.main, s.manager]);
  await k.cutOff("alpha", s.child, label, `${s.cutText} (${label})`);
  await k.advance(HOUR + 60_000);
  await k.stop(how, stopOpts);
}

/** One restart with the child cut off: the news, the send to the manager, the news cleared. */
async function restartWithCutOff(k, s, { id, how, env, expect, kind, unexpected = [], stopOpts }) {
  await cutAndStop(k, s, how, `rn-${id}-cut`, stopOpts);
  const label = `rn-${id}-send`;
  await k.start(env, [sendScript(s, label)]);
  const turn = await k.oneNewsTurn(s.main, `scenario ${id}`);
  await assertCutOffNews(k, s, { turn, label, expect });
  for (const text of unexpected) assert.ok(!turn.sharedContext.includes(text), `${id}: the news does not say ${JSON.stringify(text)}\n${turn.sharedContext}`);
  const state = await until(`${id}: the delivered news is cleared`, async () => {
    const st = await k.state();
    return st.pending === null ? st : null;
  });
  assert.equal(state.restart.kind, kind, `${id}: this run is recorded as ${kind}`);
  assert.equal(state.runs.length, k.run, `${id}: every run is in the run log`);
  return turn.sharedContext;
}

/** 0. A fresh install: the project, the main Assistant session, the manager and the chat it opened. */
export async function scenarioFirstStart(k, s) {
  const { fx } = k;
  await k.start();
  await fx.post("/api/projects", { name: "alpha", path: s.alpha });
  await k.patchSettings({ timezone: "UTC", digest: { enabled: false, time: "08:00" }, quiet_hours: { enabled: false, start: "22:00", end: "07:00" } });
  assert.equal((await k.settings()).restart_news, true, "restart news is on by default");

  s.main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  assert.equal((await fx.api("/api/assistant/main-session")).data.main?.sessionId, s.main, "the first Claude Assistant session is the main one");

  s.manager = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: "Alpha lead" })).data.id;
  await k.script("seed-manager", [], { match: "Keep the alpha release plan", sessionId: s.manager });
  await k.say("alpha", s.manager, "Keep the alpha release plan");
  await until("the manager's first turn ran", () => fx.turnOf("seed-manager"));
  await k.idle(s.manager);
  await fx.api("/api/assistant/managers/alpha", { method: "PUT", body: JSON.stringify({ sessionId: s.manager }) });
  await until("alpha has its manager", async () => (await fx.api("/api/assistant/managers")).data.managers.some((m) => m.sessionId === s.manager));

  s.child = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: s.childTitle })).data.id;
  // A chat is renamed once its transcript exists, i.e. after its first turn.
  await k.script("seed-child", [], { match: "Start the parser rewrite", sessionId: s.child });
  await k.say("alpha", s.child, "Start the parser rewrite");
  await until("the child's first turn ran", () => fx.turnOf("seed-child"));
  await k.idle(s.child);
  await fx.api(`/api/project/alpha/chat/sessions/${s.child}`, { method: "PATCH", body: JSON.stringify({ title: s.childTitle }) });
  await fx.post("/__assistant-test/rn/link", { child: s.child, parent: s.manager });

  // The first start has no run before it: nothing restarted as far as anyone can tell, so no news.
  await k.noNewsTurn(s.main, "first start");
  const state = await k.state();
  assert.equal(state.pending, null, "first start: no news is kept for later either");
  assert.equal(state.runs.length, 1, "first start: the run log holds this one run");
  assert.match(k.logOf(), /first recorded server run: no restart news/, "first start: the server says why nothing was sent");
  k.record("0", "first start: no wake turn and no news (no previous run), the run still recorded; manager and child chat seeded");
}

/** a. SIGKILL with no reason given: the run log's missing stop reads as a crash. */
export async function scenarioA(k, s) {
  const ctx = await restartWithCutOff(k, s, {
    id: "a", how: "crash", env: {}, kind: "crash",
    expect: ["the PPM server crashed", "the previous run stopped without shutting down", "The run before it did not shut down cleanly", `Version ${s.VERSION}.`],
  });
  assert.doesNotMatch(ctx, /Version [^\n]*→/, "a: no version change on a crash");
  k.record("a", "crash (SIGKILL, no reason): one wake turn says crashed and not shut down cleanly, lists the child under its manager; the manager gets the message with reason restart");
}

/** b. A clean stop, then an upgrade from an older version. */
export async function scenarioB(k, s) {
  await restartWithCutOff(k, s, {
    id: "b", how: "clean", kind: "upgrade",
    env: { PPM_START_REASON: "upgrade", PPM_ASSISTANT_E2E_PREVIOUS_VERSION: "0.0.1-e2e" },
    expect: ["PPM was upgraded", `Version 0.0.1-e2e → ${s.VERSION}.`, "The run before it shut down cleanly at", "(SIGTERM)"],
  });
  k.record("b", "upgrade (SIGTERM, PPM_START_REASON=upgrade): one wake turn names the upgrade, 0.0.1-e2e → current version and the clean stop; child listed; manager messaged");
}

/**
 * c. The supervisor's health check killed the server with a hard kill, as it always stops a server
 * on Windows: the run writes no stop, but the supervisor's note says it ordered the stop.
 */
export async function scenarioC(k, s) {
  await restartWithCutOff(k, s, {
    id: "c", how: "crash", kind: "watchdog",
    stopOpts: { orderedBy: "the health check found it not answering" },
    env: { PPM_START_REASON: "watchdog", PPM_START_DETAIL: "health check failed 3 times" },
    expect: ["a watchdog restarted PPM", "(\"health check failed 3 times\")", "The run before it was stopped by PPM's supervisor (\"the health check found it not answering\")"],
    unexpected: ["did not shut down cleanly"],
  });
  k.record("c", "watchdog (supervisor's stop note + SIGKILL, PPM_START_REASON=watchdog + detail): one wake turn quotes the detail and says the supervisor stopped the run, not that it failed to shut down cleanly; child listed; manager messaged");
}

/** d. `ppm restart --reason …`: a clean stop and a manual start with the user's words. */
export async function scenarioD(k, s) {
  await restartWithCutOff(k, s, {
    id: "d", how: "clean", kind: "manual",
    env: { PPM_START_REASON: "manual", PPM_START_DETAIL: "ppm restart --reason e2e check" },
    expect: ["someone restarted PPM", "(\"ppm restart --reason e2e check\")", "The run before it shut down cleanly at"],
  });
  k.record("d", "manual (SIGTERM, PPM_START_REASON=manual + detail): one wake turn quotes the words and the clean stop; child listed; manager messaged");
}
