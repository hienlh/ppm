/**
 * Low-level tests for the per-file read/parse state shared by catch-up and
 * the live tick: the crash (a non-integer/locked read reaching `readSync`
 * and throwing past the hub), the replace-key reuse contract, and the
 * per-tick read budget. These exercise `processFileTail` directly against a
 * real file on disk — no hub, no WebSocket, no mocked fs seam — so each is a
 * minimal reproduction of exactly the bug it guards against.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTailState } from "../../../src/services/agent-transcript/agent-transcript-file-tail-state.ts";
import { processFileTail } from "../../../src/services/agent-transcript/agent-transcript-file-tail-feed.ts";
import type { TranscriptFileRef } from "../../../src/services/agent-transcript/agent-transcript-sources.ts";
import type { AgentTranscriptEventsMsg } from "../../../src/shared/agent-transcript-protocol.ts";
// Read-only import of the CLIENT's own merge reducer — the whole point is
// that the server's `k`/`replace` choices must produce the right result once
// they reach this exact function, not just look right in isolation.
import { applyEnvelopeBatch } from "../../../src/web/lib/agent-session-stream-merge.ts";

describe("agent transcript file tail state", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function claudeAssistantLine(text: string, toolUse?: { name: string; id: string }): string {
    const content: unknown[] = [];
    if (toolUse) content.push({ type: "tool_use", name: toolUse.name, id: toolUse.id, input: {} });
    if (text) content.push({ type: "text", text });
    return JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { content } }) + "\n";
  }

  function codexHeader(): string {
    return JSON.stringify({
      timestamp: "2026-10-01T00:00:00Z", type: "session_meta",
      payload: { id: "root-session", cwd: "/workspace/p", cli_version: "0.159.2" },
    }) + "\n";
  }

  function codexItemCompleted(id: string, output: string, ts: string): string {
    return JSON.stringify({
      timestamp: ts, type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", id, command: ["bash", "-lc", "echo hi"], exit_code: 0, aggregated_output: output },
      },
    }) + "\n";
  }

  // probe: a fractional (or otherwise non-safe-integer) starting offset
  // used to reach the real `fs.readSync` and throw `ERR_OUT_OF_RANGE`
  // ("position ... must be an integer"). `processFileTail` must never let
  // that (or any other read failure) escape.
  it("a fractional fstate.offset does not throw through a real disk read", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "agent-x.jsonl");
    writeFileSync(file, claudeAssistantLine("", { name: "Bash", id: "tu1" }));
    const ref: TranscriptFileRef = { key: "agent-x", path: file, provider: "claude" };

    const fstate = createFileTailState(ref, 0, Date.now());
    fstate.offset = 1.5; // bypass the hub's own sanitization on purpose — this is the probe

    expect(() => processFileTail(fstate, Date.now())).not.toThrow();
    // Degrades to "nothing new this tick" rather than reading anything.
    const result = processFileTail(fstate, Date.now());
    expect(result.envelopes).toEqual([]);
  });

  it("a read against a vanished file degrades instead of throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "gone.jsonl");
    writeFileSync(file, claudeAssistantLine("", { name: "Bash", id: "tu1" }));
    const ref: TranscriptFileRef = { key: "agent-gone", path: file, provider: "claude" };
    const fstate = createFileTailState(ref, 0, Date.now());
    rmSync(file);

    expect(() => processFileTail(fstate, Date.now())).not.toThrow();
    expect(processFileTail(fstate, Date.now()).envelopes).toEqual([]);
  });

  // a `CommandExecution` item emits a `tool_use` AND a `tool_result`
  // SHARING the same toolUseId. The tail parser flags the second one
  // `replace` purely because it has seen that id before (it does not track
  // which TYPE saw it) — reusing the key by id alone made the tool_result
  // overwrite the tool_use in place and the step disappeared client-side
  //. The fix keys the replacement map by `${type}:${toolUseId}`, so a
  // tool_result never reuses a tool_use's key: each keeps its own, distinct.
  it("a CommandExecution's tool_use and tool_result get distinct keys, neither replacing the other", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "rollout-x.jsonl");
    writeFileSync(file, codexHeader() + codexItemCompleted("call1", "output", "2026-10-01T00:00:01Z"));
    const ref: TranscriptFileRef = { key: "root-session", path: file, provider: "codex" };
    const fstate = createFileTailState(ref, 0, Date.now());

    const result = processFileTail(fstate, Date.now());
    expect(result.envelopes).toHaveLength(2);
    const [toolUse, toolResult] = result.envelopes;
    expect(toolUse!.ev.type).toBe("tool_use");
    expect(toolResult!.ev.type).toBe("tool_result");
    expect(toolUse!.k).not.toBe(toolResult!.k);
    // Neither is a "replace" — there is nothing of the SAME type to replace yet.
    expect(toolUse!.replace).toBeUndefined();
    expect(toolResult!.replace).toBeUndefined();
  });

  // a genuine re-emit (a second record naming the SAME tool call id)
  // replaces only the entry of the SAME type: the second tool_use reuses the
  // first tool_use's key, the second tool_result reuses the first
  // tool_result's key, and the two families never cross.
  it("a replayed tool_use for the same id replaces only the tool_use, not the tool_result", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "rollout-x.jsonl");
    writeFileSync(
      file,
      codexHeader()
        + codexItemCompleted("call1", "first output", "2026-10-01T00:00:01Z")
        + codexItemCompleted("call1", "updated output", "2026-10-01T00:00:02Z"),
    );
    const ref: TranscriptFileRef = { key: "root-session", path: file, provider: "codex" };
    const fstate = createFileTailState(ref, 0, Date.now());

    const result = processFileTail(fstate, Date.now());
    expect(result.envelopes).toHaveLength(4);
    const [toolUse1, toolResult1, toolUse2, toolResult2] = result.envelopes;
    expect(toolUse2!.replace).toBe(true);
    expect(toolResult2!.replace).toBe(true);
    expect(toolUse2!.k).toBe(toolUse1!.k); // the SECOND tool_use replaces the FIRST tool_use
    expect(toolResult2!.k).toBe(toolResult1!.k); // likewise for the tool_results
    expect(toolUse1!.k).not.toBe(toolResult1!.k); // the two families never cross
  });

  // End to end: the server's envelopes fed through the CLIENT's own
  // merge reducer must leave both a tool_use and a tool_result behind, not
  // one silently overwriting the other.
  it("end to end: applyEnvelopeBatch keeps both the tool_use and tool_result entries", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "rollout-x.jsonl");
    writeFileSync(file, codexHeader() + codexItemCompleted("call1", "output", "2026-10-01T00:00:01Z"));
    const ref: TranscriptFileRef = { key: "root-session", path: file, provider: "codex" };
    const fstate = createFileTailState(ref, 0, Date.now());
    const result = processFileTail(fstate, Date.now());

    const msg: AgentTranscriptEventsMsg = {
      type: "agent-transcript:events", subId: "s1", events: result.envelopes,
      cursor: {}, available: true, running: true,
    };
    const entries = applyEnvelopeBatch([], msg);
    expect(entries.map((e) => e.ev.type).sort()).toEqual(["tool_result", "tool_use"]);
  });

  // a single tick must not read an unbounded amount of a file: a large
  // backlog is spread across more than one call, each a plain continuation
  // rather than a fresh read of everything still outstanding.
  it("one tick reads at most a bounded budget, the rest completes on the next", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "agent-big.jsonl");
    // ~30 bytes/line x 40,000 lines ≈ 1.2MB, comfortably over the 512KB budget.
    const lines: string[] = [];
    for (let i = 0; i < 40_000; i++) lines.push(claudeAssistantLine(`line ${i}`));
    writeFileSync(file, lines.join(""));
    const ref: TranscriptFileRef = { key: "agent-big", path: file, provider: "claude" };
    const fstate = createFileTailState(ref, 0, Date.now());

    const first = processFileTail(fstate, Date.now());
    expect(first.envelopes.length).toBeGreaterThan(0);
    const offsetAfterFirst = fstate.offset;
    const fileSize = Buffer.byteLength(lines.join(""));
    expect(offsetAfterFirst).toBeLessThan(fileSize); // did not drain the whole file in one call

    // Keep ticking until fully drained; every subsequent call is a plain
    // continuation (never another reset) and eventually reaches the end.
    let guard = 0;
    while (fstate.offset < fileSize && guard < 20) {
      processFileTail(fstate, Date.now());
      guard++;
    }
    expect(fstate.offset).toBe(fileSize);
    expect(guard).toBeGreaterThan(0);
  });
});
