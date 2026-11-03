import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { newClaudeScanState, scanClaudeTranscript, claudeTurnView } from "../../../src/services/session-turns/turn-index-claude.ts";
import { listSessionTurns, resolveTurnOf, uuidTurnMap } from "../../../src/services/session-turns/session-turn-index.service.ts";
import { readSessionTurnMessages } from "../../../src/services/session-turns/session-turn-reader.ts";
import { loadTurnLookup, stampClaudeMessages } from "../../../src/services/session-turns/stamp-message-turns.ts";
import { SessionTurnError } from "../../../src/services/session-turns/session-turn-types.ts";
import { setSessionMigratedTo } from "../../../src/services/db.service.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";
import { claude, lines } from "./session-turn-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-turns-claude-"));
const projectPath = join(root, "proj");
const slugDir = join(root, "projects", projectPath.replace(/[/\\:.]/g, "-"));

const P1 = "11111111-0000-4000-8000-000000000001";
const P2 = "11111111-0000-4000-8000-000000000002";
const P3 = "11111111-0000-4000-8000-000000000003";
const ids = { u1: randomUUID(), a1: randomUUID(), tr: randomUUID(), note: randomUUID(), u2: randomUUID(), a2: randomUUID(),
  sum: randomUUID(), a3: randomUUID(), cmd: randomUUID(), out: randomUUID(), u4: randomUUID(), a4: randomUUID() };

/**
 * Turn 1 asks, a tool runs, and a task notification lands stamped with the NEXT prompt's id.
 * Turn 2 is compacted mid-way. Turn 3 is a CLI-local `/login` with no promptId. Turn 4 reuses
 * turn 2's promptId, which must not collide.
 */
const transcript = lines(
  claude.attachment(),
  claude.prompt("first ask", P1, ids.u1),
  // A tool input is a raw object in the record, so these keys appear unescaped in the line.
  claude.assistant("on it", ids.a1, { type: "user", nested: { type: "assistant", uuid: "not-a-uuid" } }),
  claude.toolResult(P1, ids.tr),
  claude.taskNotification(P2, ids.note),
  claude.metaContinue(P2),
  claude.prompt("second ask\nwith detail", P2, ids.u2),
  claude.assistant("working", ids.a2),
  claude.compactBoundary(),
  claude.compactSummary(P2, ids.sum),
  claude.assistant("done after compaction", ids.a3),
  claude.localCommand("/login", ids.cmd),
  claude.localStdout(ids.out),
  claude.prompt("fourth ask", P2, ids.u4),
  claude.assistant("final", ids.a4),
);

function sessionFile(id: string, body = transcript): string {
  const file = join(slugDir, `${id}.jsonl`);
  writeFileSync(file, body);
  return file;
}

