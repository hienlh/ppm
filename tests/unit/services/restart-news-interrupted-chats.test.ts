/**
 * Which chats a restart cut off, read from a seeded session trace: a turn nothing ended counts; a
 * finished turn, a chat idle since before the previous run, a chat the new run already took up,
 * the Assistant's own sessions and design sessions do not. A pending approval, open cards, the
 * manager flag and the parent link come along.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb, getTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch } from "../../../src/services/session-trace/session-trace-store.ts";
import {
  cutOffTurn, findInterruptedChats, MAX_INTERRUPTED_LISTED, type InterruptedChatDeps,
} from "../../../src/services/restart-news/interrupted-chats.ts";

const dirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-restart-scan-"));
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

const PREV_START = 1_000_000;
const RESTART = 2_000_000;
type Event = { type: string; [k: string]: unknown };

/** One trace's rows from `at` on, a millisecond apart, the way the recorder writes them. */
function trace(traceId: string, at: number, events: Event[], origin = "ws"): void {
  appendBatch(events.map((event, i) => ({
    traceId, turnId: "t", ts: at + i, source: event.type === "user_message" ? "server" : "agent", origin,
    providerId: "claude", refId: null, type: event.type, payloadJson: JSON.stringify(event),
  })));
}

const user = (text: string): Event => ({ type: "user_message", text });
const tool = (name: string): Event => ({ type: "tool_use", tool: name, input: {}, toolUseId: "x" });
const done: Event = { type: "done", sessionId: "s" };

const meta: Record<string, { path?: string; title?: string; design?: boolean; assistant?: boolean; parent?: string; cards?: number }> = {
  mgr: { path: "/p/api", title: "API manager" },
  child: { path: "/p/api", title: "Fix login", parent: "mgr", cards: 1 },
  web: { path: "/p/web", title: "Web chat" },
  asst: { path: "/ppm/assistant", assistant: true },
  design: { path: "/p/web", design: true },
  stray: { path: "/not/a/project", title: "Outside every project" },
};

/** Numbered sessions `s0`, `s1`… are ordinary chats of `web`. */
const pathOf = (id: string) => meta[id]?.path ?? (/^s\d+$/.test(id) ? "/p/web" : null);

function deps(): InterruptedChatDeps {
  return {
    traceDb: getTraceDb(),
    sessionOf: (id) => id,
    projectPathOf: pathOf,
    projectNameOf: (path) => ({ "/p/api": "api", "/p/web": "web" } as Record<string, string>)[path] ?? null,
    providerOf: () => "claude",
    titleOf: (id) => meta[id]?.title ?? null,
    isAssistant: (id) => !!meta[id]?.assistant,
    isDesign: (id) => !!meta[id]?.design,
    managerOf: (path) => (path === "/p/api" ? "mgr" : null),
    parentOf: (id) => meta[id]?.parent ?? null,
    openCardsOf: (id) => meta[id]?.cards ?? 0,
  };
}

