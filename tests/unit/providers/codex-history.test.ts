import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRolloutJsonl, listCodexRollouts, findRolloutByThreadId, getRolloutMessages } from "../../../src/providers/codex-app-server/codex-history.ts";

const FIXTURES = join(import.meta.dir, "../../fixtures/codex");
const PPM_CWD = "C:\\Users\\PC\\ppm";

describe("parseRolloutJsonl", () => {
  const text = readFileSync(join(FIXTURES, "rollout-real.jsonl"), "utf-8");

  it("reconstructs ordered user/assistant transcript", () => {
    const msgs = parseRolloutJsonl(text);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const user = msgs.find((m) => m.role === "user");
    const asst = msgs.find((m) => m.role === "assistant");
    expect(user?.content).toContain("2+2");
    expect(asst?.content).toBe("4");
    // user precedes assistant
    expect(msgs.indexOf(user!)).toBeLessThan(msgs.indexOf(asst!));
  });

  it("ignores a trailing partial (non-newline-terminated) line", () => {
    const withPartial = text + '{"type":"event_msg","payload":{"type":"user_mess';
    expect(() => parseRolloutJsonl(withPartial)).not.toThrow();
    expect(parseRolloutJsonl(withPartial).length).toBe(parseRolloutJsonl(text).length);
  });

  it("skips corrupt lines without throwing", () => {
    const corrupt = '{bad json\n' + text;
    expect(() => parseRolloutJsonl(corrupt)).not.toThrow();
  });

  it("maps custom_tool_call (apply_patch) → Write/Edit tool_use in history", () => {
    const patch = "*** Begin Patch\\n*** Add File: tests/x.txt\\n+hello\\n*** End Patch\\n";
    const text =
      `{"type":"event_msg","payload":{"type":"user_message","message":"make a file"}}\n` +
      `{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"call_p1","input":"${patch}"}}\n` +
      `{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_p1","output":"Exit code: 0\\nSuccess"}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}\n`;
    const msgs = parseRolloutJsonl(text);
    const asst = msgs.find((m) => m.role === "assistant" && m.events?.some((e) => e.type === "tool_use"));
    expect(asst).toBeDefined();
    const tu = asst!.events!.find((e) => e.type === "tool_use") as any;
    expect(tu.tool).toBe("Write");
    expect(tu.input.file_path).toBe("tests/x.txt");
    expect(tu.input.content).toBe("hello");
    expect(asst!.events!.some((e) => e.type === "tool_result" && (e as any).toolUseId === "call_p1")).toBe(true);
  });

  it("compaction: replacement_history replaces pre-compact messages", () => {
    const pre =
      `{"type":"event_msg","payload":{"type":"user_message","message":"old q1"}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":"old a1"}}\n`;
    const compacted =
      `{"type":"compacted","payload":{"message":"","replacement_history":[` +
      `{"type":"message","role":"user","content":[{"type":"input_text","text":"summary so far"}]},` +
      `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok continuing"}]}]}}\n`;
    const post = `{"type":"event_msg","payload":{"type":"user_message","message":"new q2"}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":"new a2"}}\n`;
    const full = pre + compacted + post;
    const msgs = parseRolloutJsonl(full);
    expect(msgs.map((m) => m.content)).toEqual(["summary so far", "ok continuing", "new q2", "new a2"]);
    expect(msgs.some((m) => m.content === "old q1")).toBe(false); // pre-compact dropped

    // preCompact mode returns the slice BEFORE the compaction boundary
    const preMsgs = parseRolloutJsonl(full, { preCompact: true });
    expect(preMsgs.map((m) => m.content)).toEqual(["old q1", "old a1"]);
  });

  it("honors thread_rolled_back (drops last N turns)", () => {
    const turn = (u: string, a: string) =>
      `{"type":"event_msg","payload":{"type":"user_message","message":${JSON.stringify(u)}}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":${JSON.stringify(a)}}}\n`;
    // 3 turns, then rollback 2, then 1 new turn → expect turns: t1 + t4 (2 user, 2 assistant)
    const rolled = turn("q1", "a1") + turn("q2", "a2") + turn("q3", "a3") +
      `{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":2}}\n` +
      turn("q4", "a4");
    const msgs = parseRolloutJsonl(rolled);
    const users = msgs.filter((m) => m.role === "user").map((m) => m.content);
    const asst = msgs.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(users).toEqual(["q1", "q4"]);
    expect(asst).toEqual(["a1", "a4"]);
  });

  it("nests tool calls into assistant events (function_call + output)", () => {
    const toolsText = readFileSync(join(FIXTURES, "rollout-with-tools.jsonl"), "utf-8");
    const msgs = parseRolloutJsonl(toolsText);
    const asstWithTools = msgs.find((m) => m.role === "assistant" && m.events?.some((e) => e.type === "tool_use"));
    expect(asstWithTools).toBeDefined();
    const tu = asstWithTools!.events!.find((e) => e.type === "tool_use") as any;
    const tr = asstWithTools!.events!.find((e) => e.type === "tool_result") as any;
    expect(["Bash", "PowerShell"]).toContain(tu.tool);
    expect(tu.input.command).toBeTruthy();
    expect(tu.toolUseId).toMatch(/^call_/);
    // tool_use ↔ tool_result paired by call_id
    expect(asstWithTools!.events!.some((e) => e.type === "tool_result" && (e as any).toolUseId === tu.toolUseId)).toBe(true);
    expect(typeof tr.output).toBe("string");
  });
});