beforeAll(() => {
  mkdirSync(slugDir, { recursive: true });
  _setClaudeProjectsRoot(join(root, "projects"));
});
afterAll(() => {
  _setClaudeProjectsRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("Claude turn scan", () => {
  test("a turn starts only at a real prompt and takes that record's promptId", async () => {
    const state = newClaudeScanState();
    await scanClaudeTranscript(sessionFile(randomUUID()), state, 0);
    const view = claudeTurnView(state);
    expect(view.turns.map((t) => [t.turnId, t.prompt])).toEqual([
      [P1, "first ask"],
      [P2, "second ask"],
      [`u:${ids.cmd}`, "/login"],
      [`u:${ids.u4}`, "fourth ask"],
    ]);
  });

  test("every other record belongs to the newest prompt by position, not by its own promptId", async () => {
    const state = newClaudeScanState();
    await scanClaudeTranscript(sessionFile(randomUUID()), state, 0);
    const view = claudeTurnView(state);
    expect(view.stampOf(ids.note)).toEqual({ turnId: P1, n: 1 });
    expect(view.stampOf(ids.a1)).toEqual({ turnId: P1, n: 1 });
    expect(view.stampOf(ids.tr)).toEqual({ turnId: P1, n: 1 });
    expect(view.stampOf(ids.sum)).toEqual({ turnId: P2, n: 2 });
    expect(view.stampOf(ids.a3)).toEqual({ turnId: P2, n: 2 });
    expect(view.stampOf(ids.out)).toEqual({ turnId: `u:${ids.cmd}`, n: 3 });
    expect(view.turns[1]!.compacted).toBe(true);
  });

  test("an assistant record's uuid is read from the line's tail, not from a tool input quoting one", async () => {
    const state = newClaudeScanState();
    await scanClaudeTranscript(sessionFile(randomUUID()), state, 0);
    expect(state.turnOfUuid.has("not-a-uuid")).toBe(false);
    expect(state.turnOfUuid.get(ids.a1)).toBe(0);
  });

  test("resuming after an append gives the scan a full read would, and a half-written line waits", async () => {
    const file = sessionFile(randomUUID(), "");
    const all = transcript.split("\n").filter(Boolean);
    const half = all.slice(0, 7).map((l) => `${l}\n`).join("");
    writeFileSync(file, half + all[7]!.slice(0, 40));
    const state = newClaudeScanState();
    const offset = await scanClaudeTranscript(file, state, 0);
    expect(offset).toBe(Buffer.byteLength(half));
    appendFileSync(file, `${all[7]!.slice(40)}\n${all.slice(8).map((l) => `${l}\n`).join("")}`);
    await scanClaudeTranscript(file, state, offset);
    const fresh = newClaudeScanState();
    await scanClaudeTranscript(file, fresh, 0);
    expect(claudeTurnView(state).turns).toEqual(claudeTurnView(fresh).turns);
    expect([...state.turnOfUuid]).toEqual([...fresh.turnOfUuid]);
  });
});

describe("Claude turn index service", () => {
  test("lists turns with absolute numbers and resolves a message's turn", async () => {
    const id = randomUUID();
    sessionFile(id);
    const { turns, sessionId } = await listSessionTurns({ providerId: "claude", sessionId: id, projectPath });
    expect(sessionId).toBe(id);
    expect(turns.map((t) => [t.n, t.turnId, t.status])).toEqual([
      [1, P1, "complete"], [2, P2, "complete"], [3, `u:${ids.cmd}`, "complete"], [4, `u:${ids.u4}`, "complete"],
    ]);
    expect(await resolveTurnOf({ providerId: "claude", sessionId: id, projectPath }, { messageUuid: ids.a2 })).toEqual({ turnId: P2, n: 2 });
    expect((await uuidTurnMap({ providerId: "claude", sessionId: id, projectPath })).get(ids.a4)).toEqual({ turnId: `u:${ids.u4}`, n: 4 });
  });

  test("another project, a malformed id or a missing transcript is refused", async () => {
    const id = randomUUID();
    sessionFile(id);
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: SessionTurnError) => e.code);
    expect(await code(listSessionTurns({ providerId: "claude", sessionId: id, projectPath: join(root, "other") }))).toBe("session_missing");
    expect(await code(listSessionTurns({ providerId: "claude", sessionId: "../x", projectPath }))).toBe("invalid");
    expect(await code(listSessionTurns({ providerId: "claude", sessionId: randomUUID(), projectPath }))).toBe("session_missing");
    expect(await code(listSessionTurns({ providerId: "gemini", sessionId: id, projectPath }))).toBe("invalid");
  });

  test("a migrated id is followed to the session that owns the transcript", async () => {
    const id = randomUUID();
    const old = randomUUID();
    sessionFile(id);
    setSessionMigratedTo(old, id);
    const result = await listSessionTurns({ providerId: "claude", sessionId: old, projectPath });
    expect(result.sessionId).toBe(id);
    expect(result.turns).toHaveLength(4);
  });

  test("a turn read holds that turn's messages, its compaction as one marker", async () => {
    const id = randomUUID();
    sessionFile(id);
    const [read] = await readSessionTurnMessages({ providerId: "claude", sessionId: id, projectPath }, [P2]);
    expect(read!.turn.n).toBe(2);
    expect(read!.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "second ask\nwith detail"],
      ["assistant", "working"],
      ["system", "(context compacted here)"],
      ["assistant", "done after compaction"],
    ]);
    expect(read!.messages.filter((m) => !m.synthetic).every((m) => m.turnId === P2 && m.turnN === 2)).toBe(true);
    const missing = await readSessionTurnMessages({ providerId: "claude", sessionId: id, projectPath }, [P3]).catch((e) => e.code);
    expect(missing).toBe("not_found");
  });
});

