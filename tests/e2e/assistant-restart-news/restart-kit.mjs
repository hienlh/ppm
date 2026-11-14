// Shared helpers of tests/e2e/assistant-restart-news-e2e.mjs: starting and stopping the fixture on
// one PPM_HOME (a crash is SIGKILL, a clean stop SIGTERM), the moved Assistant clock carried across
// restarts, cutting a chat off mid-turn, and reading what the main Assistant session was woken with.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureApi, startChild, until, sleep } from "../assistant-telegram/harness.mjs";

export { until, sleep };

export const HOUR = 60 * 60_000;
/** What PPM opens a wake turn carrying only restart news with (`RESTART_OPENER`). */
export const RESTART_OPENER = "[PPM] PPM restarted";
/** The heading of the restart-news entry in the shared context. */
export const NEWS_HEADING = "Restart news:";
/** `NO_REPLY_TEXT`: the Assistant's answer when nothing is worth a line to the user. */
export const NO_REPLY = "[no reply]";

/** Two hour-and-minute strings in UTC, the zone the e2e saves: `ms` as HH:MM. */
export const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/**
 * One fixture server at a time on a fixed port and PPM_HOME. `start` takes the extra environment
 * of that run (PPM_START_REASON, boot scripts…); the clock offset the last run reached is passed
 * on, so quiet hours and the hourly caps continue across the restart.
 */
