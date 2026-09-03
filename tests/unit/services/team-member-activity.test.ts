import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  listSubagentTranscripts,
  indexTranscriptsByMember,
} from "../../../src/services/team-member-activity/subagent-transcript-index.ts";
import { summarizeTranscriptTail } from "../../../src/services/team-member-activity/transcript-tail-summary.ts";
import {
  scanOutboundMessages,
  clearOutboundScanCache,
} from "../../../src/services/team-member-activity/outbound-message-scanner.ts";

let dir = "";

/** One JSONL record as Claude Code writes them. */
function record(timestamp: string, role: "user" | "assistant", content: unknown): string {
  return JSON.stringify({ type: role, timestamp, message: { role, content } }) + "\n";
}

function toolUse(name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id: `tu_${name}`, name, input };
}

async function writeAgent(
  id: string,
  meta: Record<string, unknown>,
  lines: string[],
): Promise<{ transcript: string }> {
  await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta), "utf-8");
  const transcript = join(dir, `agent-${id}.jsonl`);
  await writeFile(transcript, lines.join(""), "utf-8");
  return { transcript };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ppm-subagents-"));
  clearOutboundScanCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  clearOutboundScanCache();
});

describe("listSubagentTranscripts", () => {
  it("returns empty for a missing directory", () => {
    expect(listSubagentTranscripts(join(dir, "nope"))).toEqual([]);
  });

  it("reads meta fields and pairs them with the transcript", async () => {
    await writeAgent(
      "aaa",
      { name: "dev-p1", agentType: "ak-engineer:fullstack-developer", model: "opus", description: "Phase 1", toolUseId: "toolu_1" },
      [record("2026-09-03T01:00:00.000Z", "assistant", [{ type: "text", text: "starting" }])],
    );
    const [entry] = listSubagentTranscripts(dir);
    expect(entry!.name).toBe("dev-p1");
    expect(entry!.agentType).toBe("ak-engineer:fullstack-developer");
    expect(entry!.model).toBe("opus");
    expect(entry!.toolUseId).toBe("toolu_1");
    expect(entry!.sizeBytes).toBeGreaterThan(0);
    expect(entry!.modifiedAt).toBeGreaterThan(0);
  });

  it("skips a meta file whose transcript is missing", async () => {
    await writeFile(join(dir, "agent-orphan.meta.json"), JSON.stringify({ name: "ghost" }), "utf-8");
    expect(listSubagentTranscripts(dir)).toEqual([]);
  });

  it("still surfaces a transcript whose meta is corrupt", async () => {
    await writeFile(join(dir, "agent-bad.meta.json"), "{not json", "utf-8");
    await writeFile(join(dir, "agent-bad.jsonl"), record("2026-09-03T01:00:00.000Z", "assistant", []), "utf-8");
    const entries = listSubagentTranscripts(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBeUndefined();
  });
});

describe("indexTranscriptsByMember", () => {
  it("drops unnamed agents — they are not team members", async () => {
    await writeAgent("x1", { agentType: "Explore" }, [record("2026-09-03T01:00:00.000Z", "assistant", [])]);
    expect(indexTranscriptsByMember(dir).size).toBe(0);
  });

  it("keeps the most recently written transcript when a name repeats", async () => {
    const older = await writeAgent("old", { name: "dev-p8" }, [record("2026-09-03T01:00:00.000Z", "assistant", [])]);
    await writeAgent("new", { name: "dev-p8" }, [record("2026-09-03T02:00:00.000Z", "assistant", [])]);
    // Make the second file unambiguously newer regardless of filesystem timestamp resolution.
    await appendFile(join(dir, "agent-new.jsonl"), record("2026-09-03T03:00:00.000Z", "assistant", []), "utf-8");
    const picked = indexTranscriptsByMember(dir).get("dev-p8");
    expect(picked!.transcriptPath).not.toBe(older.transcript);
  });
});

describe("summarizeTranscriptTail", () => {
  it("returns empty for a missing file", async () => {
    expect(await summarizeTranscriptTail(join(dir, "gone.jsonl"))).toEqual({});
  });

  it("reports start time, last event, last tool and its argument", async () => {
    const { transcript } = await writeAgent("sum", { name: "dev-p9" }, [
      record("2026-09-03T00:19:02.860Z", "user", "go"),
      record("2026-09-03T00:30:00.000Z", "assistant", [{ type: "text", text: "Running the suite" }]),
      record("2026-09-03T01:23:54.736Z", "assistant", [
        toolUse("PowerShell", { command: "bun test tests/unit\nmore lines here" }),
      ]),
    ]);
    const out = await summarizeTranscriptTail(transcript);
    expect(out.startedAt).toBe("2026-09-03T00:19:02.860Z");
    expect(out.lastEventAt).toBe("2026-09-03T01:23:54.736Z");
    expect(out.lastTool).toBe("PowerShell");
    // Only the command's first line — a multi-line script must not flood the row.
    expect(out.lastToolArg).toBe("bun test tests/unit");
    expect(out.lastNarrative).toBe("Running the suite");
  });

  it("prefers file_path when a tool has no command", async () => {
    const { transcript } = await writeAgent("fp", { name: "m" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("Edit", { file_path: "C:\\ppm\\a.ts" })]),
    ]);
    expect((await summarizeTranscriptTail(transcript)).lastToolArg).toBe("C:\\ppm\\a.ts");
  });

  it("survives a truncated final record from a mid-write read", async () => {
    const { transcript } = await writeAgent("trunc", { name: "m" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("Read", { file_path: "a.ts" })]),
    ]);
    await appendFile(transcript, '{"type":"assistant","timest', "utf-8");
    const out = await summarizeTranscriptTail(transcript);
    expect(out.lastTool).toBe("Read");
  });

  it("reads the tail of a file larger than the head budget", async () => {
    // Pad past HEAD_BYTES (64 KB) so head and tail are genuinely separate reads.
    const filler = Array.from({ length: 400 }, (_, i) =>
      record(`2026-09-03T01:${String(i % 60).padStart(2, "0")}:00.000Z`, "assistant", [
        { type: "text", text: "x".repeat(200) },
      ]),
    );
    const { transcript } = await writeAgent("big", { name: "m" }, [
      record("2026-09-03T00:00:00.000Z", "user", "start"),
      ...filler,
      record("2026-09-03T09:00:00.000Z", "assistant", [toolUse("Grep", { pattern: "needle" })]),
    ]);
    const out = await summarizeTranscriptTail(transcript);
    expect(out.startedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(out.lastTool).toBe("Grep");
    expect(out.lastToolArg).toBe("needle");
  });
});

