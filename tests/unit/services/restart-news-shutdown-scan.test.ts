/**
 * A machine shutting down, as the session trace records it: the OS kills each chat's background
 * shell first (the CLI reports it `failed`), the CLI then carries on with a turn nobody opened, and
 * PPM dies a few seconds later with that turn unanswered. Both chats must be told as cut off, and a
 * chat whose shell was killed before its CLI could carry on must be told as background work stopped.
 * The timeline is made up, shaped like the reboot of 16/11/2026 18:19 UTC.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb, getTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch } from "../../../src/services/session-trace/session-trace-store.ts";
import { cutOffTurn, findInterruptedChats } from "../../../src/services/restart-news/interrupted-chats.ts";
import {
  findBackgroundWorkChats, runningTasks, SHUTDOWN_KILL_WINDOW_MS, withKilledTasks, type BackgroundWorkDeps,
} from "../../../src/services/restart-news/background-work-chats.ts";
import { addRestartNews, pendingRestartNews, type RestartNewsStore } from "../../../src/services/restart-news/restart-news-source.ts";
import { restartNewsEntry } from "../../../src/services/restart-news/restart-news-text.ts";
import { parseRestartNews, type BackgroundWorkChat } from "../../../src/shared/restart-news.ts";

const dirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-restart-shutdown-"));
  dirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
});

afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
});

const at = (hms: string) => Date.parse(`2026-11-16T${hms}Z`);
const PREV_START = at("16:22:57");
const RESTART = at("18:23:56");
type Event = { type: string; [k: string]: unknown };

/** One trace's rows at the given times, in order, the way the recorder writes them. */
function trace(traceId: string, rows: Array<[string, Event]>): void {
  // As the recorder writes them: a turn's rows carry its id, rows after a turn's end that no message opened carry none.
  const lastEnd = rows.findLastIndex(([, e]) => e.type === "done");
  appendBatch(rows.map(([hms, event], i) => ({
    traceId, turnId: i > lastEnd && lastEnd >= 0 ? null : "t", ts: at(hms), source: event.type === "user_message" ? "server" : "agent", origin: "ws",
    providerId: "claude", refId: null, type: event.type, payloadJson: JSON.stringify(event),
  })));
}

const user = (text: string): Event => ({ type: "user_message", text });
const text = (content: string): Event => ({ type: "text", content });
const done: Event = { type: "done", sessionId: "s" };
const shell = (id: string, tool: string, description: string): Event => ({
  type: "tool_use", tool, toolUseId: id, input: { command: "gh pr checks --watch", description, run_in_background: true },
});
const started = (taskId: string, toolUseId: string): Event => ({ type: "system", subtype: "task_started", taskId, taskToolUseId: toolUseId });
const ended = (taskId: string, status: string): Event => ({ type: "system", subtype: "task_notification", taskId, taskStatus: status });
const step = (tool: string): Event => ({ type: "tool_use", tool, toolUseId: `${tool}-step`, input: {} });

const meta: Record<string, { title: string }> = {
  watcher: { title: "Watch the release PRs and deploy" },
  reset: { title: "Reset password: BE builds the link, drop the redirect" },
  quiet: { title: "Run the integration suite" },
  handled: { title: "Migrate the reports" },
  reacted: { title: "Lint the web app" },
};

function deps(): BackgroundWorkDeps {
  return {
    traceDb: getTraceDb(),
    sessionOf: (id) => id,
    projectPathOf: (id) => (meta[id] ? "/p/nx" : null),
    projectNameOf: (path) => (path === "/p/nx" ? "nx" : null),
    providerOf: () => "claude",
    titleOf: (id) => meta[id]?.title ?? null,
    isAssistant: () => false,
    isDesign: () => false,
    managerOf: () => "watcher",
    parentOf: () => null,
    openCardsOf: () => 0,
  };
}