describe("listCodexRollouts (fail-closed cwd filter)", () => {
  it("returns ONLY rollouts whose session_meta cwd matches the requested dir", () => {
    const sessions = listCodexRollouts(FIXTURES, PPM_CWD, "codex");
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("019eded7-3947-7990-a06e-bf9a29c25f26"); // ppm-cwd fixture
    expect(ids).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"); // D:\ fixture excluded
  });

  it("excludes rollouts from a different cwd", () => {
    const sessions = listCodexRollouts(FIXTURES, "D:\\other\\project", "codex");
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("returns nothing for an unrelated cwd (fail-closed)", () => {
    expect(listCodexRollouts(FIXTURES, "/nonexistent/path", "codex")).toEqual([]);
  });

  if (process.platform === "win32") {
    it("matches cwd case-insensitively on win32", () => {
      const sessions = listCodexRollouts(FIXTURES, PPM_CWD.toLowerCase(), "codex");
      expect(sessions.length).toBe(1);
    });
  }
});

describe("findRolloutByThreadId / getRolloutMessages (fail-closed resume/read path)", () => {
  const PPM_ID = "019eded7-3947-7990-a06e-bf9a29c25f26";
  const OTHER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("finds a thread when cwd matches", () => {
    expect(findRolloutByThreadId(FIXTURES, PPM_ID, PPM_CWD)).not.toBeNull();
  });

  it("does NOT return another project's thread when cwd mismatches (fail-closed)", () => {
    expect(findRolloutByThreadId(FIXTURES, OTHER_ID, PPM_CWD)).toBeNull();
    expect(getRolloutMessages(FIXTURES, OTHER_ID, PPM_CWD)).toEqual([]);
  });

  it("returns messages only for a cwd-attributable thread", () => {
    expect(getRolloutMessages(FIXTURES, PPM_ID, PPM_CWD).length).toBeGreaterThanOrEqual(2);
    // correct id but wrong cwd → fail-closed empty
    expect(getRolloutMessages(FIXTURES, PPM_ID, "D:\\other\\project")).toEqual([]);
  });

  it("ignores loose substring ids (anchored match only)", () => {
    expect(findRolloutByThreadId(FIXTURES, "019eded7", PPM_CWD)).toBeNull();
  });
});
