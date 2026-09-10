import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nestedSubagentSpy } from "../../../src/services/nested-subagent-spy.ts";
import type { ChatEvent } from "../../../src/types/chat.ts";

const CARD = "toolu_card";
let sessionDir: string;
let subDir: string;

const rec = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "ppm-nested-spy-"));
  subDir = join(sessionDir, "subagents");
  mkdirSync(subDir);
  // depth 1 — streamed live by the SDK, the spy must ignore it
  writeFileSync(join(subDir, "agent-d1.meta.json"), JSON.stringify({ toolUseId: CARD }));
  writeFileSync(join(subDir, "agent-d1.jsonl"), rec({ type: "assistant", message: { content: [{ type: "text", text: "depth1 text" }] } }));
});

afterEach(() => {
  nestedSubagentSpy.stopSpy(CARD);
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("nestedSubagentSpy", () => {
  test("emits a nested agent's new records stamped with the card id, skipping its spawn prompt and depth-1", async () => {
    const got: ChatEvent[] = [];
    nestedSubagentSpy.startSpy("s1", CARD, sessionDir, (evs) => got.push(...evs));

    // nested agent appears after the spy started (CLI writes meta+jsonl on spawn)
    writeFileSync(join(subDir, "agent-d2.meta.json"), JSON.stringify({ parentAgentId: "d1", spawnDepth: 2 }));
    writeFileSync(join(subDir, "agent-d2.jsonl"),
      rec({ type: "user", message: { role: "user", content: "spawn prompt" } })
      + rec({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_g", name: "Grep", input: { pattern: "x" } }] } }));
    await sleep(1300);
    expect(got.map((e) => e.type)).toEqual(["tool_use"]);
    expect((got[0] as any).tool).toBe("Grep");
    expect((got[0] as any).parentToolUseId).toBe(CARD);

    // only the delta is emitted on the next tick
    appendFileSync(join(subDir, "agent-d2.jsonl"), rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_g", content: "hit" }] } }));
    await sleep(1300);
    expect(got.map((e) => e.type)).toEqual(["tool_use", "tool_result"]);
    expect(got.some((e) => e.type === "text")).toBe(false); // depth-1 never leaks in
  });

  test("holds an unterminated record — even one cut mid multi-byte char — until it completes", async () => {
    const got: ChatEvent[] = [];
    writeFileSync(join(subDir, "agent-d2.meta.json"), JSON.stringify({ parentAgentId: "d1" }));
    const path = join(subDir, "agent-d2.jsonl");
    writeFileSync(path, rec({ type: "user", message: { role: "user", content: "spawn prompt" } }));
    nestedSubagentSpy.startSpy("s1", CARD, sessionDir, (evs) => got.push(...evs));

    const full = Buffer.from(rec({ type: "assistant", message: { content: [{ type: "text", text: "tiếng Việt" }] } }));
    // cut inside the 3-byte "ế"
    const cut = full.indexOf(Buffer.from("ế")) + 1;
    let fd = openSync(path, "a");
    writeSync(fd, full.subarray(0, cut));
    closeSync(fd);
    await sleep(1300);
    expect(got.length).toBe(0);

    fd = openSync(path, "a");
    writeSync(fd, full.subarray(cut));
    closeSync(fd);
    await sleep(1300);
    expect(got.length).toBe(1);
    expect((got[0] as any).content).toBe("tiếng Việt");
  });

  test("copes with a subagents/ dir that appears after startSpy; stopAllForSession drains both cards of a session", async () => {
    const late = mkdtempSync(join(tmpdir(), "ppm-nested-spy-late-"));
    try {
      const gotA: ChatEvent[] = [];
      const gotB: ChatEvent[] = [];
      nestedSubagentSpy.startSpy("s2", "toolu_A", late, (evs) => gotA.push(...evs));
      nestedSubagentSpy.startSpy("s2", "toolu_B", late, (evs) => gotB.push(...evs));
      await sleep(1100); // ticks against a missing dir must be silent no-ops

      const sub = join(late, "subagents");
      mkdirSync(sub);
      writeFileSync(join(sub, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "toolu_A" }));
      writeFileSync(join(sub, "agent-a1.jsonl"), "");
      writeFileSync(join(sub, "agent-a2.meta.json"), JSON.stringify({ parentAgentId: "a1" }));
      writeFileSync(join(sub, "agent-a2.jsonl"),
        rec({ type: "user", message: { role: "user", content: "spawn" } })
        + rec({ type: "assistant", message: { content: [{ type: "text", text: "for A" }] } }));
      writeFileSync(join(sub, "agent-b1.meta.json"), JSON.stringify({ toolUseId: "toolu_B" }));
      writeFileSync(join(sub, "agent-b1.jsonl"), "");
      writeFileSync(join(sub, "agent-b2.meta.json"), JSON.stringify({ parentAgentId: "b1" }));
      writeFileSync(join(sub, "agent-b2.jsonl"),
        rec({ type: "user", message: { role: "user", content: "spawn" } })
        + rec({ type: "assistant", message: { content: [{ type: "text", text: "for B" }] } }));

      // no tick has run since the writes — stopAll must still drain them
      nestedSubagentSpy.stopAllForSession("s2");
      expect(gotA.map((e) => [(e as any).content, (e as any).parentToolUseId])).toEqual([["for A", "toolu_A"]]);
      expect(gotB.map((e) => [(e as any).content, (e as any).parentToolUseId])).toEqual([["for B", "toolu_B"]]);

      appendFileSync(join(sub, "agent-a2.jsonl"), rec({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } }));
      await sleep(1200);
      expect(gotA.length).toBe(1); // poller is gone
    } finally {
      rmSync(late, { recursive: true, force: true });
    }
  });

  test("stopSpy drains what landed since the last poll", async () => {
    const got: ChatEvent[] = [];
    writeFileSync(join(subDir, "agent-d2.meta.json"), JSON.stringify({ parentAgentId: "d1" }));
    writeFileSync(join(subDir, "agent-d2.jsonl"), rec({ type: "user", message: { role: "user", content: "spawn prompt" } }));
    nestedSubagentSpy.startSpy("s1", CARD, sessionDir, (evs) => got.push(...evs));
    await sleep(1100);
    appendFileSync(join(subDir, "agent-d2.jsonl"), rec({ type: "assistant", message: { content: [{ type: "text", text: "last words" }] } }));
    nestedSubagentSpy.stopSpy(CARD);
    expect(got.map((e) => (e as any).content)).toEqual(["last words"]);
    // stopped: later writes are not observed
    appendFileSync(join(subDir, "agent-d2.jsonl"), rec({ type: "assistant", message: { content: [{ type: "text", text: "after stop" }] } }));
    await sleep(1200);
    expect(got.length).toBe(1);
  });
});