describe("stampClaudeMessages", () => {
  test("stamps by record uuid, and a message the index does not know takes the turn before it", () => {
    const lookup = (uuid: string) => ({ [ids.u1]: { turnId: P1, n: 1 }, [ids.u2]: { turnId: P2, n: 2 } } as Record<string, { turnId: string; n: number }>)[uuid];
    const msg = (sdkUuid?: string): ChatMessage => ({ id: sdkUuid ?? "x", role: "assistant", content: "", timestamp: "", ...(sdkUuid ? { sdkUuid } : {}) });
    const messages = [msg("before-any-turn"), msg(ids.u1), msg("unknown"), msg(ids.u2), msg()];
    stampClaudeMessages(messages, lookup);
    expect(messages.map((m) => m.turnN ?? null)).toEqual([null, 1, 1, 2, 2]);
  });

  test("a prompt the index has not seen yet, and what follows it, are left unstamped", () => {
    // The history read the new prompt; the index was scanned before it was written.
    const lookup = (uuid: string) => (uuid === ids.u1 ? { turnId: P1, n: 1 } : undefined);
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "first ask", timestamp: "", sdkUuid: ids.u1 },
      { id: "2", role: "assistant", content: "on it", timestamp: "", sdkUuid: "a-unknown" },
      { id: "3", role: "user", content: "a new question", timestamp: "", sdkUuid: "u-unknown" },
      { id: "4", role: "assistant", content: "its answer", timestamp: "", sdkUuid: "b-unknown" },
    ];
    stampClaudeMessages(messages, lookup);
    expect(messages.map((m) => m.turnId ?? null)).toEqual([P1, P1, null, null]);
  });
});

describe("loadTurnLookup", () => {
  test("a session this project does not own is a standing answer; an unreadable transcript is a failure", async () => {
    const owned = randomUUID();
    sessionFile(owned);
    expect((await loadTurnLookup({ providerId: "claude", sessionId: owned, projectPath })).lookup?.(ids.a2)).toEqual({ turnId: P2, n: 2 });

    const elsewhere = await loadTurnLookup({ providerId: "claude", sessionId: owned, projectPath: join(root, "other") });
    expect(elsewhere).toEqual({ failed: false });

    // A transcript path that exists but cannot be read as a file.
    const broken = randomUUID();
    mkdirSync(join(slugDir, `${broken}.jsonl`));
    expect(await loadTurnLookup({ providerId: "claude", sessionId: broken, projectPath })).toEqual({ failed: true });
  });
});

describe("message count", () => {
  test("one reply written as several block records counts once, a tool result not at all", async () => {
    const reply = (uuid: string, text: string) => claude.assistant(text, uuid).replace(/"id":"msg_[^"]+"/, '"id":"msg_shared01"');
    const state = newClaudeScanState();
    const file = sessionFile(randomUUID(), lines(
      claude.prompt("ask", P1),
      reply(randomUUID(), "thinking"),
      reply(randomUUID(), "text"),
      claude.toolResult(P1),
      claude.assistant("a second reply"),
    ));
    await scanClaudeTranscript(file, state, 0);
    expect(state.turns[0]!.messageCount).toBe(3);
  });
});

describe("scan cost", () => {
  test("a large transcript never holds the event loop for 50 ms", async () => {
    const body: string[] = [];
    // ~40 MB: assistant records are skimmed, user records (a big tool output each turn) parsed.
    const big = "x".repeat(200_000);
    const output = "y".repeat(400_000);
    for (let i = 0; i < 60; i++) {
      body.push(claude.prompt(`ask ${i}`, randomUUID()));
      for (let j = 0; j < 20; j++) body.push(claude.assistant(j === 0 ? big : "step"));
      body.push(claude.toolResult(randomUUID(), randomUUID(), output));
    }
    const file = sessionFile(randomUUID(), lines(...body));
    let maxGap = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    const state = newClaudeScanState();
    await scanClaudeTranscript(file, state, 0);
    clearInterval(probe);
    expect(state.turns).toHaveLength(60);
    expect(maxGap).toBeLessThan(50);
  }, 30_000);
});