/** The reboot: two chats carry on after their shells are killed and are cut off; one is killed before it can. */
function seedReboot(): void {
  // A manager chat watching PRs: its shell started 18:15:43, its turn ended 18:15:48.
  trace("watcher", [
    ["18:15:40", user("Keep waiting to merge the PRs when green, then deploy")],
    ["18:15:43", shell("w1", "PowerShell", "Keep waiting to merge the PRs when green and deploy")],
    ["18:15:43.5", started("bxa5v5ube", "w1")],
    ["18:15:48", done],
    // Windows kills the shell; the CLI carries on by itself and is cut off mid-call.
    ["18:19:22", ended("bxa5v5ube", "failed")],
    ["18:19:24", { type: "system", subtype: "init" }],
    ["18:19:26", step("Bash")],
    ["18:19:36", text("The watcher stopped; checking why")],
  ]);
  // A chat waiting on two integration runs: the same, its turn ended long before.
  trace("reset", [
    ["17:51:10", user("Wait for both integration runs to finish")],
    ["17:51:15", shell("r1", "Bash", "Wait for both integration runs to finish")],
    ["17:51:15.5", started("b0bucruza", "r1")],
    ["17:51:24", done],
    ["18:19:22", ended("b0bucruza", "failed")],
    ["18:19:28", step("Bash")],
    ["18:19:37", { type: "thinking", content: "…" }],
  ]);
  // Killed too, but the CLI died before it could carry on: background work stopped.
  trace("quiet", [
    ["18:00:00", user("Run the integration suite in the background")],
    ["18:00:02", shell("q1", "Bash", "Run the integration suite")],
    ["18:00:02.5", started("qtask", "q1")],
    ["18:00:05", done],
    ["18:19:23", ended("qtask", "killed")],
  ]);
  // A task that failed on its own long before the end, which the chat already took in.
  trace("handled", [
    ["17:00:00", user("Migrate the reports")],
    ["17:00:01", shell("h1", "Bash", "Run the migration")],
    ["17:00:01.5", started("htask", "h1")],
    ["17:00:03", done],
    ["17:30:00", ended("htask", "failed")],
  ]);
  // Failed inside the window, but the chat carried on and finished before PPM died.
  trace("reacted", [
    ["18:18:00", user("Lint the web app")],
    ["18:18:01", shell("l1", "Bash", "Run the linter")],
    ["18:18:01.5", started("ltask", "l1")],
    ["18:18:03", done],
    ["18:19:20", ended("ltask", "failed")],
    ["18:19:25", text("The linter failed: 3 errors")],
    ["18:19:30", done],
  ]);
}