export function restartKit({ web, baseEnv, logs, record }) {
  const fx = fixtureApi(web);
  let child = null;
  let runs = 0;
  let offset = 0;
  const pids = [];
  const data = async (path, init) => (await fx.api(path, init)).data;

  const kit = {
    fx, pids, record,
    get run() { return runs; },
    logOf: (n = runs) => readFileSync(join(logs, `fixture-${n}.log`), "utf8"),

    /** Starts run n+1; `bootScripts` are match scripts the fixture holds before its hub starts. */
    async start(extra = {}, bootScripts = []) {
      assert.equal(child, null, "one fixture at a time");
      runs += 1;
      const env = {
        ...baseEnv, ...extra,
        PPM_ASSISTANT_CLOCK_OFFSET_MS: String(offset),
        PPM_ASSISTANT_BOOT_SCRIPTS: JSON.stringify(bootScripts),
        ...(runs > 1 ? { PPM_ASSISTANT_FIXTURE_RESUME: "1" } : {}),
      };
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
      const started = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(logs, `fixture-${runs}.log`), ready: /Assistant fixture ready/ });
      child = started.child;
      pids.push(child.pid);
      await started.ready;
      console.log(`fixture run ${runs} ready, pid ${child.pid}${extra.PPM_START_REASON ? ` (PPM_START_REASON=${extra.PPM_START_REASON})` : ""}`);
    },

    /**
     * Ends the run: `crash` kills it with nothing written, `clean` lets it record its stop.
     * `orderedBy` first leaves the note the supervisor writes before a stop it orders
     * (`.server-stop.<pid>.json`), so a hard kill reads as the supervisor's, as on Windows.
     */
    async stop(how, { orderedBy } = {}) {
      assert.ok(child, "a fixture is running");
      offset = (await fx.api("/__assistant-test/clock")).offset;
      if (orderedBy) {
        writeFileSync(join(baseEnv.PPM_HOME, `.server-stop.${child.pid}.json`), JSON.stringify({ pid: child.pid, at: Date.now(), why: orderedBy }));
      }
      const exited = new Promise((r) => child.once("exit", r));
      child.kill(how === "crash" ? "SIGKILL" : "SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
      await exited;
      clearTimeout(timer);
      console.log(`fixture run ${runs} pid ${child.pid} stopped (${how === "crash" ? "SIGKILL" : "SIGTERM"})`);
      child = null;
    },

    /** The end of the e2e: a clean stop if a run is still up. */
    async close() {
      if (!child || child.exitCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
      console.log(`fixture run ${runs} pid ${child.pid} stopped (exit route)`);
      child = null;
    },

    /** Posts a scripted turn: `match` (message or shared context), `sessionId`, `reply`. */
    script: (label, ops, opts = {}) => fx.api("/__assistant-test/script", { method: "POST", body: JSON.stringify({ label, ops, ...opts }) }),
    say: (project, sessionId, text) => fx.post("/__assistant-test/say", { project, sessionId, text }),
    advance: async (ms) => (await fx.post("/__assistant-test/clock", { advanceMs: ms })).now,
    now: async () => (await fx.api("/__assistant-test/clock")).now,
    /** Nudges the wake queue now rather than at its 30 s tick. */
    tick: () => fx.post("/__assistant-test/clock", { advanceMs: 0 }),
    state: () => fx.api("/__assistant-test/rn/state"),
    trace: async (sessionId) => (await fx.api(`/__assistant-test/rn/trace/${sessionId}`)).rows,
    settings: async () => (await data("/api/assistant/settings")).settings,
    /** Changes Assistant settings the way Settings does: the stored row sent back whole. */
    async patchSettings(patch) {
      const settings = await kit.settings();
      return data("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, ...patch }) });
    },
    turns: async () => (await fx.state()).turns,
    turnsIn: async (sessionId) => (await kit.turns()).filter((t) => t.sessionId === sessionId),
    /** This run's wake turns on `main` that carried restart news. */
    newsTurns: async (main) => (await kit.turnsIn(main)).filter((t) => (t.sharedContext ?? "").includes(NEWS_HEADING)),
    /** Every call of the turn `label`, once each has its answer. */
    async answered(label, count, timeout = 30000) {
      return until(`${label}: ${count} call(s) answered`, async () => {
        const mine = await fx.recordsOf(label);
        return mine.length === count && mine.every((c) => c.done) ? mine : null;
      }, timeout);
    },
    /** No turn running and no card waiting in the session. */
    async idle(sessionId, timeout = 30000) {
      await until(`${sessionId} idle`, async () => {
        const { state } = await fx.api(`/__assistant-test/chat-live/${sessionId}`);
        return !state || (!state.running && !state.card);
      }, timeout, 200);
    },
    /** Every chat of the scenario idle, and still idle a moment later (a reply can wake the Assistant). */
    async settle(ids) {
      for (let round = 0; round < 2; round++) {
        for (const id of ids) await kit.idle(id, 60000);
        await sleep(1500);
      }
    },

    /**
     * Starts a turn in the child chat that never ends on its own, and waits until the trace holds
     * its opening row: the turn a restart then cuts off.
     */
    async cutOff(project, sessionId, label, text) {
      const since = Date.now();
      await kit.script(label, [{ sleep: 10 * 60_000 }], { match: text, sessionId });
      await kit.say(project, sessionId, text);
      await until(`${label}: turn started`, () => fx.turnOf(label), 30000);
      await until(`${label}: the trace holds the turn's opening`, async () =>
        (await kit.trace(sessionId)).some((r) => r.type === "user_message" && r.ts >= since - 1000), 15000, 200);
      const live = (await fx.api(`/__assistant-test/chat-live/${sessionId}`)).state;
      assert.ok(live?.running, `${label}: the child's turn is still running when PPM goes down`);
    },

    /**
     * The one restart-news wake turn of this run, once it started: waits for it, gives a second one
     * time to show up, and checks there is exactly one.
     */
    async oneNewsTurn(main, why, timeout = 60000) {
      await kit.tick();
      await until(`${why}: a restart-news wake turn`, async () => (await kit.newsTurns(main)).length > 0, timeout, 200);
      await kit.tick();
      await sleep(2500);
      const turns = await kit.newsTurns(main);
      assert.equal(turns.length, 1, `${why}: exactly one restart-news wake turn (got ${turns.length})`);
      return turns[0];
    },

    /** No restart-news wake turn this run, after the queue had its chance. */
    async noNewsTurn(main, why) {
      await kit.tick();
      await sleep(4000);
      await kit.tick();
      await sleep(1000);
      assert.equal((await kit.newsTurns(main)).length, 0, `${why}: no restart-news wake turn`);
    },
  };
  return kit;
}

/** The checks every "chat was cut off" news shares: the restart line, the tree, the send that followed. */
export async function assertCutOffNews(k, s, { turn, label, expect }) {
  assert.ok(turn.message.includes(RESTART_OPENER), `${label}: the wake turn opens with the restart opener (got ${JSON.stringify(turn.message.slice(0, 80))})`);
  assert.equal(turn.assistant, true, `${label}: it ran as an Assistant turn`);
  const ctx = turn.sharedContext;
  for (const text of expect) assert.ok(ctx.includes(text), `${label}: the news says ${JSON.stringify(text)}\n--- news ---\n${ctx}`);
  assert.ok(ctx.includes(`Project "alpha": manager chat is session ${s.manager}.`), `${label}: the project names its manager chat\n${ctx}`);
  const child = ctx.split("\n").find((l) => l.includes(`session ${s.child}`));
  assert.ok(child, `${label}: the cut-off child chat is listed\n${ctx}`);
  assert.match(child, /^\s{2,}- Chat (it opened|opened by session)/, `${label}: the child is listed under its manager: ${child}`);
  assert.ok(child.includes(`"${s.childTitle}"`), `${label}: the child is listed by its title: ${child}`);
  assert.ok(ctx.includes(`The cut-off turn began with: "${s.cutText}`), `${label}: the cut-off turn's first line is quoted\n${ctx}`);
  assert.ok(ctx.includes("What to do (the cut-off chats are listed after these steps):"), `${label}: the news asks the Assistant to have the manager resume`);
  assert.ok(ctx.indexOf("4. If a message to a manager chat is refused") < ctx.indexOf("Chats cut off mid-turn"), `${label}: the steps come before the list`);

  const [send] = await k.answered(label, 1);
  assert.equal(send.isError, false, `${label}: send_to_session to the manager was refused: ${send.text}`);
  const got = await until(`${label}: the manager got the message`, async () =>
    (await k.turnsIn(s.manager)).find((t) => t.blocks?.fromSession?.kind === "assistant" && t.blocks.content.includes(label)), 30000);
  assert.equal(got.blocks.provenance?.startedBy, "ppm", `${label}: the manager is told PPM started the Assistant's turn`);
  assert.ok((got.blocks.provenance?.reason ?? "").split(", ").includes("restart"), `${label}: the provenance carries the restart reason (got ${got.blocks.provenance?.reason})`);
  // Written by the server from the news, not from the Assistant's text: exactly alpha's cut-off chat.
  assert.deepEqual(got.blocks.provenance?.restartChats, [s.child], `${label}: the provenance lists the cut-off chat's id (got ${JSON.stringify(got.blocks.provenance?.restartChats)})`);
  return got;
}
