/**
 * `report_to_assistant { files }`: the field's shape, the copies PPM made carried on the card, a
 * refused file refusing the whole report, and a report attaching the same file (by name and
 * content, not by copy id) counting as the same report.
 */
import { describe, expect, it } from "bun:test";
import { fileReport, reportFieldError, reportToolDefinition, sameReport, type ReportEnv } from "../../../src/services/assistant-cards/manager-report-tool.ts";
import type { NewCard } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import type { AssistantCard, CardFile } from "../../../src/shared/assistant-cards.ts";
import { REPORT_FILES_MAX } from "../../../src/shared/card-files.ts";

const caller = { sessionId: "mgr-1", projectName: "api", projectPath: "/p/api" };
const clip: CardFile = { id: "a".repeat(32), name: "clip.mp4", size: 27 * 1024 * 1024, kind: "video", mime: "video/mp4", sha256: "1".repeat(64) };
const pdf: CardFile = { id: "b".repeat(32), name: "spec.pdf", size: 1000, kind: "pdf", mime: "application/pdf", sha256: "2".repeat(64) };

function env(files: Record<string, CardFile | { error: string }>, withFiles = true) {
  const made: NewCard[] = [];
  const e: ReportEnv = {
    now: () => 1_000_000,
    countSince: () => 0,
    openUrgentTitled: () => null,
    openIdentical: (_s, card) => {
      const same = made.find((m) => sameReport(m, card));
      return same ? ({ id: "card-1", kind: same.kind } as AssistantCard) : null;
    },
    quietWindowStart: () => null,
    digestAnswer: () => ({ ok: false, message: "no" }),
    create: (card) => { made.push(card); return { id: `card-${made.length}` } as AssistantCard; },
    ...(withFiles ? { fileFor: (path: string) => files[path] ?? { error: `${path}: no such file` } } : {}),
  };
  return { env: e, made };
}

describe("the files field", () => {
  it("is a list of 1 to 6 paths, and never goes with digest", () => {
    expect(reportFieldError({ kind: "done", title: "x", files: [] })).toContain("1 to");
    expect(reportFieldError({ kind: "done", title: "x", files: Array(REPORT_FILES_MAX + 1).fill("a") })).toContain("1 to");
    expect(reportFieldError({ kind: "done", title: "x", files: [42] })).toContain("path");
    expect(reportFieldError({ kind: "done", title: "x", files: ["  "] })).toContain("path");
    expect(reportFieldError({ kind: "digest", title: "x", items: [], files: ["a"] })).toContain("digest");
    expect(reportFieldError({ kind: "done", title: "x", files: ["out/clip.mp4"] })).toBeNull();
  });

  it("puts PPM's copies on the card, each once", () => {
    const { env: e, made } = env({ "out/clip.mp4": clip, "C:/p/api/out/clip.mp4": clip, "spec.pdf": pdf });
    const r = fileReport(e, caller, { kind: "done", title: "Clip ready", files: ["out/clip.mp4", "C:/p/api/out/clip.mp4", "spec.pdf"] });
    expect(r.ok).toBe(true);
    expect(made[0]!.payload?.files).toEqual([clip, pdf]);
  });

  it("refuses the whole report when one file is refused, naming why", () => {
    const { env: e, made } = env({ "out/clip.mp4": clip, ".env": { error: "\".env\" cannot be attached: it is an environment file" } });
    const r = fileReport(e, caller, { kind: "needs_decision", title: "Ship?", files: ["out/clip.mp4", ".env"] });
    expect(r).toEqual({ ok: false, message: "\".env\" cannot be attached: it is an environment file" });
    expect(made).toHaveLength(0);
  });

  it("is refused where files are not taken", () => {
    const { env: e } = env({}, false);
    const r = fileReport(e, caller, { kind: "done", title: "x", files: ["a.zip"] });
    expect(r.ok).toBe(false);
  });

  it("counts the same file (name, size and content) as the same report, whatever the copy's id", () => {
    const again = { ...clip, id: "c".repeat(32) };
    const first = env({ "out/clip.mp4": clip });
    fileReport(first.env, caller, { kind: "done", title: "Clip ready", files: ["out/clip.mp4"] });
    const second = fileReport({ ...first.env, fileFor: () => again }, caller, { kind: "done", title: "Clip ready", files: ["out/clip.mp4"] });
    expect(second.ok && second.cardId).toBe("card-1");
    expect(first.made).toHaveLength(1);
    const changed = fileReport({ ...first.env, fileFor: () => ({ ...again, sha256: "9".repeat(64) }) }, caller, { kind: "done", title: "Clip ready", files: ["out/clip.mp4"] });
    expect(changed.ok && changed.cardId).toBe("card-2");
  });

  it("is described in the tool's schema", () => {
    const def = reportToolDefinition();
    const files = (def.inputSchema.properties as Record<string, { maxItems?: number; description?: string }>).files;
    expect(files?.maxItems).toBe(REPORT_FILES_MAX);
    expect(files?.description).toContain("Files on cards");
  });
});