describe("scanOutboundMessages", () => {
  it("extracts a teammate's SendMessage replies", async () => {
    const { transcript } = await writeAgent("out", { name: "dev-p1" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("Read", { file_path: "a.ts" })]),
      record("2026-09-03T02:00:00.000Z", "assistant", [
        toolUse("SendMessage", { to: "main", message: "Phase 1 complete", summary: "P1 done" }),
      ]),
    ]);
    const msgs = await scanOutboundMessages(transcript, "dev-p1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: "dev-p1", to: "main", text: "Phase 1 complete", summary: "P1 done" });
  });

  it("accepts the legacy recipient/content shape", async () => {
    const { transcript } = await writeAgent("legacy", { name: "dev-p2" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [
        toolUse("SendMessage", { recipient: "lead", content: "old shape" }),
      ]),
    ]);
    const msgs = await scanOutboundMessages(transcript, "dev-p2");
    expect(msgs[0]).toMatchObject({ to: "lead", text: "old shape" });
  });

  it("serialises a protocol object body instead of dropping it", async () => {
    const { transcript } = await writeAgent("proto", { name: "dev-p3" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [
        toolUse("SendMessage", { to: "main", message: { type: "completion", summary: "done" } }),
      ]),
    ]);
    const msgs = await scanOutboundMessages(transcript, "dev-p3");
    expect(JSON.parse(msgs[0]!.text)).toMatchObject({ type: "completion", summary: "done" });
  });

  it("defaults an unaddressed message to the orchestrator", async () => {
    const { transcript } = await writeAgent("noto", { name: "dev-p4" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("SendMessage", { message: "status" })]),
    ]);
    expect((await scanOutboundMessages(transcript, "dev-p4"))[0]!.to).toBe("main");
  });

  it("picks up appended messages without re-reporting old ones", async () => {
    const { transcript } = await writeAgent("incr", { name: "dev-p5" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("SendMessage", { to: "main", message: "first" })]),
    ]);
    expect(await scanOutboundMessages(transcript, "dev-p5")).toHaveLength(1);
    await appendFile(
      transcript,
      record("2026-09-03T02:00:00.000Z", "assistant", [toolUse("SendMessage", { to: "main", message: "second" })]),
      "utf-8",
    );
    const msgs = await scanOutboundMessages(transcript, "dev-p5");
    expect(msgs.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("re-reads from the start when the file shrank", async () => {
    const { transcript } = await writeAgent("shrink", { name: "dev-p6" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("SendMessage", { to: "main", message: "a" })]),
      record("2026-09-03T02:00:00.000Z", "assistant", [toolUse("SendMessage", { to: "main", message: "b" })]),
    ]);
    expect(await scanOutboundMessages(transcript, "dev-p6")).toHaveLength(2);
    await writeFile(
      transcript,
      record("2026-09-03T03:00:00.000Z", "assistant", [toolUse("SendMessage", { to: "main", message: "rewritten" })]),
      "utf-8",
    );
    const msgs = await scanOutboundMessages(transcript, "dev-p6");
    expect(msgs.map((m) => m.text)).toEqual(["rewritten"]);
  });

  it("ignores a partial trailing record until it is complete", async () => {
    const { transcript } = await writeAgent("partial", { name: "dev-p7" }, [
      record("2026-09-03T01:00:00.000Z", "assistant", [toolUse("SendMessage", { to: "main", message: "done" })]),
    ]);
    await appendFile(transcript, '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"SendMessage"', "utf-8");
    expect(await scanOutboundMessages(transcript, "dev-p7")).toHaveLength(1);
  });

  it("returns empty for a missing transcript", async () => {
    expect(await scanOutboundMessages(join(dir, "gone.jsonl"), "x")).toEqual([]);
  });
});
