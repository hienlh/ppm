import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRolloutTailParser, type TailEventEnvelope } from "../../../src/providers/codex-app-server/codex-rollout-tail-parser.ts";
import { parseRolloutJsonl } from "../../../src/providers/codex-app-server/codex-history.ts";

const FIXTURES = join(import.meta.dir, "../../fixtures/codex");
const FIXTURE_TEXT = readFileSync(join(FIXTURES, "rollout-child-stream.jsonl"), "utf-8");

const SECRET = "sk-FAKE1234567890ABCDEFGHIJKLMNOPQR";
const BASE64_BLOB = "FAKEBASE64ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ==";
const GRANDCHILD_ID = "66666666-6666-4666-8666-666666666666";

/** Feed `chunks` through a fresh parser, honoring `reset` the way a real caller
 *  must: on reset, replace the accumulated list with this call's own batch
 *  rather than appending to the old one. */
function feedChunks(chunks: string[]): { events: TailEventEnvelope[]; links: string[] } {
  const parser = createRolloutTailParser();
  let collected: TailEventEnvelope[] = [];
  const links: string[] = [];
  for (const chunk of chunks) {
    const res = parser.feed(chunk);
    if (res.reset) collected = [];
    collected.push(...res.events);
    links.push(...res.links);
  }
  return { events: collected, links };
}

function toolUseIds(envelopes: TailEventEnvelope[]): string[] {
  const ids: string[] = [];
  for (const { ev } of envelopes) {
    if (ev.type === "tool_use" && ev.toolUseId && !ids.includes(ev.toolUseId)) ids.push(ev.toolUseId);
  }
  return ids;
}

/** Whole-file text as one line array (each including its trailing "\n"). */
function fixtureLines(): string[] {
  return FIXTURE_TEXT.split(/(?<=\n)/).filter((l) => l.length > 0);
}

// Everything before the fixture's trailing `compacted` line, for comparing
// against the history parser's pre-compaction view. The compaction itself
// (which both parsers correctly collapse to nothing, since its
// replacement_history carries no tool steps) is covered separately below.
const PRE_COMPACT_TEXT = fixtureLines().slice(0, -1).join("");

describe("createRolloutTailParser: equivalence with the history parser", () => {
  const reference = parseRolloutJsonl(PRE_COMPACT_TEXT)
    .flatMap((m) => m.events ?? [])
    .filter((e) => e.type === "tool_use")
    .map((e) => (e as { toolUseId?: string }).toolUseId)
    .filter((id): id is string => !!id);

  it("has the 4 expected steps in order (sanity on the fixture itself)", () => {
    expect(reference).toEqual(["call_ls", "call_cat", `subagent-${GRANDCHILD_ID}`, "call_echo"]);
  });

  it("all at once", () => {
    const { events } = feedChunks([PRE_COMPACT_TEXT]);
    expect(toolUseIds(events)).toEqual(reference);
  });

  it("one line at a time", () => {
    const lines = PRE_COMPACT_TEXT.split(/(?<=\n)/).filter((l) => l.length > 0);
    const { events } = feedChunks(lines);
    expect(toolUseIds(events)).toEqual(reference);
  });

  it("split at every possible line boundary", () => {
    const lines = PRE_COMPACT_TEXT.split(/(?<=\n)/).filter((l) => l.length > 0);
    for (let i = 1; i < lines.length; i++) {
      const { events } = feedChunks([lines.slice(0, i).join(""), lines.slice(i).join("")]);
      expect(toolUseIds(events), `split at line ${i}`).toEqual(reference);
    }
  });

  it("never duplicates a step from the response_item copy of an item-events record", () => {
    const { events } = feedChunks([PRE_COMPACT_TEXT]);
    const appended = events.filter((e) => e.ev.type === "tool_use" && !e.replace);
    expect(appended.length).toBe(4); // not 8 — the response_item side is skipped wholesale
  });
});