describe("a machine shutting down under PPM", () => {
  it("lists both chats that carried on by themselves as cut off, with no prompt and what they were doing", () => {
    seedReboot();
    const cut = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    expect(cut.chats.map((c) => c.sessionId)).toEqual(["reset", "watcher"]);
    expect(cut.chats.find((c) => c.sessionId === "watcher")).toMatchObject({
      title: "Watch the release PRs and deploy", activity: "writing its answer", lastAt: at("18:19:36"), continued: true, manager: true,
    });
    expect(cut.chats.find((c) => c.sessionId === "reset")).toMatchObject({ activity: "thinking", lastAt: at("18:19:37"), continued: true });
    for (const c of cut.chats) expect(c.prompt).toBeUndefined();
  });

  it("lists the chat whose shell was killed before it could carry on as background work stopped, and nothing else", () => {
    seedReboot();
    const cut = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    const bg = findBackgroundWorkChats(deps(), { since: PREV_START, restartAt: RESTART }, new Set(cut.allIds));
    expect(bg.chats.map((c) => c.sessionId)).toEqual(["quiet"]);
    expect(bg.chats[0]!.tasks).toEqual([
      { taskId: "qtask", tool: "Bash", startedAt: at("18:00:02.5"), state: "unknown", description: "Run the integration suite" },
    ]);
  });

  it("names on each cut-off entry the background work the shutdown killed, and only that", () => {
    seedReboot();
    const cut = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    const bg = findBackgroundWorkChats(deps(), { since: PREV_START, restartAt: RESTART }, new Set(cut.allIds));
    expect(Object.keys(bg.killedInCutOff ?? {}).sort()).toEqual(["reset", "watcher"]);
    const named = withKilledTasks(cut, bg);
    const killedOf = (id: string) => named.chats.find((c) => c.sessionId === id)!.killedTasks?.map((t) => [t.taskId, t.description]);
    expect(killedOf("watcher")).toEqual([["bxa5v5ube", "Keep waiting to merge the PRs when green and deploy"]]);
    expect(killedOf("reset")).toEqual([["b0bucruza", "Wait for both integration runs to finish"]]);
    // The background list itself is unchanged: cut-off chats are not listed there again.
    expect(bg.chats.map((c) => c.sessionId)).toEqual(["quiet"]);
    // A cut-off chat whose task was not killed in the window gets no line.
    const clean = withKilledTasks(cut, { chats: [], more: 0 });
    expect(clean.chats.every((c) => c.killedTasks === undefined)).toBe(true);
  });

  it("goes by the stop a clean run wrote, when there is one", () => {
    seedReboot();
    // The run stopped cleanly well after the kill: the kill was not the shutdown's doing.
    const later = findBackgroundWorkChats(deps(), { since: PREV_START, restartAt: RESTART, runEnd: at("18:22:00") }, new Set(["watcher", "reset"]));
    expect(later.chats).toEqual([]);
    const right = findBackgroundWorkChats(deps(), { since: PREV_START, restartAt: RESTART, runEnd: at("18:19:40") }, new Set(["watcher", "reset"]));
    expect(right.chats.map((c) => c.sessionId)).toEqual(["quiet"]);
  });

  it("puts them all in the restart news, tells the turn nobody opened, and the payload survives the store", () => {
    seedReboot();
    const cut = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    const bg = findBackgroundWorkChats(deps(), { since: PREV_START, restartAt: RESTART }, new Set(cut.allIds));
    let json: string | null = null;
    const store: RestartNewsStore = { load: () => json, save: (j) => { json = j; } };
    addRestartNews(store, { at: RESTART, kind: "boot", toVersion: "0.26.5", cleanStop: false }, withKilledTasks(cut, bg), bg);
    const pending = pendingRestartNews(store)!;
    expect(parseRestartNews(pending)).toEqual(pending);
    const entry = restartNewsEntry([pending])!;
    expect(entry).toContain("Chats cut off mid-turn (2):");
    expect(entry).toContain("No message opened the cut-off turn: the chat had carried on by itself");
    expect(entry).toContain('Its background work "Keep waiting to merge the PRs when green and deploy" was killed at shutdown; tell the chat so when asking it to carry on.');
    expect(entry).toContain('Its background work "Wait for both integration runs to finish" was killed at shutdown');
    expect(entry).toContain("Chats whose background work was stopped (1)");
    expect(entry).not.toContain("No chat was cut off");
  });
});

