/**
 * Chats between turns whose background work a restart stopped: found in a seeded session trace
 * (a task started and nothing ended it, nor closed the CLI that ran it), told in their own section
 * of the restart news, urgent like a cut-off chat, re-checked when the news goes out, and named in
 * the provenance block so a manager may have them start their work again.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb, getTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch } from "../../../src/services/session-trace/session-trace-store.ts";
import { findBackgroundWorkChats, type BackgroundWorkDeps } from "../../../src/services/restart-news/background-work-chats.ts";
import { taskOutputProbe } from "../../../src/services/restart-news/task-output-file.ts";
import { scrubCommand } from "../../../src/services/restart-news/background-command-text.ts";
import {
  addRestartNews, createRestartNewsSource, pendingRestartNews, restartChatsCarried, restartNewsUrgent, type RestartNewsStore,
} from "../../../src/services/restart-news/restart-news-source.ts";
import { restartNewsEntry } from "../../../src/services/restart-news/restart-news-text.ts";
import { _resetRestartNews } from "../../../src/services/restart-news/restart-news-lifecycle.ts";
import { parseRestartNews, type BackgroundWorkChat } from "../../../src/shared/restart-news.ts";
import { PROVENANCE_RESTART_CHATS_MAX, validateProvenance } from "../../../src/shared/assistant-provenance.ts";

const dirs: string[] = [];
const originalHome = process.env.PPM_HOME;
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

beforeEach(() => {
  process.env.PPM_HOME = tempDir("ppm-restart-bg-");
  closeTraceDb();
  _resetPpmDir();
});
afterEach(() => _resetRestartNews());
afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
});

const PREV_START = 1_000_000;
const RESTART = 2_000_000;
type Event = { type: string; [k: string]: unknown };

function trace(traceId: string, at: number, events: Event[], origin = "ws"): void {
  appendBatch(events.map((event, i) => ({
    traceId, turnId: "t", ts: at + i, source: event.type === "user_message" ? "server" : "agent", origin,
    providerId: "claude", refId: null, type: event.type, payloadJson: JSON.stringify(event),
  })));
}

const user = (text: string): Event => ({ type: "user_message", text });
const done: Event = { type: "done", sessionId: "s" };
const bash = (id: string, command: string, description?: string): Event => ({
  type: "tool_use", tool: "Bash", toolUseId: id, input: { command, run_in_background: true, ...(description ? { description } : {}) },
});
const agent = (id: string, description: string): Event => ({ type: "tool_use", tool: "Agent", toolUseId: id, input: { description, prompt: "go" } });
const started = (taskId: string, toolUseId: string): Event => ({ type: "system", subtype: "task_started", taskId, taskToolUseId: toolUseId });
const ended = (taskId: string, status = "completed"): Event => ({ type: "system", subtype: "task_notification", taskId, taskStatus: status });

const paths: Record<string, string> = { mgr: "/p/api", bench: "/p/api", web: "/p/web", asst: "/ppm/assistant", design: "/p/web", ext: "/p/web" };

function deps(over: Partial<BackgroundWorkDeps> = {}): BackgroundWorkDeps {
  return {
    traceDb: getTraceDb(),
    sessionOf: (id) => id,
    projectPathOf: (id) => paths[id] ?? (/^s\d+$/.test(id) ? "/p/web" : null),
    projectNameOf: (path) => ({ "/p/api": "api", "/p/web": "web" } as Record<string, string>)[path] ?? null,
    providerOf: () => "claude",
    titleOf: (id) => (id === "bench" ? "Benchmark design skills" : null),
    isAssistant: (id) => id === "asst",
    isDesign: (id) => id === "design",
    managerOf: (path) => (path === "/p/api" ? "mgr" : null),
    parentOf: (id) => (id === "bench" ? "mgr" : null),
    openCardsOf: () => 0,
    ...over,
  };
}
const scan = (d = deps(), skip: string[] = []) => findBackgroundWorkChats(d, { since: PREV_START, restartAt: RESTART }, new Set(skip));

describe("finding the chats whose background work a restart stopped", () => {
  it("lists an idle chat with a background shell and agent still running, with what each was and what became of it", () => {
    trace("bench", PREV_START + 10, [
      user("Run the benchmark"),
      bash("tu1", "powershell -File run-batch.ps1 -Count 26 -Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
      started("b50", "tu1"),
      bash("tu3", "mysql -uroot -pS3cretPw0rd < seed.sql", "Seed the database"),
      started("b51", "tu3"),
      agent("tu2", "Review the harness"),
      started("a1", "tu2"),
      { type: "text", content: "Started." },
      done,
    ]);
    const result = scan();
    expect(result.more).toBe(0);
    expect(result.chats).toHaveLength(1);
    const c = result.chats[0]!;
    expect(c).toMatchObject({ sessionId: "bench", projectName: "api", title: "Benchmark design skills", parentSessionId: "mgr", restartAt: RESTART });
    expect(c.manager).toBeUndefined();
    expect(c.tasks.map((t) => [t.tool, t.state])).toEqual([["Agent", "stopped"], ["Bash", "unknown"], ["Bash", "unknown"]]);
    // With a description the command is not carried at all; without one it is, secrets taken out.
    expect(c.tasks[1]).toMatchObject({ taskId: "b51", description: "Seed the database" });
    expect(c.tasks[1]!.command).toBeUndefined();
    const shell = c.tasks[2]!;
    expect(shell).toMatchObject({ taskId: "b50", startedAt: PREV_START + 12, command: "powershell -File run-batch.ps1 -Count 26 -Token [REDACTED]" });
    expect(shell.description).toBeUndefined();
  });

  it("takes credentials out of a command line, whatever the tool", () => {
    const cases: Array<[string, string]> = [
      ["mysql -uroot -pS3cretPw0rd db", "S3cretPw0rd"],
      ["curl -u admin:SuperSecret123 https://x.test", "SuperSecret123"],
      ["sshpass -p MyPassw0rd ssh host", "MyPassw0rd"],
      ["docker login -u me -p dckr_pat_abc123 registry.test", "dckr_pat_abc123"],
      ["az login -u me -p Zx9secretvalue", "Zx9secretvalue"],
      ["git clone https://bot:ghp_tok3nvalue@github.com/a/b", "ghp_tok3nvalue"],
      ["API_TOKEN=abc123xyz node run.js", "abc123xyz"],
      ["$env:DB_PASSWORD = 'pw-123'; ./run.ps1", "pw-123"],
      ["deploy --password=hunter22 --api-key k3y", "hunter22"],
      ["deploy --password=hunter22 --api-key k3yvalue", "k3yvalue"],
      ['curl -H "Authorization: Bearer abc.def.ghi" https://x.test', "abc.def.ghi"],
    ];
    for (const [command, secret] of cases) expect(scrubCommand(command)).not.toContain(secret);
    // Ordinary flags survive.
    expect(scrubCommand("mkdir -p out && docker run -p 8080:80 web")).toBe("mkdir -p out && docker run -p 8080:80 web");
    expect(scrubCommand("powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Count 26")).toBe("powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Count 26");
  });

  it("leaves out work that ended, work whose CLI was closed, and chats the new run took up", () => {
    trace("s1", PREV_START + 10, [user("a"), bash("x", "sleep 5"), started("t1", "x"), ended("t1"), done]);
    trace("s2", PREV_START + 10, [user("b"), bash("y", "sleep 9"), started("t2", "y"), { type: "system", subtype: "task_updated", taskId: "t2", taskStatus: "killed" }, done]);
    trace("s3", PREV_START + 10, [user("c"), bash("z", "npm run dev"), started("t3", "z"), done, { type: "turn_aborted", reason: "warm_idle_cap" }]);
    trace("s4", PREV_START + 10, [user("d"), bash("w", "npm run dev"), started("t4", "w"), done]);
    trace("s4", RESTART + 50, [user("back again")]);
    expect(scan().chats).toEqual([]);
  });

  it("an agent woken again by SendMessage after it ended counts from its new start", () => {
    trace("s5", PREV_START + 10, [
      user("e"), agent("a", "Research"), started("ag", "a"), ended("ag"),
      { type: "tool_use", tool: "SendMessage", toolUseId: "m", input: { to: "researcher", message: "more" } }, started("ag", "m"), done,
    ]);
    const [c] = scan().chats;
    expect(c!.tasks).toEqual([expect.objectContaining({ taskId: "ag", tool: "SendMessage", description: "message to agent researcher", state: "stopped" })]);
  });

  it("follows the same filters as the cut-off list: skipped ids, other instances, Assistant, design, extension, older runs", () => {
    for (const id of ["asst", "design", "stray", "s6"]) trace(id, PREV_START + 10, [user("x"), bash(`u${id}`, "make"), started(`t${id}`, `u${id}`), done]);
    trace("ext", PREV_START + 10, [user("x"), bash("ue", "make"), started("te", "ue"), done], "extension");
    trace("s7", PREV_START - 500_000, [user("x"), bash("uo", "make"), started("to", "uo"), done]);
    expect(scan(deps(), ["s6"]).chats).toEqual([]);
  });

  it("marks a task alive when its output file was written after the restart", () => {
    trace("web", PREV_START + 10, [user("x"), bash("u", "docker logs -f api"), started("live1", "u"), bash("v", "make"), started("quiet1", "v"), done]);
    const base = tempDir("claude-tasks-");
    const tasks = join(base, "abc123", "web", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "live1.output"), "still logging");
    writeFileSync(join(tasks, "quiet1.output"), "done long ago");
    utimesSync(join(tasks, "live1.output"), new Date(RESTART + 60_000), new Date(RESTART + 60_000));
    utimesSync(join(tasks, "quiet1.output"), new Date(RESTART - 60_000), new Date(RESTART - 60_000));
    const [c] = scan(deps({ taskOutputWrittenSince: taskOutputProbe([base]) })).chats;
    expect(Object.fromEntries(c!.tasks.map((t) => [t.taskId, t.state]))).toEqual({ live1: "alive", quiet1: "unknown" });
  });

  it("the output probe never steps outside the task folders", () => {
    const base = tempDir("claude-tasks-");
    mkdirSync(join(base, "h", "s"), { recursive: true });
    writeFileSync(join(base, "h", "s", "x.output"), "x");
    const probe = taskOutputProbe([base]);
    expect(probe("..", "x", 0)).toBe(false);
    expect(probe("s/../s", "x", 0)).toBe(false);
    expect(probe("s", "../x", 0)).toBe(false);
  });
});

const memoryStore = (): RestartNewsStore => { let json: string | null = null; return { load: () => json, save: (j) => { json = j; } }; };
// Recent, so the 24-hour expiry never drops it whenever the suite runs.
const T = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const bgChat = (sessionId: string, over: Partial<BackgroundWorkChat> = {}): BackgroundWorkChat => ({
  sessionId, providerId: "claude", projectName: "api", title: `Chat ${sessionId}`, lastAt: T - 30_000, restartAt: T,
  tasks: [{ taskId: `t-${sessionId}`, tool: "PowerShell", description: "Resume benchmark", command: "powershell -File run-batch.ps1", startedAt: T - 55_000, state: "unknown" }],
  ...over,
});
const restart = { at: T, kind: "upgrade" as const, fromVersion: "0.25.8", toVersion: "0.25.9" };

describe("in the restart news", () => {
  it("is kept apart from the cut-off chats, makes the news urgent, and survives the store", () => {
    const store = memoryStore();
    addRestartNews(store, restart, { chats: [], more: 0 }, { chats: [bgChat("bench")], more: 2 });
    const pending = pendingRestartNews(store)!;
    expect(pending.chats).toEqual([]);
    expect(pending.backgroundChats!.map((c) => c.sessionId)).toEqual(["bench"]);
    expect(pending.moreBackgroundChats).toBe(2);
    expect(parseRestartNews(pending)).toEqual(pending);
    expect(restartNewsUrgent([], 0, 1)).toBe(true);
    const source = createRestartNewsSource({ store, mainSession: () => "main", canonical: (id) => id, managers: () => [{ projectName: "api", sessionId: "mgr" }] });
    const [item] = source.pending("main");
    expect(item!.urgent).toBe(true);
    expect(item!.news!.restart!.managers).toEqual([{ projectName: "api", sessionId: "mgr" }]);
  });

  it("a chat found by two restarts is told once, as the later one found it", () => {
    const store = memoryStore();
    const cut = { sessionId: "x", providerId: "claude", projectName: "api", title: "x", lastAt: T - 5_000, restartAt: T };
    addRestartNews(store, restart, { chats: [cut], more: 0 });
    // Resumed after that restart, then between turns with its background work at the next one.
    addRestartNews(store, { ...restart, at: T + 60_000, kind: "crash" }, { chats: [], more: 0 }, { chats: [bgChat("x", { restartAt: T + 60_000, lastAt: T + 50_000 })], more: 0 });
    const pending = pendingRestartNews(store)!;
    expect(pending.chats).toEqual([]);
    expect(pending.backgroundChats!.map((c) => [c.sessionId, c.restartAt])).toEqual([["x", T + 60_000]]);
  });

  it("an unlisted count goes once nothing of its list is left to tell", () => {
    const store = memoryStore();
    addRestartNews(store, restart, { chats: [], more: 0 }, { chats: [bgChat("gone")], more: 4 });
    const source = createRestartNewsSource({ store, mainSession: () => "main", canonical: (id) => id, managers: () => [], stillCutOff: () => false });
    const [item] = source.pending("main");
    expect(item!.news!.restart!.backgroundChats).toBeUndefined();
    expect(item!.news!.restart!.moreBackgroundChats).toBeUndefined();
    expect(item!.urgent).toBe(false);
  });

  it("a chat cut off at a later restart is told once, as cut off", () => {
    const store = memoryStore();
    addRestartNews(store, restart, { chats: [], more: 0 }, { chats: [bgChat("bench")], more: 0 });
    const cut = { sessionId: "bench", providerId: "claude", projectName: "api", title: "x", lastAt: T + 5_000, restartAt: T + 10_000 };
    addRestartNews(store, { ...restart, at: T + 10_000, kind: "crash" }, { chats: [cut], more: 0 });
    const pending = pendingRestartNews(store)!;
    expect(pending.chats.map((c) => c.sessionId)).toEqual(["bench"]);
    expect(pending.backgroundChats).toBeUndefined();
  });

  it("is re-checked when it goes out: a chat that ran again is dropped, a task writing again is alive", () => {
    const store = memoryStore();
    addRestartNews(store, restart, { chats: [], more: 0 }, { chats: [bgChat("bench"), bgChat("again", { lastAt: T - 1 })], more: 3 });
    const source = createRestartNewsSource({
      store, mainSession: () => "main", canonical: (id) => id, managers: () => [],
      stillCutOff: (c) => c.sessionId !== "again",
      taskOutputProbe: () => (sessionId, taskId, since) => sessionId === "bench" && taskId === "t-bench" && since === T,
    });
    const restartNews = source.pending("main")[0]!.news!.restart!;
    expect(restartNews.backgroundChats!.map((c) => [c.sessionId, c.tasks[0]!.state])).toEqual([["bench", "alive"]]);
    expect(restartNews.moreBackgroundChats).toBe(3);
  });

  it("tells each chat's work and its state, and asks the manager to check and start it again", () => {
    const text = restartNewsEntry([{
      restarts: [restart], chats: [], managers: [{ projectName: "api", sessionId: "mgr" }],
      backgroundChats: [bgChat("bench", { parentSessionId: "mgr", moreTasks: 2 })], moreBackgroundChats: 1,
    }])!;
    expect(text).toContain("Chats cut off mid-turn: none.");
    expect(text).toContain("Chats whose background work was stopped (2)");
    expect(text).toContain('Project "api": manager chat is session mgr.');
    expect(text).toContain('"Chat bench" (session bench, claude): was between turns');
    expect(text).toContain(`PowerShell started at ${new Date(T - 55_000).toISOString()} (for "Resume benchmark", command "powershell -File run-batch.ps1")`);
    expect(text).toContain("After the restart: not known");
    expect(text).toContain("It must not be started again without the user's OK");
    expect(text).toContain("and 2 more background task(s)");
    expect(text).toContain("And 1 more chat(s) with stopped background work not listed");
    expect(text).toContain("the manager first asks the user with a needs_decision report");
    expect(text).toContain("a task still running is only checked on");
    expect(text).not.toContain("There is nothing to resume");
  });

  it("is what a manager may be asked to run again, beside the cut-off chats, within the provenance cap", () => {
    const items = [{ news: { restart: { restarts: [restart], chats: [{ sessionId: "cut", projectName: "api" }], backgroundChats: [bgChat("bench"), bgChat("w", { projectName: "web" })] } } }];
    const queue = { carriedItems: () => items } as unknown as Parameters<typeof restartChatsCarried>[0];
    expect(restartChatsCarried(queue, "main", "api")).toEqual(["cut", "bench"]);
    expect(restartChatsCarried(queue, "main", "web")).toEqual(["w"]);
    const ids = Array.from({ length: PROVENANCE_RESTART_CHATS_MAX }, (_, i) => `s${i}`);
    expect(validateProvenance({ startedBy: "ppm", untrusted: true, reason: "news, restart", restartChats: ids })).not.toBeNull();
    expect(PROVENANCE_RESTART_CHATS_MAX).toBeGreaterThanOrEqual(60);
  });

  it("a malformed task is refused whole", () => {
    const bad = { restarts: [restart], chats: [], backgroundChats: [bgChat("x", { tasks: [{ ...bgChat("x").tasks[0]!, taskId: "../../etc" }] })] };
    expect(parseRestartNews(bad)).toBeNull();
    // Which is why the scan never stores such an id.
    trace("s9", PREV_START + 10, [user("x"), bash("u9", "make"), started("../odd", "u9"), done]);
    expect(scan().chats).toEqual([]);
    expect(parseRestartNews({ restarts: [restart], chats: [], backgroundChats: [bgChat("x", { tasks: [] })] })).toBeNull();
  });
});