describe("createRolloutTailParser: redaction", () => {
  it("never emits the fake secret token or the fake image base64 blob", () => {
    const { events } = feedChunks([PRE_COMPACT_TEXT]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(BASE64_BLOB);
    // the secret-bearing command output is still shown, just scrubbed
    expect(serialized).toContain("sk-***");
  });
});

describe("createRolloutTailParser: nested spawn links", () => {
  it("reports the grandchild's thread id in links, without attaching it as children", () => {
    const { links, events } = feedChunks([PRE_COMPACT_TEXT]);
    expect(links).toContain(GRANDCHILD_ID);
    const spawnCard = events.find((e) => e.ev.type === "tool_use" && e.ev.toolUseId === `subagent-${GRANDCHILD_ID}`);
    expect(spawnCard).toBeDefined();
    expect((spawnCard!.ev as { children?: unknown }).children).toBeUndefined();
  });
});

describe("createRolloutTailParser: reset on compaction / rollback", () => {
  it("signals reset on a compacted record and drops everything before it", () => {
    const parser = createRolloutTailParser();
    const res = parser.feed(FIXTURE_TEXT);
    expect(res.reset).toBe(true);
    expect(res.events).toEqual([]); // compaction is the fixture's last line — nothing follows it
  });

  it("signals reset on thread_rolled_back too", () => {
    const text =
      `{"type":"session_meta","payload":{"id":"s1","cli_version":"0.159.2"}}\n` +
      `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"hi"}]}}}\n` +
      `{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}\n`;
    const parser = createRolloutTailParser();
    const res = parser.feed(text);
    expect(res.reset).toBe(true);
  });
});

describe("createRolloutTailParser: format decision from the FIRST session_meta only", () => {
  it("ignores cli_version on a second session_meta (the forked parent context)", () => {
    // Own header is a new (item-events) writer; second session_meta claims an
    // old one. If the second were consulted, the command below would be read
    // via the (absent) response_item path and produce nothing.
    const text =
      `{"type":"session_meta","payload":{"id":"child","cli_version":"0.159.2"}}\n` +
      `{"type":"session_meta","payload":{"id":"parent","cli_version":"0.100.0"}}\n` +
      `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"c1","command":["echo","hi"],"exit_code":0,"aggregated_output":"hi"}}}\n`;
    const { events } = feedChunks([text]);
    expect(toolUseIds(events)).toEqual(["c1"]);
  });

  it("defaults to item-events when cli_version is absent (undecidable)", () => {
    const text =
      `{"type":"session_meta","payload":{"id":"s1"}}\n` +
      `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"c1","command":["echo","hi"],"exit_code":0,"aggregated_output":"hi"}}}\n` +
      // A response_item duplicate of the same call must be skipped under the default.
      `{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"echo hi\\"}","call_id":"c1"}}\n`;
    const { events: final } = feedChunks([text]);
    expect(final.filter((e) => e.ev.type === "tool_use").length).toBe(1);
  });

  it("reads the legacy response_item pairs when cli_version predates item-events", () => {
    const text =
      `{"type":"session_meta","payload":{"id":"s1","cli_version":"0.141.0"}}\n` +
      `{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"echo hi\\"}","call_id":"call_1"}}\n` +
      `{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"Exit code: 0\\nhi ${SECRET}"}}\n`;
    const { events: final } = feedChunks([text]);
    const toolUse = final.find((e) => e.ev.type === "tool_use");
    const toolResult = final.find((e) => e.ev.type === "tool_result");
    expect(toolUse).toBeDefined();
    expect((toolUse!.ev as { tool?: string }).tool).toBe("Bash");
    expect(toolResult).toBeDefined();
    expect((toolResult!.ev as { output?: string }).output).not.toContain(SECRET);
    expect((toolResult!.ev as { output?: string }).output).toContain("sk-***");
  });
});

describe("createRolloutTailParser: toolUseId upsert semantics", () => {
  it("marks the first event with a new id plain, and a later one for the same id as replace:true", () => {
    const text =
      `{"type":"session_meta","payload":{"id":"s1","cli_version":"0.159.2"}}\n` +
      `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"c1","command":["echo","hi"],"exit_code":0,"aggregated_output":"hi"}}}\n`;
    const { events: final } = feedChunks([text]);
    const tu = final.find((e) => e.ev.type === "tool_use")!;
    const tr = final.find((e) => e.ev.type === "tool_result")!;
    expect(tu.replace).toBeUndefined();
    expect(tr.replace).toBe(true);
  });
});

describe("createRolloutTailParser: timestamps", () => {
  it("carries the last known timestamp forward when a record has none", () => {
    const text =
      `{"timestamp":"2026-10-01T08:00:00.000Z","type":"session_meta","payload":{"id":"s1","cli_version":"0.159.2"}}\n` +
      `{"timestamp":"2026-10-01T08:00:05.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"hi"}]}}}\n` +
      // No timestamp on this record.
      `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"a1","content":[{"type":"text","text":"bye"}]}}}\n`;
    const { events: final } = feedChunks([text]);
    expect(final.length).toBe(2);
    expect(final[0]!.ts).toBe(Date.parse("2026-10-01T08:00:05.000Z"));
    expect(final[1]!.ts).toBe(final[0]!.ts); // carried forward, not 0 / NaN
  });
});
