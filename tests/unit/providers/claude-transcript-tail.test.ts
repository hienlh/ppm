/**
 * Reading a Claude transcript backward from its end must give the SDK's own answer.
 *
 * The SDK's forward read skips nothing once a boundary preserves messages, which every
 * auto-compaction does; a 1.77 GB session was read whole on each chat open (8.5 s) for 31
 * messages. These pin where the backward scan stops and that the result is byte-identical to
 * `getSessionMessages` reading the file itself.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Other files mock the SDK with `getSessionMessages` answering [], and Bun keeps a module mock
// for the rest of the run, so whichever of them ran first decided what this file compared. A
// query string loads the real module past the mock, and it is put back in the mock's place (as
// a plain object: a module namespace handed back as is leaves the mock where it was).
const realSdk = await import(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk") + "?real");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk }));
const { getSessionMessages } = realSdk as typeof import("@anthropic-ai/claude-agent-sdk");
const { readSessionMessages, segmentReadStart, TAIL_READ_MIN_BYTES } = await import("../../../src/providers/claude-transcript-tail.ts");

const SESSION = "11111111-2222-4333-8444-555555555555";
let configDir: string;
let projectDir: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "ppm-tail-"));
  projectDir = join(configDir, "projects", "-tmp-tail-project");
  mkdirSync(projectDir, { recursive: true });
  // The SDK resolves the transcript under CLAUDE_CONFIG_DIR, so the comparison never reads ~/.claude.
  process.env.CLAUDE_CONFIG_DIR = configDir;
});
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const ts = () => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();

/** Writes a transcript the way Claude Code lays one out and remembers each record's offset. */
class Transcript {
  readonly lines: string[] = [];
  readonly offsets = new Map<string, number>();
  private bytes = 0;
  last: string | null = null;

  add(record: Record<string, unknown>): string {
    const id = (record.uuid as string | undefined) ?? "";
    const line = JSON.stringify(record) + "\n";
    if (id) this.offsets.set(id, this.bytes);
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line);
    return id;
  }
  user(text: string, extra: Record<string, unknown> = {}): string {
    const id = this.add({ parentUuid: this.last, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid: uuid(), timestamp: ts(), sessionId: SESSION, ...extra });
    this.last = id;
    return id;
  }
  assistant(text: string): string {
    const id = this.add({ parentUuid: this.last, isSidechain: false, type: "assistant", message: { id: `msg_${n}`, role: "assistant", content: [{ type: "text", text }] }, uuid: uuid(), timestamp: ts(), sessionId: SESSION });
    this.last = id;
    return id;
  }
  /** A compaction keeping the last `keep` messages, as current Claude Code writes it. */
  compact(preserved: string[], opts: { preserve?: boolean } = {}): { boundary: string; summary: string } {
    const boundary = uuid();
    const summary = uuid();
    const preserve = opts.preserve !== false && preserved.length > 0;
    this.add({
      parentUuid: null, logicalParentUuid: this.last, isSidechain: false, type: "system", subtype: "compact_boundary",
      content: "Conversation compacted", uuid: boundary, timestamp: ts(), sessionId: SESSION,
      compactMetadata: {
        trigger: "auto", preTokens: 300000, postTokens: 20000,
        ...(preserve && {
          preservedSegment: { headUuid: preserved[0], anchorUuid: summary, tailUuid: preserved.at(-1) },
          preservedMessages: { anchorUuid: summary, uuids: preserved },
        }),
      },
    });
    this.last = boundary;
    this.user("This session is being continued from a previous conversation…", { uuid: summary, isCompactSummary: true, isVisibleInTranscriptOnly: true });
    return { boundary, summary };
  }
  /** A turn whose tool output is `size` bytes, the bulk of a real transcript. */
  bulk(size: number): void {
    this.user("run it");
    this.assistant("x".repeat(size));
  }
  write(file: string): string {
    writeFileSync(file, this.lines.join(""));
    return file;
  }
}

const fileFor = (name: string) => join(projectDir, name);
const sessionFile = () => join(projectDir, `${SESSION}.jsonl`);

