/**
 * Low-level tests for the per-file read/parse state shared by catch-up and
 * the live tick: the C1 crash (a non-integer/locked read reaching `readSync`
 * and throwing past the hub), the M1 replace-key reuse contract, and the H6
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

  // C1 — probe: a fractional (or otherwise non-safe-integer) starting offset
  // used to reach the real `fs.readSync` and throw `ERR_OUT_OF_RANGE`
  // ("position ... must be an integer"). `processFileTail` must never let
  // that (or any other read failure) escape.
  it("C1 probe: a fractional fstate.offset does not throw through a real disk read", () => {
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

  it("C1 probe: a read against a vanished file degrades instead of throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "gone.jsonl");
    writeFileSync(file, claudeAssistantLine("", { name: "Bash", id: "tu1" }));
    const ref: TranscriptFileRef = { key: "agent-gone", path: file, provider: "claude" };
    const fstate = createFileTailState(ref, 0, Date.now());
    rmSync(file);

    expect(() => processFileTail(fstate, Date.now())).not.toThrow();
    expect(processFileTail(fstate, Date.now()).envelopes).toEqual([]);
  });

  // M1 — a Codex tool_result answering an earlier tool_use reuses that
  // tool_use's original `k` rather than minting a new, unmatchable one.
  it("M1: a Codex replace envelope reuses the original envelope's key", () => {
    dir = mkdtempSync(join(tmpdir(), "ppm-tail-state-"));
    const file = join(dir, "rollout-x.jsonl");
    // One line so the tool_use and tool_result are produced in the SAME
    // read, which is exactly where a freshly-minted key would differ most
    // obviously from the original.
    writeFileSync(file, codexHeader() + codexItemCompleted("call1", "output", "2026-10-01T00:00:01Z"));
    const ref: TranscriptFileRef = { key: "root-session", path: file, provider: "codex" };
    const fstate = createFileTailState(ref, 0, Date.now());

    const result = processFileTail(fstate, Date.now());
    expect(result.envelopes).toHaveLength(2);
    const [toolUse, toolResult] = result.envelopes;
    expect(toolUse!.ev.type).toBe("tool_use");
    expect(toolResult!.ev.type).toBe("tool_result");
    expect(toolResult!.replace).toBe(true);
    expect(toolResult!.k).toBe(toolUse!.k);
  });

  // H6 — a single tick must not read an unbounded amount of a file: a large
  // backlog is spread across more than one call, each a plain continuation
  // rather than a fresh read of everything still outstanding.
  it("H6: one tick reads at most a bounded budget, the rest completes on the next", () => {
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
