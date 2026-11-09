import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _setCodexSessionsDirsForTest } from "../../../src/services/agent-transcript/session-ownership.ts";
import { codexTurnView, newCodexScanState, scanCodexRollout } from "../../../src/services/session-turns/turn-index-codex.ts";
import { listSessionTurns, setTurnRunningProbe } from "../../../src/services/session-turns/session-turn-index.service.ts";
import { readSessionTurnMessages } from "../../../src/services/session-turns/session-turn-reader.ts";
import { stampCodexMessages } from "../../../src/services/session-turns/stamp-message-turns.ts";
import { parseRolloutJsonl } from "../../../src/providers/codex-app-server/codex-history.ts";
import { implicitTurnId } from "../../../src/providers/codex-app-server/codex-turn-tracker.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";
import { codex, lines } from "./session-turn-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-turns-codex-"));
const sessionsDir = join(root, "sessions");
const cwd = join(root, "proj");
const T = (n: number) => `019ee344-0000-7000-8000-00000000000${n}`;

/**
 * T2 holds a steered message; T3 compacts mid-turn; T4 is rolled back; T6 is a manual `/compact`
 * (no prompt), which belongs to T5; T7 is still running.
 */
function richRecords(id: string): string[] {
  return [
    codex.meta(id, cwd),
    codex.taskStarted(T(1)), codex.user("one"), codex.call("shell"), codex.agent("answer one"), codex.taskComplete(T(1)),
    codex.taskStarted(T(2)), codex.user("two"), codex.agent("partial"), codex.user("steer two"), codex.agent("answer two"), codex.taskComplete(T(2)),
    codex.taskStarted(T(3)), codex.user("three"), codex.compacted([{ role: "user", text: "one" }, { role: "assistant", text: "answer one" }]),
    codex.agent("answer three"), codex.taskComplete(T(3)),
    codex.taskStarted(T(4)), codex.user("four"), codex.agent("answer four"), codex.taskComplete(T(4)),
    codex.rolledBack(1),
    codex.taskStarted(T(5)), codex.user("five"), codex.agent("answer five"), codex.taskComplete(T(5)),
    codex.taskStarted(T(6)), codex.compacted([{ role: "user", text: "five" }]), codex.taskComplete(T(6)),
    codex.taskStarted(T(7)), codex.user("seven"), codex.tokenCount(),
  ];
}

const richRollout = (id: string): string => lines(...richRecords(id));

