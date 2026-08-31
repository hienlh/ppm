import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  auditTranscriptImagesFile,
  stripTranscriptImagesFile,
} from "../../src/services/transcript-images-file.ts";
import { MANY_IMAGE_DIMENSION_LIMIT } from "../../src/services/transcript-images.ts";

/** A buffer with a valid PNG header of the given size; the pixel data is irrelevant here. */
function pngBase64(w: number, h: number, padBytes = 0): string {
  const buf = Buffer.alloc(24 + padBytes);
  buf.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf.toString("base64");
}

const imageBlock = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

function toolResultLine(data: string, id = "t1"): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${id}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [imageBlock(data)] }] },
  });
}

function attachmentLine(data: string, id = "a1"): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${id}`,
    message: { role: "user", content: [{ type: "text", text: "look" }, imageBlock(data)] },
  });
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "ppm-strip-"));
  file = resolve(dir, "session.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write lines with a trailing newline, the way the CLI leaves a transcript. */
function writeTranscript(lines: string[], trailingNewline = true): void {
  writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
}

describe("auditTranscriptImagesFile", () => {
  test("measures a transcript without holding it in memory as one string", async () => {
    writeTranscript([
      toolResultLine(pngBase64(800, 600, 200)),
      toolResultLine(pngBase64(2400, 1530, 200), "t2"),
      attachmentLine(pngBase64(4000, 3000, 200)),
    ]);
    const audit = await auditTranscriptImagesFile(file);
    expect(audit.total).toBe(3);
    expect(audit.oversized).toBe(2);
    expect(audit.attachments).toBe(1);
    expect(audit.oversizedAttachments).toBe(1);
    expect(audit.largestSide).toBe(4000);
  });

  test("an empty transcript audits to zero rather than throwing", async () => {
    writeFileSync(file, "");
    const audit = await auditTranscriptImagesFile(file);
    expect(audit.total).toBe(0);
  });
});

describe("stripTranscriptImagesFile", () => {
  test("removes oversized tool images and leaves attachments alone", async () => {
    writeTranscript([
      toolResultLine(pngBase64(800, 600, 200)),
      toolResultLine(pngBase64(2400, 1530, 200), "t2"),
      attachmentLine(pngBase64(4000, 3000, 200)),
    ]);
    const r = await stripTranscriptImagesFile(file, "oversized");
    expect(r.removed).toBe(1);
    expect(r.remaining.oversized).toBe(1); // the attachment still is
    expect(r.remaining.oversizedAttachments).toBe(1);
  });

  test("includeAttachments clears the attachment the API is refusing", async () => {
    writeTranscript([attachmentLine(pngBase64(4000, 3000, 200))]);
    const r = await stripTranscriptImagesFile(file, "oversized", { includeAttachments: true });
    expect(r.removed).toBe(1);
    expect(r.remaining.total).toBe(0);
  });

  test("an image exactly at the cap is removed", async () => {
    writeTranscript([toolResultLine(pngBase64(MANY_IMAGE_DIMENSION_LIMIT, 10, 200))]);
    const r = await stripTranscriptImagesFile(file, "oversized");
    expect(r.removed).toBe(1);
  });

  // The CLI appends to this file. A rewrite that drops the final newline would have the next
  // record glued onto the last one, corrupting both.
  test("preserves the trailing newline", async () => {
    writeTranscript([toolResultLine(pngBase64(2400, 100, 200)), attachmentLine(pngBase64(50, 50))]);
    await stripTranscriptImagesFile(file, "oversized");
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("preserves a missing trailing newline too", async () => {
    writeTranscript([toolResultLine(pngBase64(2400, 100, 200))], false);
    await stripTranscriptImagesFile(file, "oversized");
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(false);
  });

  test("keeps every record and leaves each line valid JSON", async () => {
    const lines = [
      toolResultLine(pngBase64(2400, 100, 200)),
      attachmentLine(pngBase64(60, 60)),
      toolResultLine(pngBase64(2400, 100, 200), "t3"),
    ];
    writeTranscript(lines);
    await stripTranscriptImagesFile(file, "all", { includeAttachments: true });
    const out = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(out.length).toBe(lines.length);
    for (const l of out) expect(() => JSON.parse(l)).not.toThrow();
  });

  test("a no-op strip leaves the file untouched", async () => {
    writeTranscript([toolResultLine(pngBase64(100, 100, 200))]);
    const before = readFileSync(file, "utf8");
    const mtimeBefore = statSync(file).mtimeMs;
    const r = await stripTranscriptImagesFile(file, "oversized");
    expect(r.removed).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  test("a malformed line survives byte-for-byte", async () => {
    writeFileSync(file, `garbage {not json\n${toolResultLine(pngBase64(2400, 100, 200))}\n`);
    await stripTranscriptImagesFile(file, "all");
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe("garbage {not json");
  });

  /**
   * Rewriting a transcript while the CLI is still appending silently drops whatever it wrote
   * in between, which breaks the parentUuid chain and hides the conversation from that point
   * back. Losing a turn is far worse than refusing to clean up, so the write is abandoned.
   */
  test("refuses to write when the transcript grew during the rewrite", async () => {
    writeTranscript([toolResultLine(pngBase64(2400, 100, 4000))]);
    const before = readFileSync(file, "utf8");

    const inFlight = stripTranscriptImagesFile(file, "all");
    appendFileSync(file, `${attachmentLine(pngBase64(70, 70), "late")}\n`);

    await expect(inFlight).rejects.toThrow(/still running|changed while/i);
    // The appended record is still there and the original content was not replaced.
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.includes("u-late")).toBe(true);
  });
});
