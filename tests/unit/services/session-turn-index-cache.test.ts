import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { TurnIndexCache } from "../../../src/services/session-turns/turn-index-cache.ts";
import { readTranscriptLines } from "../../../src/services/session-turns/turn-line-reader.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { readSessionTurnMessages } from "../../../src/services/session-turns/session-turn-reader.ts";
import { listSessionTurns } from "../../../src/services/session-turns/session-turn-index.service.ts";
import { claude, lines } from "./session-turn-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-turns-cache-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A cache whose "state" is the list of lines it has seen, with a log of every scan it ran. */
function lineCache(opts: { maxEntries?: number; maxBytes?: number; sizeOf?: (s: string[]) => number } = {}) {
  const scans: Array<{ path: string; fromByte: number }> = [];
  let gate: Promise<void> | null = null;
  const cache = new TurnIndexCache<string[]>({
    newState: () => [],
    async scan(path, state, fromByte) {
      scans.push({ path, fromByte });
      if (gate) await gate;
      let offset = fromByte;
      for await (const line of readTranscriptLines(path, fromByte)) {
        state.push(line.text);
        offset = line.end;
      }
      return offset;
    },
    sizeOf: opts.sizeOf ?? ((s) => s.length),
    maxEntries: opts.maxEntries,
    maxBytes: opts.maxBytes,
  });
  return { cache, scans, hold: (p: Promise<void>) => { gate = p; }, release: () => { gate = null; } };
}

const file = (name: string, body: string) => {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
};

describe("TurnIndexCache", () => {
  test("an appended file is scanned from where the last scan stopped", async () => {
    const { cache, scans } = lineCache();
    const path = file("append.jsonl", "a\nb\n");
    await cache.get(path);
    appendFileSync(path, "c\nd\n");
    const entry = await cache.get(path);
    expect(scans.map((s) => s.fromByte)).toEqual([0, 4]);
    expect(entry.state).toEqual(["a", "b", "c", "d"]);
  });

  test("an unchanged file is not scanned again", async () => {
    const { cache, scans } = lineCache();
    const path = file("same.jsonl", "a\n");
    await cache.get(path);
    await cache.get(path);
    expect(scans).toHaveLength(1);
  });

  test("a same-inode rewrite that shrinks then grows past the old size starts over", async () => {
    const { cache, scans } = lineCache();
    const path = file("rewrite.jsonl", `${"x".repeat(100)}\n${"y".repeat(100)}\n`);
    await cache.get(path);
    writeFileSync(path, "short\n");
    appendFileSync(path, `${"z".repeat(300)}\n`);
    const entry = await cache.get(path);
    expect(scans.map((s) => s.fromByte)).toEqual([0, 0]);
    expect(entry.state).toEqual(["short", "z".repeat(300)]);
  });

  test("concurrent asks for one file share a single scan", async () => {
    const { cache, scans, hold, release } = lineCache();
    const path = file("shared.jsonl", "a\n");
    let open!: () => void;
    hold(new Promise<void>((r) => (open = r)));
    const [first, second] = [cache.get(path), cache.get(path)];
    release();
    open();
    expect(await first).toBe(await second);
    expect(scans).toHaveLength(1);
  });

  test("a caller that saw more of the file than a running scan gets a scan that read it", async () => {
    // This scan reads first and only then waits, so it finishes on the file as it was.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const cache = new TurnIndexCache<string[]>({
      newState: () => [],
      async scan(path, state, fromByte) {
        let offset = fromByte;
        for await (const line of readTranscriptLines(path, fromByte)) { state.push(line.text); offset = line.end; }
        if (fromByte === 0) await gate;
        return offset;
      },
      sizeOf: (s) => s.length,
    });
    const path = file("join-older.jsonl", "prompt one\n");
    const first = cache.get(path);
    await new Promise((r) => setTimeout(r, 20));
    appendFileSync(path, "prompt two\n");
    const second = cache.get(path); // stats the longer file, then finds the first scan running
    await new Promise((r) => setTimeout(r, 20));
    open();
    expect((await first).state).toEqual(["prompt one"]);
    const entry = await second;
    expect(entry.state).toEqual(["prompt one", "prompt two"]);
    expect(entry.size).toBe(22);
  });

  test("the least recently used scan is dropped past the entry cap", async () => {
    const { cache, scans } = lineCache({ maxEntries: 2 });
    const [a, b, c] = ["lru-a", "lru-b", "lru-c"].map((n) => file(`${n}.jsonl`, `${n}\n`));
    await cache.get(a!);
    await cache.get(b!);
    await cache.get(a!); // a is now the most recent
    await cache.get(c!); // evicts b
    expect(cache.size).toBe(2);
    await cache.get(a!);
    await cache.get(b!);
    expect(scans.map((s) => s.path)).toEqual([a, b, c, b]);
  });

  test("the byte budget evicts too, but never the scan just made", async () => {
    const { cache } = lineCache({ maxBytes: 10, sizeOf: () => 8 });
    await cache.get(file("budget-a.jsonl", "a\n"));
    await cache.get(file("budget-b.jsonl", "b\n"));
    expect(cache.size).toBe(1);
  });
});

describe("reading a turn after the transcript was rewritten under the same size and time", () => {
  const projectPath = join(root, "proj");
  const slugDir = join(root, "projects", projectPath.replace(/[/\\:.]/g, "-"));
  beforeAll(() => {
    mkdirSync(slugDir, { recursive: true });
    _setClaudeProjectsRoot(join(root, "projects"));
  });
  afterAll(() => _setClaudeProjectsRoot(null));

  test("never answers with another turn's text: the anchor check rebuilds the index", async () => {
    const id = randomUUID();
    const path = join(slugDir, `${id}.jsonl`);
    const A = "22222222-0000-4000-8000-00000000000a";
    const B = "22222222-0000-4000-8000-00000000000b";
    const turnA = [claude.prompt("ask aaaa", A), claude.assistant("reply aaaa")];
    const turnB = [claude.prompt("ask bbbb", B), claude.assistant("reply bbbb")];
    const when = new Date("2026-11-02T00:00:00Z");
    writeFileSync(path, lines(...turnA, ...turnB));
    utimesSync(path, when, when);
    const ref = { providerId: "claude", sessionId: id, projectPath };
    expect((await listSessionTurns(ref)).turns.map((t) => t.turnId)).toEqual([A, B]);

    // Same bytes, other order, same size and mtime: the cached offsets now point at the other turn.
    writeFileSync(path, lines(...turnB, ...turnA));
    utimesSync(path, when, when);
    const [read] = await readSessionTurnMessages(ref, [A]);
    expect(read!.messages.map((m) => m.content)).toEqual(["ask aaaa", "reply aaaa"]);
    expect(read!.turn.n).toBe(2);
  });
});