describe("segmentReadStart", () => {
  it("stops at the newest boundary that preserves nothing", async () => {
    const t = new Transcript();
    t.bulk(4000);
    t.compact([], { preserve: false });
    t.bulk(4000);
    const { boundary } = t.compact([], { preserve: false });
    t.user("after");
    const file = t.write(fileFor("plain.jsonl"));
    expect(await segmentReadStart(file, statSync(file).size)).toBe(t.offsets.get(boundary)!);
  });

  it("goes back past a preserving boundary to the first record it keeps", async () => {
    const t = new Transcript();
    t.bulk(4000);
    const kept = [t.user("kept 1"), t.assistant("kept 2"), t.user("kept 3")];
    t.compact(kept);
    t.user("after");
    const file = t.write(fileFor("preserved.jsonl"));
    expect(await segmentReadStart(file, statSync(file).size)).toBe(t.offsets.get(kept[0]!)!);
  });

  it("reads the whole file when a preserved record is nowhere in it", async () => {
    const t = new Transcript();
    t.bulk(4000);
    t.compact(["00000000-0000-4000-8000-999999999999"]);
    t.user("after");
    const file = t.write(fileFor("missing.jsonl"));
    expect(await segmentReadStart(file, statSync(file).size)).toBe(0);
  });

  it("ignores the marker inside message text and past the SDK's 256-byte window", async () => {
    const t = new Transcript();
    t.bulk(4000);
    const { boundary } = t.compact([], { preserve: false });
    t.user('a tool printed {"type":"system","subtype":"compact_boundary"} here');
    t.add({ type: "system", subtype: "informational", note: "y".repeat(300), mention: "compact_boundary", uuid: uuid(), parentUuid: t.last });
    const file = t.write(fileFor("quoted.jsonl"));
    expect(await segmentReadStart(file, statSync(file).size)).toBe(t.offsets.get(boundary)!);
  });

  it("finds records longer than the read chunk", async () => {
    const t = new Transcript();
    t.bulk(4000);
    // A kept record spanning two 1 MB chunks, behind one spanning three.
    const kept = [t.user("kept"), t.assistant("k".repeat(1_500_000))];
    t.compact(kept);
    t.bulk(2_500_000);
    const file = t.write(fileFor("long-lines.jsonl"));
    expect(await segmentReadStart(file, statSync(file).size)).toBe(t.offsets.get(kept[0]!)!);
  });
});

describe("readSessionMessages", () => {
  /** A transcript past the threshold with several preserving compactions. */
  function longSession(): Transcript {
    const t = new Transcript();
    for (let c = 0; c < 4; c++) {
      t.bulk(Math.ceil(TAIL_READ_MIN_BYTES / 3));
      const kept = [t.user(`question ${c}`), t.assistant(`answer ${c}`)];
      t.compact(kept);
      t.user(`follow-up ${c}`);
      t.assistant(`reply ${c}`);
    }
    return t;
  }

  it("answers what getSessionMessages answers, from the end of the file only", async () => {
    const file = longSession().write(sessionFile());
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(TAIL_READ_MIN_BYTES);

    const fromSdk = await getSessionMessages(SESSION);
    const read = await readSessionMessages(SESSION, file);
    expect(JSON.stringify(read.messages)).toBe(JSON.stringify(fromSdk));
    expect(read.messages.map((m) => (m.message as { content: unknown }).content)).toContain("follow-up 3");
    expect(read.fromByte).toBeGreaterThan(size - 100_000);
  });

  it("skips a last line still being written, as the SDK does", async () => {
    const file = longSession().write(sessionFile());
    appendFileSync(file, '{"parentUuid":"00000000-0000-4000-8000-0000000');
    const read = await readSessionMessages(SESSION, file);
    expect(JSON.stringify(read.messages)).toBe(JSON.stringify(await getSessionMessages(SESSION)));
  });

  it("leaves a small transcript to the SDK", async () => {
    const t = new Transcript();
    t.user("hello");
    t.assistant("hi");
    const file = t.write(sessionFile());
    const read = await readSessionMessages(SESSION, file);
    expect(read.fromByte).toBe(0);
    expect(read.messages).toHaveLength(2);
  });
});
