/**
 * The Agent card session hub: subscribe → catch-up → live tick, per-file
 * reset on truncation/compaction, ownership/cap/auth/send enforcement, the
 * running-agents feed, and the cost guarantees (one stat per file per tick,
 * a cached index refresh, no reads when nothing changed).
 *
 * The clock and the per-session timers are swapped for no-op seams so every
 * tick in this file is driven by hand — nothing here waits on a real
 * setInterval, and "250ms later" is simulated by moving the fake clock and
 * calling the tick function directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { _setCodexSessionsDirsForTest } from "../../../src/services/agent-transcript/session-ownership.ts";
import { _resetSourcesCache } from "../../../src/services/agent-transcript/agent-transcript-sources.ts";
import { _resetAgentTranscriptIndexCache, getCachedSubagentGroups } from "../../../src/services/agent-transcript/agent-transcript-index-cache.ts";
import {
  agentTranscriptClock, agentTranscriptTimers, resetAgentTranscriptClockForTest,
} from "../../../src/services/agent-transcript/agent-transcript-hub-clock.ts";
import {
  agentTranscriptFsIo, realAgentTranscriptFsIo, resetAgentTranscriptFsIoForTest,
} from "../../../src/services/agent-transcript/agent-transcript-fs-io.ts";
import { tickTranscripts } from "../../../src/services/agent-transcript/agent-transcript-session-hub.ts";
import { tickActivity } from "../../../src/services/agent-transcript/agent-transcript-session-hub-activity.ts";
import {
  _computeRunningAgentsCallCountForTest, _resetComputeRunningAgentsCallCountForTest,
} from "../../../src/services/agent-transcript/agent-transcript-activity.ts";
import {
  _debugHubSnapshotForTest, _getSessionHubForTest, _resetAgentTranscriptHubForTest,
  handleAgentActivitySubscribe, handleAgentActivityUnsubscribe, handleAgentTranscriptClientClosed,
  handleAgentTranscriptSubscribe, handleAgentTranscriptUnsubscribe,
} from "../../../src/services/agent-transcript/agent-transcript-hub.ts";
import type { AgentTranscriptWsLike } from "../../../src/services/agent-transcript/agent-transcript-ws-like.ts";
import type {
  AgentActivityMsg, AgentTranscriptErrorMsg, AgentTranscriptEventsMsg,
} from "../../../src/shared/agent-transcript-protocol.ts";

const PROJECT_A = "project-a";
const PROJECT_A_PATH = "/workspace/project-a";
const PROJECT_B = "project-b";
const PROJECT_B_PATH = "/workspace/project-b";
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function slugOf(projectPath: string): string {
  return projectPath.replace(/[/\\:.]/g, "-");
}

function makeWs(token: string | null = null): AgentTranscriptWsLike & { sent: any[]; sendOverride?: (data: string) => number } {
  const ws: AgentTranscriptWsLike & { sent: any[]; sendOverride?: (data: string) => number } = {
    data: { token },
    sent: [],
    send(data: string) {
      if (ws.sendOverride) return ws.sendOverride(data);
      ws.sent.push(JSON.parse(data));
      return data.length;
    },
  };
  return ws;
}

function noOpTimers(): void {
  agentTranscriptTimers.setInterval = () => "noop-handle";
  agentTranscriptTimers.clearInterval = () => {};
}

describe("agent transcript hub", () => {
  let claudeRoot: string;
  let fakeHome: string;
  let codexRoot: string;
  const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

  beforeEach(() => {
    _resetSourcesCache();
    _resetAgentTranscriptIndexCache();
    _resetAgentTranscriptHubForTest();
    _resetComputeRunningAgentsCallCountForTest();
    resetAgentTranscriptClockForTest();
    resetAgentTranscriptFsIoForTest();
    noOpTimers();

    claudeRoot = mkdtempSync(join(tmpdir(), "ppm-hub-claude-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ppm-hub-home-"));
    codexRoot = join(fakeHome, ".codex", "sessions");
    mkdirSync(codexRoot, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    _setClaudeProjectsRoot(claudeRoot);
    _setCodexSessionsDirsForTest(() => [codexRoot]);

    const projects = configService.get("projects").filter((p) => p.name !== PROJECT_A && p.name !== PROJECT_B);
    projects.push({ name: PROJECT_A, path: PROJECT_A_PATH }, { name: PROJECT_B, path: PROJECT_B_PATH });
    configService.set("projects", projects);

    const auth = (configService as any).config.auth;
    auth.enabled = false;
    auth.token = "";
  });

  afterEach(() => {
    // Restore real timers/clock/fs immediately — other test files share this
    // process and must never inherit a no-op `setInterval`.
    resetAgentTranscriptClockForTest();
    resetAgentTranscriptFsIoForTest();
    _resetAgentTranscriptHubForTest();
    const auth = (configService as any).config.auth;
    auth.enabled = false;
    auth.token = "";
    _setClaudeProjectsRoot(null);
    _setCodexSessionsDirsForTest(null);
    if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedEnv.USERPROFILE;
    if (savedEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.HOME;
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // ── Fixture helpers ──

  function writeClaudeSessionFile(projectPath: string, sessionId: string): string {
    const dir = join(claudeRoot, slugOf(projectPath));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
    return dir;
  }

  function assistantLine(text: string, toolUse?: { name: string; id: string; input?: unknown }): string {
    const content: unknown[] = [];
    if (toolUse) content.push({ type: "tool_use", name: toolUse.name, id: toolUse.id, input: toolUse.input ?? {} });
    if (text) content.push({ type: "text", text });
    return JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { content } }) + "\n";
  }

  function toolResultLine(toolUseId: string, output: string): string {
    return JSON.stringify({
      type: "user",
      uuid: crypto.randomUUID(),
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }] },
    }) + "\n";
  }

  /** A card with a root agent transcript holding one tool_use line. Returns the file path. */
  function writeCard(sessionDir: string, cardId: string, agentId = "agent1"): string {
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: cardId }));
    const file = join(subagentsDir, `agent-${agentId}.jsonl`);
    writeFileSync(file, assistantLine("", { name: "Bash", id: "tu1", input: { command: "ls" } }));
    return file;
  }

  /** A card with `count` tool_use lines in its root agent transcript — for
   *  pagination (H1) and reload-cap (H3) tests where one line is not enough. */
  function writeBigCard(sessionDir: string, cardId: string, agentId: string, count: number): string {
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: cardId }));
    const file = join(subagentsDir, `agent-${agentId}.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(assistantLine("", { name: "Bash", id: `tu${i}`, input: {} }));
    writeFileSync(file, lines.join(""));
    return file;
  }

  function ownClaude(sessionId = SESSION_ID, projectPath = PROJECT_A_PATH) {
    const sessionDir = join(writeClaudeSessionFile(projectPath, sessionId), sessionId);
    return sessionDir;
  }

  function subscribe(ws: AgentTranscriptWsLike, subId: string, cardId: string, opts?: { sessionId?: string; projectName?: string; cursor?: Record<string, number> }) {
    handleAgentTranscriptSubscribe(ws, {
      type: "agent-transcript:subscribe",
      subId,
      projectName: opts?.projectName ?? PROJECT_A,
      providerId: "claude",
      sessionId: opts?.sessionId ?? SESSION_ID,
      source: { kind: "card", cardId },
      cursor: opts?.cursor,
    });
  }

  function eventsMessages(ws: { sent: any[] }): AgentTranscriptEventsMsg[] {
    return ws.sent.filter((m) => m.type === "agent-transcript:events");
  }

  function errorMessages(ws: { sent: any[] }): AgentTranscriptErrorMsg[] {
    return ws.sent.filter((m) => m.type === "agent-transcript:error");
  }

  // ── Task 1: subscribe → catch-up → live append ──

  it("sends the existing content as catch-up, then a live-appended line on the next tick", () => {
    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();

    subscribe(ws, "s1", "toolu_card1");
    const first = eventsMessages(ws);
    expect(first).toHaveLength(1);
    expect(first[0]!.events).toHaveLength(1);
    expect(first[0]!.events[0]!.ev).toMatchObject({ type: "tool_use", tool: "Bash" });
    expect(first[0]!.reset).toBeUndefined();
    expect(first[0]!.running).toBe(true);

    appendFileSync(file, toolResultLine("tu1", "file list"));
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    tickTranscripts(hub);

    const after = eventsMessages(ws);
    expect(after).toHaveLength(2);
    expect(after[1]!.events).toHaveLength(1);
    expect(after[1]!.events[0]!.ev).toMatchObject({ type: "tool_result", output: "file list" });
    // De-dupe keys never repeat across pushes.
    const keys = after.flatMap((m) => m.events.map((e) => e.k));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a late second subscriber with an older cursor gets exactly its missing lines", () => {
    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const wsA = makeWs();
    subscribe(wsA, "a1", "toolu_card1");
    const cursorAfterFirstLine = eventsMessages(wsA)[0]!.cursor;

    appendFileSync(file, toolResultLine("tu1", "second line"));

    const wsB = makeWs();
    subscribe(wsB, "b1", "toolu_card1", { cursor: cursorAfterFirstLine });
    const bMsgs = eventsMessages(wsB);
    expect(bMsgs).toHaveLength(1);
    expect(bMsgs[0]!.events).toHaveLength(1);
    expect(bMsgs[0]!.events[0]!.ev).toMatchObject({ type: "tool_result" });
  });

  it("reconnecting with the last cursor resumes with no gap and no duplicate", () => {
    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const ws1 = makeWs();
    subscribe(ws1, "s1", "toolu_card1");
    const cursor1 = eventsMessages(ws1)[0]!.cursor;
    handleAgentTranscriptUnsubscribe(ws1, { type: "agent-transcript:unsubscribe", subId: "s1" });

    appendFileSync(file, toolResultLine("tu1", "after disconnect"));

    const ws2 = makeWs();
    subscribe(ws2, "s2", "toolu_card1", { cursor: cursor1 });
    const msgs = eventsMessages(ws2);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.events).toHaveLength(1);
    expect(msgs[0]!.events[0]!.ev).toMatchObject({ output: "after disconnect" });
  });

  it("ignores cursor keys the server never derived and clamps an offset past the file size", () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_card1", { cursor: { "unknown-key": 999, agent1: 999_999 } });
    // A bogus offset clamps down to 0-or-size rather than throwing or skipping the file.
    const msgs = eventsMessages(ws);
    expect(msgs).toHaveLength(1);
  });

  // ── Task 2: reset paths ──

  it("a truncated Claude file resets the subscription and replays the new content", () => {
    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_card1");
    expect(eventsMessages(ws)).toHaveLength(1);

    // Rewrite the file shorter than the tracked offset — a rotation/replace, not an append.
    writeFileSync(file, assistantLine("", { name: "Read", id: "tuX" }));
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    tickTranscripts(hub);

    const msgs = eventsMessages(ws);
    const resetMsg = msgs.find((m) => m.reset);
    expect(resetMsg).toBeDefined();
    expect(resetMsg!.events[0]!.ev).toMatchObject({ tool: "Read" });
  });

  function codexItemCompleted(id: string, output: string, ts: string): string {
    return JSON.stringify({
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", id, command: ["bash", "-lc", "echo hi"], exit_code: 0, aggregated_output: output },
      },
    }) + "\n";
  }

  function writeCodexSession(sessionId: string, projectPath: string): string {
    const day = join(codexRoot, "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-${sessionId}.jsonl`);
    const header = JSON.stringify({
      timestamp: "2026-10-01T00:00:00Z", type: "session_meta",
      payload: { id: sessionId, cwd: projectPath, cli_version: "0.159.2" },
    }) + "\n";
    writeFileSync(file, header + codexItemCompleted("call1", "first output", "2026-10-01T00:00:01Z"));
    return file;
  }

  /** A rollout with just its header (optionally chained to a parent), no items yet. */
  function writeCodexHeaderOnly(threadId: string, projectPath: string, parentThreadId?: string): string {
    const day = join(codexRoot, "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-${threadId}.jsonl`);
    const header = JSON.stringify({
      timestamp: "2026-10-01T00:00:00Z", type: "session_meta",
      payload: {
        id: threadId, cwd: projectPath, cli_version: "0.159.2",
        ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      },
    }) + "\n";
    writeFileSync(file, header);
    return file;
  }

  function subagentActivityLine(threadId: string, kind: "started" | "completed", ts: string): string {
    return JSON.stringify({
      timestamp: ts, type: "event_msg",
      payload: { type: "item_completed", item: { type: "SubAgentActivity", agent_thread_id: threadId, agent_path: "/child", kind } },
    }) + "\n";
  }

  it("a Codex child thread's compaction record resets its card subscription", () => {
    const ROOT = "77777777-1111-2222-3333-444444444444";
    const CHILD = "88888888-1111-2222-3333-444444444444";
    writeCodexSession(ROOT, PROJECT_A_PATH);
    const day = join(codexRoot, "2026", "10", "01");
    const childFile = join(day, `rollout-${CHILD}.jsonl`);
    const header = JSON.stringify({
      timestamp: "2026-10-01T00:00:00Z", type: "session_meta",
      payload: { id: CHILD, parent_thread_id: ROOT, cwd: PROJECT_A_PATH, cli_version: "0.159.2" },
    }) + "\n";
    writeFileSync(childFile, header + codexItemCompleted("call1", "child output", "2026-10-01T00:00:01Z"));

    const ws = makeWs();
    handleAgentTranscriptSubscribe(ws, {
      type: "agent-transcript:subscribe", subId: "s1", projectName: PROJECT_A,
      providerId: "codex", sessionId: ROOT, source: { kind: "card", cardId: `subagent-${CHILD}` },
    });
    expect(eventsMessages(ws)).toHaveLength(1);
    // One completed CommandExecution item maps to a tool_use + its tool_result together.
    expect(eventsMessages(ws)[0]!.events).toHaveLength(2);

    appendFileSync(childFile, JSON.stringify({
      timestamp: "2026-10-01T00:00:02Z", type: "compacted", payload: { message: "summarized" },
    }) + "\n");
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("codex", ROOT)!;
    tickTranscripts(hub);

    const resetMsg = eventsMessages(ws).find((m) => m.reset);
    expect(resetMsg).toBeDefined();
    expect(resetMsg!.events).toHaveLength(0);
  });

  // ── Task 3: ownership / limits / auth ──

  it("rejects a malformed card id as bad_request without touching disk", () => {
    ownClaude();
    const ws = makeWs();
    subscribe(ws, "s1", "../../etc/passwd");
    expect(errorMessages(ws)).toEqual([{ type: "agent-transcript:error", subId: "s1", code: "bad_request" }]);
  });

  it("rejects a well-formed but absent card as not_found", () => {
    ownClaude();
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_does_not_exist");
    expect(errorMessages(ws)).toEqual([{ type: "agent-transcript:error", subId: "s1", code: "not_found" }]);
  });

  it("rejects a session that does not belong to the requested project", () => {
    ownClaude(SESSION_ID, PROJECT_A_PATH); // session really lives under project A
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_card1", { projectName: PROJECT_B }); // but the client claims project B
    expect(errorMessages(ws)).toEqual([{ type: "agent-transcript:error", subId: "s1", code: "not_found" }]);
  });

  it("caps a client at 8 transcript subscriptions and rejects the 9th", () => {
    const sessionDir = ownClaude();
    for (let i = 0; i < 9; i++) writeCard(sessionDir, `toolu_card${i}`, `agent${i}`);
    const ws = makeWs();
    for (let i = 0; i < 8; i++) subscribe(ws, `s${i}`, `toolu_card${i}`);
    expect(errorMessages(ws)).toHaveLength(0);

    subscribe(ws, "s8", "toolu_card8");
    expect(errorMessages(ws)).toEqual([{ type: "agent-transcript:error", subId: "s8", code: "limit" }]);
  });

  it("reusing the same subId replaces the old subscription instead of adding a second", () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_card1", "agent1");
    writeCard(sessionDir, "toolu_card2", "agent2");
    const ws = makeWs();
    subscribe(ws, "same-id", "toolu_card1");
    subscribe(ws, "same-id", "toolu_card2");
    expect(_debugHubSnapshotForTest("claude", SESSION_ID).transcriptSubs).toBe(1);
    const last = eventsMessages(ws).at(-1)!;
    expect(last.events[0]!.ev).toMatchObject({ tool: "Bash" }); // both cards use the same fixture tool
  });

  it("drops the socket's subscriptions when the auth token changes mid-stream", () => {
    const auth = (configService as any).config.auth;
    auth.enabled = true;
    auth.token = "token-v1";

    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const ws = makeWs("token-v1");
    subscribe(ws, "s1", "toolu_card1");
    expect(eventsMessages(ws)).toHaveLength(1);

    auth.token = "token-v2"; // password/token rotated elsewhere
    appendFileSync(file, toolResultLine("tu1", "should not be seen"));
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    tickTranscripts(hub);

    expect(eventsMessages(ws)).toHaveLength(1); // no second push after the token drifted
    expect(_debugHubSnapshotForTest("claude", SESSION_ID).transcriptSubs).toBe(0);
  });

  it("drops the subscription when send() returns 0 (dropped, not backpressure)", () => {
    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_card1");
    expect(eventsMessages(ws)).toHaveLength(1);

    ws.sendOverride = () => 0;
    appendFileSync(file, toolResultLine("tu1", "dropped"));
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    tickTranscripts(hub);

    expect(_debugHubSnapshotForTest("claude", SESSION_ID).transcriptSubs).toBe(0);
  });

  it("closing the socket drops every subscription it held", () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_card1");
    expect(_debugHubSnapshotForTest("claude", SESSION_ID).transcriptSubs).toBe(1);
    handleAgentTranscriptClientClosed(ws);
    expect(_debugHubSnapshotForTest("claude", SESSION_ID).exists).toBe(false);
  });

  // ── Task 4: activity feed ──

  it("a transcript written 10s ago shows up as running", async () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();
    handleAgentActivitySubscribe(ws, {
      type: "agent-activity:subscribe", subId: "act1", projectName: PROJECT_A, providerId: "claude", sessionId: SESSION_ID,
    });
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    await tickActivity(hub);

    const last = ws.sent.filter((m) => m.type === "agent-activity").at(-1) as AgentActivityMsg;
    expect(last.running).toHaveLength(1);
    expect(last.running[0]!.cardId).toBe("toolu_card1");
  });

  it("a session with no recent transcript writes reports an empty running list", async () => {
    ownClaude(); // no card written at all — subagents dir does not exist
    const ws = makeWs();
    handleAgentActivitySubscribe(ws, {
      type: "agent-activity:subscribe", subId: "act1", projectName: PROJECT_A, providerId: "claude", sessionId: SESSION_ID,
    });
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    await tickActivity(hub);
    const last = ws.sent.filter((m) => m.type === "agent-activity").at(-1) as AgentActivityMsg;
    expect(last.running).toEqual([]);
  });

  // ── Task 5: cost checks ──

  it("index cache serves the same reference within 2s and refreshes after the window or a dir mtime change", () => {
    const sessionDir = ownClaude();
    const subagentsDir = join(sessionDir, "subagents");
    writeCard(sessionDir, "toolu_card1");

    const first = getCachedSubagentGroups(subagentsDir);
    const second = getCachedSubagentGroups(subagentsDir);
    expect(second).toBe(first); // same reference: no re-scan within the window

    agentTranscriptClock.now = () => Date.now() + 3000;
    const third = getCachedSubagentGroups(subagentsDir);
    expect(third).not.toBe(first);
  });

  it("stats each distinct subscribed file exactly once per tick and reads nothing when unchanged", () => {
    const sessionDir = ownClaude();
    for (let i = 0; i < 8; i++) writeCard(sessionDir, `toolu_card${i}`, `agent${i}`);
    const ws = makeWs();
    for (let i = 0; i < 8; i++) subscribe(ws, `s${i}`, `toolu_card${i}`);

    let statCalls = 0;
    let readCalls = 0;
    agentTranscriptFsIo.statSize = (p) => { statCalls++; return realAgentTranscriptFsIo.statSize(p); };
    agentTranscriptFsIo.readRange = (p, s, l) => { readCalls++; return realAgentTranscriptFsIo.readRange(p, s, l); };

    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    tickTranscripts(hub);

    expect(statCalls).toBe(8); // one per distinct file, nothing changed since subscribe
    expect(readCalls).toBe(0); // size === offset for every file: no read issued
  });

  // ── C1: cursor validation, never throws, never orphans ──

  it("C1: a fractional/NaN/negative/huge cursor offset neither throws nor orphans the subscription", () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_card1");

    for (const bad of [1.5, Number.NaN, -100, 1e21]) {
      const ws = makeWs();
      expect(() => subscribe(ws, "s1", "toolu_card1", { cursor: { agent1: bad } })).not.toThrow();
      expect(errorMessages(ws)).toHaveLength(0);
      // Fully registered, not orphaned: removable through the normal path,
      // and the hub goes away once that was the only subscription.
      expect(_debugHubSnapshotForTest("claude", SESSION_ID).transcriptSubs).toBe(1);
      handleAgentTranscriptUnsubscribe(ws, { type: "agent-transcript:unsubscribe", subId: "s1" });
      expect(_debugHubSnapshotForTest("claude", SESSION_ID).exists).toBe(false);
    }
  });

  it("C1: a throwing read during a live tick degrades instead of crashing the tick", () => {
    const sessionDir = ownClaude();
    const file = writeCard(sessionDir, "toolu_card1");
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_card1");
    expect(eventsMessages(ws)).toHaveLength(1);

    appendFileSync(file, toolResultLine("tu1", "boom"));
    agentTranscriptFsIo.readRange = () => {
      throw new Error("simulated EIO");
    };
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    expect(() => tickTranscripts(hub)).not.toThrow();
    // A locked/erroring read degrades to "nothing new this tick" — the
    // subscription itself is not dropped over it.
    expect(_debugHubSnapshotForTest("claude", SESSION_ID).transcriptSubs).toBe(1);
  });

  // ── H1: exact per-page cursor ──

  it("H1: a reconnect after only the first of several pages resumes at the next page, with no gap", () => {
    const sessionDir = ownClaude();
    writeBigCard(sessionDir, "toolu_big", "agentbig", 1200); // > 2 pages at 500/page
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_big");

    const pages = eventsMessages(ws);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.more).toBe(true);
    const totalDelivered = pages.reduce((n, p) => n + p.events.length, 0);
    expect(totalDelivered).toBe(1200);
    // The whole point of H1: not every page carries the SAME (final) cursor.
    expect(pages[0]!.cursor).not.toEqual(pages.at(-1)!.cursor);

    // Identify a step by its toolUseId rather than its de-dupe key `k` — a
    // resume starting from a non-zero offset legitimately mints fresh `k`s
    // for the very same lines (the key only has to be stable for repeated
    // reads from the SAME offset, not across two different ones).
    const idOf = (e: { ev: { toolUseId?: string } }) => e.ev.toolUseId!;
    const allIds = new Set(pages.flatMap((p) => p.events.map(idOf)));
    const page1Ids = new Set(pages[0]!.events.map(idOf));
    expect(page1Ids.size).toBeLessThan(allIds.size); // page 1 really is only part of the backlog

    // Simulate a drop right after page 1 landed: resubscribe with exactly
    // the cursor page 1 itself carried.
    const ws2 = makeWs();
    subscribe(ws2, "s2", "toolu_big", { cursor: pages[0]!.cursor });
    const resumedIds = new Set(eventsMessages(ws2).flatMap((p) => p.events.map(idOf)));

    // No gap: everything page 1 did not deliver shows up in the resumed stream.
    for (const id of allIds) {
      if (!page1Ids.has(id)) expect(resumedIds.has(id)).toBe(true);
    }
    // No duplicate: the resume cursor lands exactly where page 1 left off.
    for (const id of page1Ids) expect(resumedIds.has(id)).toBe(false);
  });

  // ── H2: dynamic file set ──

  it("H2 Claude: a nested agent transcript that appears after subscribe is streamed live", () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_parent", "agent1");
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_parent");
    expect(eventsMessages(ws)).toHaveLength(1);

    // A grandchild's transcript appears later, chaining back to agent1.
    _resetSourcesCache(); // bypass resolveSources' own wall-clock cache for the test
    const subagentsDir = join(sessionDir, "subagents");
    writeFileSync(join(subagentsDir, "agent-nested1.meta.json"), JSON.stringify({ parentAgentId: "agent1" }));
    writeFileSync(join(subagentsDir, "agent-nested1.jsonl"), assistantLine("", { name: "Read", id: "tuN" }));

    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    tickTranscripts(hub);

    const allEvents = eventsMessages(ws).flatMap((m) => m.events);
    expect(allEvents.some((e) => e.ev.type === "tool_use" && (e.ev as any).tool === "Read")).toBe(true);
  });

  it("H2 Codex: a grandchild thread linked after subscribe is streamed live, re-validated as a real descendant", () => {
    const ROOT = "77777777-1111-2222-3333-444444444444";
    const CHILD_A = "88888888-1111-2222-3333-444444444444";
    const GRANDCHILD_B = "99999999-1111-2222-3333-444444444444";
    writeCodexSession(ROOT, PROJECT_A_PATH);
    const childFile = writeCodexHeaderOnly(CHILD_A, PROJECT_A_PATH, ROOT);
    writeCodexHeaderOnly(GRANDCHILD_B, PROJECT_A_PATH, CHILD_A);
    const grandchildFile = join(codexRoot, "2026", "10", "01", `rollout-${GRANDCHILD_B}.jsonl`);
    appendFileSync(grandchildFile, codexItemCompleted("gc-call1", "grandchild output", "2026-10-01T00:00:01Z"));

    const ws = makeWs();
    handleAgentTranscriptSubscribe(ws, {
      type: "agent-transcript:subscribe", subId: "s1", projectName: PROJECT_A,
      providerId: "codex", sessionId: ROOT, source: { kind: "card", cardId: `subagent-${CHILD_A}` },
    });
    expect(errorMessages(ws)).toHaveLength(0);
    expect(eventsMessages(ws)[0]!.events).toHaveLength(0); // the child has no items of its own yet

    // The child's own rollout gains a link to the grandchild it spawned.
    appendFileSync(childFile, subagentActivityLine(GRANDCHILD_B, "started", "2026-10-01T00:00:02Z"));
    agentTranscriptClock.now = () => Date.now() + 1000;
    const hub = _getSessionHubForTest("codex", ROOT)!;
    tickTranscripts(hub);

    const allEvents = eventsMessages(ws).flatMap((m) => m.events);
    expect(allEvents.some((e) => e.ev.type === "tool_result" && (e.ev as any).output === "grandchild output")).toBe(true);
  });

  // ── H3: hub bypasses the merger's reload-payload event cap ──

  it("H3: a subscription streams more than 2000 events from a single agent file", () => {
    const sessionDir = ownClaude();
    writeBigCard(sessionDir, "toolu_huge", "agenthuge", 2500);
    const ws = makeWs();
    subscribe(ws, "s1", "toolu_huge");
    const totalDelivered = eventsMessages(ws).reduce((n, m) => n + m.events.length, 0);
    expect(totalDelivered).toBe(2500); // MAX_CHILDREN_PER_AGENT (2000) does not apply to the hub
  });

  // ── H5: activity subscription caps + compute-once-per-tick ──

  it("H5: caps a client at 8 activity subscriptions and rejects the 9th", () => {
    ownClaude();
    const ws = makeWs();
    for (let i = 0; i < 8; i++) {
      handleAgentActivitySubscribe(ws, {
        type: "agent-activity:subscribe", subId: `a${i}`, projectName: PROJECT_A, providerId: "claude", sessionId: SESSION_ID,
      });
    }
    expect(ws.sent.filter((m) => m.type === "agent-transcript:error")).toHaveLength(0);

    handleAgentActivitySubscribe(ws, {
      type: "agent-activity:subscribe", subId: "a8", projectName: PROJECT_A, providerId: "claude", sessionId: SESSION_ID,
    });
    expect(ws.sent.filter((m) => m.type === "agent-transcript:error")).toEqual([
      { type: "agent-transcript:error", subId: "a8", code: "limit" },
    ]);
    for (let i = 0; i < 8; i++) handleAgentActivityUnsubscribe(ws, { type: "agent-activity:unsubscribe", subId: `a${i}` });
  });

  it("H5: one tick computes the running list once and fans it out to every subscriber", async () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_card1");
    const ws1 = makeWs();
    const ws2 = makeWs();
    handleAgentActivitySubscribe(ws1, {
      type: "agent-activity:subscribe", subId: "a1", projectName: PROJECT_A, providerId: "claude", sessionId: SESSION_ID,
    });
    handleAgentActivitySubscribe(ws2, {
      type: "agent-activity:subscribe", subId: "a2", projectName: PROJECT_A, providerId: "claude", sessionId: SESSION_ID,
    });
    _resetComputeRunningAgentsCallCountForTest();

    const hub = _getSessionHubForTest("claude", SESSION_ID)!;
    await tickActivity(hub);

    expect(_computeRunningAgentsCallCountForTest()).toBe(1); // not once per subscriber
    const last1 = ws1.sent.filter((m) => m.type === "agent-activity").at(-1) as AgentActivityMsg;
    const last2 = ws2.sent.filter((m) => m.type === "agent-activity").at(-1) as AgentActivityMsg;
    expect(last1.running).toEqual(last2.running);
  });

  // ── M2: Codex running detection ages out an unfinished child too ──

  it("M2: an unfinished Codex child with no recent write ages out of the running list", async () => {
    const ROOT = "77777777-1111-2222-3333-444444444444";
    const CHILD = "88888888-1111-2222-3333-444444444444";
    const rootFile = writeCodexHeaderOnly(ROOT, PROJECT_A_PATH);
    appendFileSync(rootFile, subagentActivityLine(CHILD, "started", "2026-10-01T00:00:01Z"));
    writeCodexHeaderOnly(CHILD, PROJECT_A_PATH, ROOT); // never completes — no "completed" record ever written

    const ws = makeWs();
    handleAgentActivitySubscribe(ws, {
      type: "agent-activity:subscribe", subId: "a1", projectName: PROJECT_A, providerId: "codex", sessionId: ROOT,
    });
    const hub = _getSessionHubForTest("codex", ROOT)!;

    await tickActivity(hub);
    const fresh = ws.sent.filter((m) => m.type === "agent-activity").at(-1) as AgentActivityMsg;
    expect(fresh.running.some((r) => r.cardId === `subagent-${CHILD}`)).toBe(true);

    // Past the 90s activity window with no further writes — still not "done".
    agentTranscriptClock.now = () => Date.now() + 200_000;
    await tickActivity(hub);
    const stale = ws.sent.filter((m) => m.type === "agent-activity").at(-1) as AgentActivityMsg;
    expect(stale.running.some((r) => r.cardId === `subagent-${CHILD}`)).toBe(false);
  });

  // ── M4: liveness seeded from file mtime, not subscribe time ──

  it("M4: a card whose file was last written long ago shows not-running immediately on subscribe", () => {
    const sessionDir = ownClaude();
    writeCard(sessionDir, "toolu_old");
    agentTranscriptFsIo.statMtimeMs = () => Date.now() - 5 * 60_000;

    const ws = makeWs();
    subscribe(ws, "s1", "toolu_old");
    expect(eventsMessages(ws)[0]!.running).toBe(false);
  });
});
