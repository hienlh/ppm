import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readMemberTranscriptSlice } from "../../../src/services/team-member-activity/member-transcript-tail.ts";

let dir = "";
let file = "";

/** One JSONL record as Claude Code writes them. */
function record(timestamp: string, role: "user" | "assistant", content: unknown): string {
  return JSON.stringify({ type: role, timestamp, message: { role, content } }) + "\n";
}

function assistantStep(n: number): string {
  return record(`2026-09-15T01:0${n}:00.000Z`, "assistant", [
    { type: "tool_use", id: `tu_${n}`, name: "Bash", input: { command: `echo ${n}` } },
  ]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ppm-member-tail-"));
  file = join(dir, "agent-aaa.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readMemberTranscriptSlice", () => {
  it("returns an empty slice for a missing file without moving the offset", () => {
    const slice = readMemberTranscriptSlice(join(dir, "nope.jsonl"), 120);
    expect(slice.events).toEqual([]);
    expect(slice.nextBytes).toBe(120);
    expect(slice.restarted).toBe(false);
  });

  it("reads the whole file from offset zero and reports a line-boundary offset", async () => {
    await writeFile(file, assistantStep(1) + assistantStep(2), "utf-8");
    const slice = readMemberTranscriptSlice(file, 0);
    expect(slice.events).toHaveLength(2);
    expect(slice.nextBytes).toBe((await stat(file)).size);
    expect(slice.restarted).toBe(false);
  });

  it("returns only the steps appended since the caller's offset", async () => {
    await writeFile(file, assistantStep(1), "utf-8");
    const first = readMemberTranscriptSlice(file, 0);
    await appendFile(file, assistantStep(2) + assistantStep(3), "utf-8");

    const second = readMemberTranscriptSlice(file, first.nextBytes);
    expect(second.events).toHaveLength(2);
    expect(second.events.map((e) => (e as { toolUseId?: string }).toolUseId)).toEqual(["tu_2", "tu_3"]);
  });

  it("is empty when nothing was appended", async () => {
    await writeFile(file, assistantStep(1), "utf-8");
    const first = readMemberTranscriptSlice(file, 0);
    const second = readMemberTranscriptSlice(file, first.nextBytes);
    expect(second.events).toEqual([]);
    expect(second.nextBytes).toBe(first.nextBytes);
  });

  it("leaves a half-written record for the next poll and emits it exactly once", async () => {
    await writeFile(file, assistantStep(1), "utf-8");
    const first = readMemberTranscriptSlice(file, 0);

    // Writer is mid-record: bytes are present but the line has no newline yet.
    const whole = assistantStep(2);
    const split = Math.floor(whole.length / 2);
    await appendFile(file, whole.slice(0, split), "utf-8");
    const partial = readMemberTranscriptSlice(file, first.nextBytes);
    expect(partial.events).toEqual([]);
    expect(partial.nextBytes).toBe(first.nextBytes);

    await appendFile(file, whole.slice(split), "utf-8");
    const completed = readMemberTranscriptSlice(file, partial.nextBytes);
    expect(completed.events).toHaveLength(1);
    expect(readMemberTranscriptSlice(file, completed.nextBytes).events).toEqual([]);
  });

  it("re-reads from the start and flags it when the file shrank", async () => {
    await writeFile(file, assistantStep(1) + assistantStep(2), "utf-8");
    const stale = (await stat(file)).size;
    await writeFile(file, assistantStep(9), "utf-8");

    const slice = readMemberTranscriptSlice(file, stale);
    expect(slice.restarted).toBe(true);
    expect(slice.events).toHaveLength(1);
    expect(slice.nextBytes).toBe((await stat(file)).size);
  });

  it("keeps a multi-byte character whole across a slice boundary", async () => {
    await writeFile(file, assistantStep(1), "utf-8");
    const first = readMemberTranscriptSlice(file, 0);
    await appendFile(
      file,
      record("2026-09-15T01:09:00.000Z", "assistant", [{ type: "text", text: "đã xong — hoàn tất" }]),
      "utf-8",
    );

    const second = readMemberTranscriptSlice(file, first.nextBytes);
    expect(second.events).toHaveLength(1);
    expect((second.events[0] as { content?: string }).content).toBe("đã xong — hoàn tất");
  });
});
