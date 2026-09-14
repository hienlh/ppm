import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, truncateSync, appendFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { ClaudeAgentSdkProvider } from "../../../src/providers/claude-agent-sdk";

/**
 * `getFullMessages` is the search indexer's door into a transcript, and until
 * this test it was the one door with no bound on it at all: `validateJsonlPath`
 * guards the *route* that serves one chat's pre-compact scroll, while the
 * indexer arrives here — unattended, once per stale session, and after a bumped
 * `INDEXER_VERSION` that is every session on disk.
 *
 * Black box on purpose, no module mocking. Each fixture carries one real
 * message at the very start and one at the very end, with sparse zeros between,
 * so which of them comes back says exactly how much of the file was read. That
 * also makes "refuse and let the SDK's own walk answer" visibly wrong rather
 * than merely slower: the SDK reads the same file, and on this 128MB fixture it
 * took 3.1s to arrive at the same message the guard had just declined to open.
 */
const PROJECTS = resolve(homedir(), ".claude", "projects");
const DIR = resolve(PROJECTS, "_ppm_test_full_parse_bound");
const SMALL = "11111111-2222-3333-4444-555555555555";
const HUGE = "66666666-7777-8888-9999-aaaaaaaaaaaa";
/** Stands in for FULL_PARSE_MAX_BYTES; see the `maxBytes` comment in the provider. */
const BOUND = 1024;

const record = (uuid: string, content: string) =>
  `${JSON.stringify({ uuid, type: "user", message: { content } })}\n`;

/**
 * `head` … sparse hole … `tail`, at exactly `size` bytes (`0` = no hole).
 * Costs no disk blocks.
 *
 * The newline before `tail` is load-bearing: a hole carries none of its own, so
 * without it the last record is one line with the zeros in front of it and
 * `JSON.parse` throws the pair away — which reads exactly like a window that
 * skipped too much.
 */
function transcript(sessionId: string, size: number): void {
  const path = resolve(DIR, `${sessionId}.jsonl`);
  const tail = record("u2", "newest");
  writeFileSync(path, record("u1", "oldest"));
  if (size > 0) truncateSync(path, size - tail.length - 1);
  appendFileSync(path, size > 0 ? `\n${tail}` : tail);
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  transcript(SMALL, 0);
  transcript(HUGE, BOUND + 1);
});

afterAll(() => {
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("getFullMessages is bounded by transcript size", () => {
  test("reads the whole history of a transcript under the bound", async () => {
    const messages = await new ClaudeAgentSdkProvider().getFullMessages(SMALL, { maxBytes: BOUND });
    expect(messages.map((m) => m.content)).toEqual(["oldest", "newest"]);
  });

  test("one byte over the bound, the oldest end is dropped and the newest kept", async () => {
    expect(statSync(resolve(DIR, `${HUGE}.jsonl`)).size).toBe(BOUND + 1);
    const messages = await new ClaudeAgentSdkProvider().getFullMessages(HUGE, { maxBytes: BOUND });
    // Unbounded, this answers ["oldest", "newest"] and pays ~4.3x the file in
    // transient RSS to do it. Windowed, the session stays searchable by its
    // recent content and the cost stops rising with the file.
    expect(messages.map((m) => m.content)).toEqual(["newest"]);
  });
});