describe("finding the chats a restart cut off", () => {
  it("lists a cut-off turn with what it was doing, and leaves finished and idle chats out", () => {
    trace("mgr", PREV_START + 10, [user("Coordinate the release\nsecond line"), tool("Bash")]);
    trace("web", PREV_START + 100, [user("Build it"), { type: "text", content: "Done" }, done]);
    trace("old", PREV_START - 500_000, [user("Long ago"), tool("Read")]); // before the previous run
    const scan = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    expect(scan.chats.map((c) => c.sessionId)).toEqual(["mgr"]);
    expect(scan.chats[0]).toMatchObject({
      projectName: "api", title: "API manager", prompt: "Coordinate the release", activity: "running tool Bash", manager: true, restartAt: RESTART,
    });
    expect(scan.more).toBe(0);
  });

  it("notes an approval still waiting, open cards and the chat that opened it", () => {
    trace("child", PREV_START + 20, [
      user("Fix the login bug"),
      { type: "approval_request", requestId: "r1", tool: "Edit", input: {} },
      { type: "approval_resolved", requestId: "r1", approved: true },
      { type: "approval_request", requestId: "r2", tool: "Bash", input: {} },
    ]);
    const [chat] = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART }).chats;
    expect(chat).toMatchObject({ sessionId: "child", pendingApproval: "Bash", openCards: 1, parentSessionId: "mgr", activity: "waiting for approval of Bash" });
    expect(chat!.manager).toBeUndefined();
  });

  it("leaves out the Assistant's sessions, design sessions and the API proxy's streams", () => {
    trace("asst", PREV_START + 1, [user("[PPM] News"), tool("Read")], "watch");
    trace("design", PREV_START + 2, [user("Make it blue"), tool("Write")]);
    trace("proxy-1", PREV_START + 3, [user("completion"), { type: "text", content: "…" }], "proxy");
    expect(findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART }).chats).toEqual([]);
  });

  it("leaves out another instance's chats: a trace this database never recorded, or one outside every project", () => {
    // The trace file is shared by ppm.db, ppm.dev.db and the CLI; only this database's own sessions count.
    trace("live-only", PREV_START + 1, [user("A live chat's secret task"), tool("Bash")]);
    trace("stray", PREV_START + 2, [user("Somewhere else"), tool("Bash")]);
    trace("web", PREV_START + 3, [user("Ours"), tool("Bash")]);
    const scan = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    expect(scan.chats.map((c) => c.sessionId)).toEqual(["web"]);
    expect(scan.more).toBe(0);
  });

  it("leaves out a chat the new run has already written to, and a turn stopped or closed on purpose", () => {
    trace("web", PREV_START + 5, [user("Cut off"), tool("Bash")]);
    trace("web", RESTART + 10, [user("Resumed by hand")]);
    trace("mgr", PREV_START + 6, [user("Stopped"), tool("Bash"), { type: "turn_aborted", reason: "ws_cancel" }]);
    trace("child", PREV_START + 7, [user("Closed"), { type: "run_closed", reason: "consumer_closed" }]);
    expect(findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART }).chats).toEqual([]);
  });

  it("does not count rows of a subagent, and caps the list", () => {
    for (let i = 0; i < MAX_INTERRUPTED_LISTED + 3; i++) trace(`s${i}`, PREV_START + i * 10, [user(`Task ${i}`), tool("Bash")]);
    trace("web", PREV_START + 900, [user("Answered"), done, { type: "tool_use", tool: "Bash", input: {}, parentToolUseId: "agent-1" }]);
    const scan = findInterruptedChats(deps(), { since: PREV_START, restartAt: RESTART });
    expect(scan.chats).toHaveLength(MAX_INTERRUPTED_LISTED);
    expect(scan.more).toBe(3);
    expect(scan.chats.some((c) => c.sessionId === "web")).toBe(false);
    // Newest first; a chat with no title is named by its id.
    expect(scan.chats[0]!.title).toBe(`Session s${MAX_INTERRUPTED_LISTED + 2}`);
  });
});

describe("the cut-off decision", () => {
  const row = (type: string, extra: Partial<{ tool: string; request_id: string; text: string }> = {}) =>
    ({ ts: 1, type, origin: "ws", provider_id: "claude", text: extra.text ?? null, tool: extra.tool ?? null, request_id: extra.request_id ?? null });

  it("an error the model went on past is not the end; a final error is", () => {
    expect(cutOffTurn([row("text"), row("error"), row("user_message", { text: "go" })])).not.toBeNull();
    expect(cutOffTurn([row("error"), row("text"), row("user_message", { text: "go" })])).toBeNull();
  });

  it("a turn whose opening message is older than the rows read still counts", () => {
    expect(cutOffTurn([row("tool_use", { tool: "Bash" }), row("text")])).toMatchObject({ activity: "running tool Bash" });
    expect(cutOffTurn([])).toBeNull();
  });
});
