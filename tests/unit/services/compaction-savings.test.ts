import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readCompactions, applyCompactions } from "../../../src/services/compaction-savings.ts";
import type { CompactionInfo } from "../../../src/types/chat.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a transcript of raw records and hand back its path. */
function transcript(records: unknown[]): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ppm-compaction-"));
  dirs.push(dir);
  const path = resolve(dir, "session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n"));
  return path;
}

function boundary(uuid: string, meta: Record<string, unknown>) {
  return { type: "system", subtype: "compact_boundary", uuid, parentUuid: null, compactMetadata: meta };
}

const FULL_META = { trigger: "auto", preTokens: 384281, postTokens: 6445, durationMs: 131761 };

describe("readCompactions", () => {
  it("keys a compaction by the summary message that follows it", async () => {
    const path = transcript([
      { type: "user", uuid: "old", parentUuid: null, message: { role: "user", content: "hi" } },
      boundary("b1", FULL_META),
      { type: "user", uuid: "summary-1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "..." } },
    ]);

    const found = await readCompactions(path);

    expect(found.size).toBe(1);
    expect(found.get("summary-1")).toEqual({
      trigger: "auto",
      preTokens: 384281,
      postTokens: 6445,
      savedTokens: 377836,
      durationMs: 131761,
    });
  });

  it("reads every compaction in a session that has been compacted more than once", async () => {
    const path = transcript([
      boundary("b1", { trigger: "auto", preTokens: 200_000, postTokens: 5_000 }),
      { type: "user", uuid: "summary-1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "..." } },
      { type: "assistant", uuid: "a1", parentUuid: "summary-1", message: { role: "assistant", content: [] } },
      boundary("b2", { trigger: "manual", preTokens: 180_000, postTokens: 4_000 }),
      { type: "user", uuid: "summary-2", parentUuid: "b2", isCompactSummary: true, message: { role: "user", content: "..." } },
    ]);

    const found = await readCompactions(path);

    expect(found.get("summary-1")?.savedTokens).toBe(195_000);
    expect(found.get("summary-2")?.savedTokens).toBe(176_000);
    // The trigger is per compaction, so a manual /compact after an automatic one
    // must not inherit the first one's wording.
    expect(found.get("summary-2")?.trigger).toBe("manual");
  });

  it("pairs by parentUuid, not by adjacency", async () => {
    // A record written between the boundary and the summary must not take its figures.
    const path = transcript([
      boundary("b1", FULL_META),
      { type: "attachment", uuid: "interloper", parentUuid: "something-else" },
      { type: "user", uuid: "summary-1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "..." } },
    ]);

    const found = await readCompactions(path);

    expect(found.has("interloper")).toBe(false);
    expect(found.get("summary-1")?.preTokens).toBe(384281);
  });

  it("omits a boundary with no usable token count rather than claiming a zero saving", async () => {
    const path = transcript([
      boundary("b1", { trigger: "auto" }),
      { type: "user", uuid: "summary-1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "..." } },
    ]);

    expect((await readCompactions(path)).size).toBe(0);
  });

  it("never reports a negative saving when the summary measured larger", async () => {
    const path = transcript([
      boundary("b1", { trigger: "auto", preTokens: 1_000, postTokens: 4_000 }),
      { type: "user", uuid: "summary-1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "..." } },
    ]);

    expect((await readCompactions(path)).get("summary-1")?.savedTokens).toBe(0);
  });

  it("treats an absent postTokens as a full drop, the way older records read", async () => {
    const path = transcript([
      boundary("b1", { trigger: "auto", preTokens: 50_000 }),
      { type: "user", uuid: "summary-1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "..." } },
    ]);

    const info = (await readCompactions(path)).get("summary-1");
    expect(info?.savedTokens).toBe(50_000);
    expect(info?.durationMs).toBeUndefined();
  });

  it("skips a malformed line without losing the compactions around it", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ppm-compaction-"));
    dirs.push(dir);
    const path = resolve(dir, "session.jsonl");
    writeFileSync(path, [
      "{ not json",
      JSON.stringify(boundary("b1", FULL_META)),
      JSON.stringify({ type: "user", uuid: "summary-1", parentUuid: "b1", message: { role: "user", content: "..." } }),
    ].join("\n"));

    expect((await readCompactions(path)).get("summary-1")?.preTokens).toBe(384281);
  });

  it("answers an empty map for a file that is not there", async () => {
    expect((await readCompactions("/nonexistent/session.jsonl")).size).toBe(0);
  });
});

describe("applyCompactions", () => {
  const info: CompactionInfo = { trigger: "auto", preTokens: 100, postTokens: 10, savedTokens: 90 };

  it("stamps the matching message and leaves the others alone", () => {
    const messages = [{ id: "a" }, { id: "summary-1" }, { id: "b" }] as { id: string; compaction?: CompactionInfo }[];

    applyCompactions(messages, new Map([["summary-1", info]]));

    expect(messages[0]!.compaction).toBeUndefined();
    expect(messages[1]!.compaction).toEqual(info);
    expect(messages[2]!.compaction).toBeUndefined();
  });

  it("does nothing with an empty map", () => {
    const messages = [{ id: "a" }] as { id: string; compaction?: CompactionInfo }[];
    applyCompactions(messages, new Map());
    expect(messages[0]!.compaction).toBeUndefined();
  });
});