describe("the decisions underneath", () => {
  const row = (type: string, ts = 1, turn: string | null = null, text: string | null = null) =>
    ({ ts, type, origin: "ws", provider_id: "claude", turn_id: turn, text, tool: type === "tool_use" ? "Bash" : null, request_id: null });

  it("a follow-up queued while the turn ran, cut off after that turn ended, is told with its own prompt", () => {
    // Newest first: turn 2's work, turn 1's end, turn 2's message (written while turn 1 ran), turn 1.
    const turn = cutOffTurn([row("tool_use", 5, "t2"), row("done", 4, "t1"), row("user_message", 3, "t2", "Also fix the tests"), row("text", 2, "t1"), row("user_message", 1, "t1", "Build it")]);
    expect(turn).toMatchObject({ prompt: "Also fix the tests", activity: "running tool Bash", lastAt: 5 });
    expect(turn!.continued).toBeUndefined();
  });

  it("an approval a background agent asks for between turns is no cut-off turn", () => {
    expect(cutOffTurn([row("approval_request", 3), row("system", 2), row("done", 1)])).toBeNull();
  });

  it("a turn ended, then only notices: nothing cut off", () => {
    expect(cutOffTurn([row("system", 3), row("system", 2), row("done", 1)])).toBeNull();
  });

  it("a turn ended, then turn work with no message: a continuation cut off", () => {
    expect(cutOffTurn([row("system", 4), row("tool_use", 3), row("system", 2), row("done", 1)]))
      .toMatchObject({ continued: true, activity: "between steps", lastAt: 4 });
  });

  it("a kill counts only inside the window before the run's end, and not once a turn ended after it", () => {
    const task = (subtype: string, ts: number, status?: string) =>
      ({ ts, type: "system", origin: "ws", provider_id: "claude", subtype, task_id: "t1", status: status ?? null, tool_use_id: "u1" });
    const end = 1_000_000;
    const from = end - SHUTDOWN_KILL_WINDOW_MS;
    expect(runningTasks([task("task_started", 1), task("task_notification", end - 5_000, "failed")], from).map((t) => t.taskId)).toEqual(["t1"]);
    expect(runningTasks([task("task_started", 1), task("task_notification", end - 5_000, "killed")], from)).toHaveLength(1);
    expect(runningTasks([task("task_started", 1), task("task_notification", from - 1, "failed")], from)).toEqual([]);
    expect(runningTasks([task("task_started", 1), task("task_notification", end - 5_000, "completed")], from)).toEqual([]);
    expect(runningTasks([task("task_started", 1), task("task_notification", end - 5_000, "stopped")], from)).toEqual([]);
    const reacted = [task("task_started", 1), task("task_notification", end - 5_000, "failed"),
      { ts: end - 1_000, type: "done", origin: "ws", provider_id: "claude", subtype: null, task_id: null, status: null, tool_use_id: null }];
    expect(runningTasks(reacted, from)).toEqual([]);
    // Without a run end nothing changes from before.
    expect(runningTasks([task("task_started", 1), task("task_notification", end - 5_000, "failed")])).toEqual([]);
  });
});

describe("news merged before it goes out", () => {
  it("a chat whose background work two restarts stopped keeps every stopped task, each once", () => {
    let json: string | null = null;
    const store: RestartNewsStore = { load: () => json, save: (j) => { json = j; } };
    const T = Date.now() - 120_000;
    const chat = (restartAt: number, tasks: BackgroundWorkChat["tasks"]): BackgroundWorkChat => ({
      sessionId: "x", providerId: "claude", projectName: "nx", title: "x", lastAt: restartAt - 1_000, restartAt, tasks,
    });
    const a = { taskId: "a", tool: "Bash", startedAt: T - 50_000, state: "unknown" as const, description: "deploy" };
    const b = { taskId: "b", tool: "Agent", startedAt: T + 10_000, state: "stopped" as const, description: "review" };
    addRestartNews(store, { at: T, kind: "manual", toVersion: "1" }, { chats: [], more: 0 }, { chats: [chat(T, [a])], more: 0 });
    addRestartNews(store, { at: T + 60_000, kind: "crash", toVersion: "1" }, { chats: [], more: 0 }, { chats: [chat(T + 60_000, [b, { ...a, state: "alive" }])], more: 0 });
    const pending = pendingRestartNews(store)!;
    expect(pending.restarts.map((r) => r.kind)).toEqual(["manual", "crash"]);
    expect(pending.backgroundChats).toHaveLength(1);
    expect(pending.backgroundChats![0]!.tasks.map((t) => [t.taskId, t.state])).toEqual([["b", "stopped"], ["a", "alive"]]);
  });
});