function writeRollout(id: string, body: string): string {
  const dir = join(sessionsDir, "2026", "11", "03");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-11-03T00-00-00-${id}.jsonl`);
  writeFileSync(file, body);
  return file;
}

async function viewOf(file: string) {
  const state = newCodexScanState();
  await scanCodexRollout(file, state, 0);
  return codexTurnView(state);
}

const distinct = (messages: ChatMessage[]) => [...new Set(messages.filter((m) => !m.synthetic && m.turnId).map((m) => m.turnId))];

// A rollout is only trusted inside a Codex sessions root, which `CODEX_HOME` names.
const savedCodexHome = process.env.CODEX_HOME;
beforeAll(() => {
  process.env.CODEX_HOME = root;
  _setCodexSessionsDirsForTest(() => [sessionsDir]);
});
afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  _setCodexSessionsDirsForTest(null);
  rmSync(root, { recursive: true, force: true });
});

describe("Codex turn scan", () => {
  test("turns are prompts; a steer stays in its turn, a rolled-back turn is gone, a /compact turn joins the one before", async () => {
    const view = await viewOf(writeRollout(randomUUID(), richRollout("x")));
    expect(view.turns.map((t) => [t.turnId, t.prompt])).toEqual([[T(1), "one"], [T(2), "two"], [T(3), "three"], [T(5), "five"], [T(7), "seven"]]);
    expect(view.turns[1]!.messageCount).toBe(4);
    expect(view.turns[3]!.ranges).toHaveLength(2);
    expect(view.turns[3]!.compacted).toBe(true);
    expect(view.stampOf(T(6))).toEqual({ turnId: T(5), n: 4 });
    expect(view.isRolledBack(T(4))).toBe(true);
    expect(view.turns[4]!.closed).toBe(false);
  });

  test("the index and the full history parse give the same turns", async () => {
    const body = richRollout("x");
    const view = await viewOf(writeRollout(randomUUID(), body));
    const full = parseRolloutJsonl(body, { full: true });
    stampCodexMessages(full, view.stampOf);
    expect(distinct(full)).toEqual(view.turns.map((t) => t.turnId));
    expect(full.find((m) => m.content === "steer two")!.turnN).toBe(2);
    expect(full.some((m) => m.content === "four")).toBe(false);
  });

  test("the resumable view starts over at the last compaction, its copies synthetic and in no turn", async () => {
    const body = richRollout("x");
    const view = await viewOf(writeRollout(randomUUID(), body));
    const history = parseRolloutJsonl(body);
    stampCodexMessages(history, view.stampOf);
    const copies = history.filter((m) => m.synthetic);
    expect(copies.map((m) => m.content)).toEqual(["five"]);
    expect(copies.every((m) => m.turnId === undefined)).toBe(true);
    // T6's compaction is the last one: only T7 is said after it.
    expect(distinct(history)).toEqual([T(7)]);
    expect(history.find((m) => m.content === "seven")!.turnN).toBe(5);
  });

  test("a rollback after a steered turn removes the whole turn, not one user message", async () => {
    const body = lines(
      codex.meta("x", cwd),
      codex.taskStarted(T(1)), codex.user("one"), codex.agent("a1"), codex.taskComplete(T(1)),
      codex.taskStarted(T(2)), codex.user("two"), codex.user("steer"), codex.agent("a2"), codex.taskComplete(T(2)),
      codex.rolledBack(1),
    );
    const history = parseRolloutJsonl(body);
    expect(history.map((m) => m.content)).toEqual(["one", "a1"]);
    const view = await viewOf(writeRollout(randomUUID(), body));
    expect(view.turns.map((t) => t.turnId)).toEqual([T(1)]);
  });

  test("a rollout written before codex named turns gets implicit turns both readers agree on", async () => {
    const body = lines(codex.meta("x", cwd), codex.user("old one"), codex.agent("a1"), codex.user("old two"), codex.agent("a2"));
    const view = await viewOf(writeRollout(randomUUID(), body));
    expect(view.turns.map((t) => t.turnId)).toEqual([implicitTurnId(1), implicitTurnId(3)]);
    const history = parseRolloutJsonl(body);
    stampCodexMessages(history, view.stampOf);
    expect(history.map((m) => m.turnN)).toEqual([1, 1, 2, 2]);
  });

  test("newer rollouts that only write item events are read the same way", async () => {
    const body = lines(codex.meta("x", cwd),
      codex.taskStarted(T(1)), codex.itemUser("one", T(1)), codex.itemAgent("a1", T(1)), codex.taskComplete(T(1)),
      codex.taskStarted(T(2)), codex.itemUser("two", T(2)), codex.itemAgent("a2", T(2)), codex.taskComplete(T(2)));
    const view = await viewOf(writeRollout(randomUUID(), body));
    expect(view.turns.map((t) => [t.turnId, t.prompt])).toEqual([[T(1), "one"], [T(2), "two"]]);
    expect(distinct(parseRolloutJsonl(body))).toEqual([T(1), T(2)]);
  });

  test("resuming after an append matches a full scan", async () => {
    const records = richRecords("x");
    const body = lines(...records);
    const file = writeRollout(randomUUID(), lines(...records.slice(0, 20)));
    const state = newCodexScanState();
    const offset = await scanCodexRollout(file, state, 0);
    writeFileSync(file, body);
    await scanCodexRollout(file, state, offset);
    expect(codexTurnView(state).turns).toEqual((await viewOf(file)).turns);
  });
});

describe("Codex turn index service", () => {
  test("lists the turns of an owned rollout; the newest is running while a turn is in flight", async () => {
    const id = randomUUID();
    writeRollout(id, richRollout(id));
    const previous = setTurnRunningProbe((sid) => sid === id);
    const { turns } = await listSessionTurns({ providerId: "codex", sessionId: id, projectPath: cwd }).finally(() => setTurnRunningProbe(previous));
    expect(turns.map((t) => [t.n, t.turnId, t.status])).toEqual([
      [1, T(1), "complete"], [2, T(2), "complete"], [3, T(3), "complete"], [4, T(5), "complete"], [5, T(7), "running"],
    ]);
    const other = await listSessionTurns({ providerId: "codex", sessionId: id, projectPath: join(root, "elsewhere") }).catch((e) => e.code);
    expect(other).toBe("session_missing");
  });

  test("reads a turn with its prompt-less /compact turn as one marker; a rolled-back turn says so", async () => {
    const id = randomUUID();
    const file = writeRollout(id, richRollout(id));
    expect(readFileSync(file, "utf8")).toContain(T(6));
    const [read] = await readSessionTurnMessages({ providerId: "codex", sessionId: id, projectPath: cwd }, [T(5)]);
    expect(read!.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "five"], ["assistant", "answer five"], ["system", "(context compacted here)"],
    ]);
    const steered = await readSessionTurnMessages({ providerId: "codex", sessionId: id, projectPath: cwd }, [T(2)]);
    expect(steered[0]!.messages.map((m) => m.content)).toEqual(["two", "partial", "steer two", "answer two"]);
    const gone = await readSessionTurnMessages({ providerId: "codex", sessionId: id, projectPath: cwd }, [T(4)]).catch((e) => e.code);
    expect(gone).toBe("rolled_back");
  });
});
