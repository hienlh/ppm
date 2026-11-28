/**
 * PPM's copies of report-card files: copied when the report is filed (a later change to the file
 * does not reach the card), typed by their bytes not their name, refused when a text file holds a
 * vault value, and staged as a whole: the first refused file stops the report and removes nothing
 * it should keep.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cardFilePath, readCardFile, removeCardFile, storeCardFile } from "../../../src/services/assistant-cards/card-files-store.ts";
import { discardStagedFiles, stageReportFiles } from "../../../src/services/assistant-cards/card-file-staging.ts";
import { sniffCardFile, telegramFilePlan } from "../../../src/shared/card-files.ts";
import { turnSecretScrubber } from "../../../src/services/vault/turn-secret-scrubber.ts";
import { assistantPrivateScope } from "../../../src/services/assistant/assistant-private-paths.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isomiso2")]);

let project: string;
const roots = () => ({ projectPath: project, allowedDirs: [], scope: assistantPrivateScope({ projectRoots: [project], roots: [getPpmDir()] }) });

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "card-files-store-"));
  mkdirSync(join(project, "out"), { recursive: true });
});
afterAll(() => rmSync(project, { recursive: true, force: true }));
afterEach(() => turnSecretScrubber.clear());

describe("storeCardFile", () => {
  it("keeps a copy: changing or deleting the original afterwards does not reach the card", async () => {
    const src = join(project, "out", "clip.mp4");
    writeFileSync(src, Buffer.concat([Buffer.from(MP4), Buffer.from("first version")]));
    const stored = await storeCardFile(src, "clip.mp4", project);
    writeFileSync(src, "rewritten after the report");
    rmSync(src);
    expect(readFileSync(cardFilePath(stored.id)).toString()).toContain("first version");
    expect(stored.kind).toBe("video");
    expect(stored.mime).toBe("video/mp4");
    expect(stored.sha256).toBe(createHash("sha256").update(readFileSync(cardFilePath(stored.id))).digest("hex"));
    expect((await readCardFile(stored.id))?.name).toBe("clip.mp4");
    await removeCardFile(stored.id);
    expect(await readCardFile(stored.id)).toBeNull();
    expect(existsSync(cardFilePath(stored.id))).toBe(false);
  });

  it("types a file by its bytes: a picture named .txt is a picture, HTML named .png is not", async () => {
    const pic = join(project, "out", "picture.txt");
    writeFileSync(pic, PNG);
    const fake = join(project, "out", "page.png");
    writeFileSync(fake, "<html><script>alert(1)</script></html>");
    const a = await storeCardFile(pic, "picture.txt", project);
    const b = await storeCardFile(fake, "page.png", project);
    expect([a.kind, a.mime]).toEqual(["image", "image/png"]);
    expect([b.kind, b.mime]).toEqual(["other", "application/octet-stream"]);
    await removeCardFile(a.id);
    await removeCardFile(b.id);
  });

  it("refuses a text file holding a vault value read in a chat, and keeps nothing of it", async () => {
    turnSecretScrubber.hold("chat-1", [{ name: "prod-db", value: "s3cr3t-Pa55word-XYZ" }]);
    const src = join(project, "out", "notes.txt");
    writeFileSync(src, "connect with s3cr3t-Pa55word-XYZ please");
    await expect(storeCardFile(src, "notes.txt", project)).rejects.toThrow(/vault item "prod-db"/);
    const left = existsSync(join(getPpmDir(), "card-files")) ? readdirSync(join(getPpmDir(), "card-files")) : [];
    expect(left.some((n) => n.endsWith(".part"))).toBe(false);
  });
});

describe("stageReportFiles", () => {
  it("copies each file once, however many spellings name it", async () => {
    writeFileSync(join(project, "out", "a.pdf"), "%PDF-1.7 body");
    const staged = await stageReportFiles(["out/a.pdf", join(project, "out", "a.pdf")], roots());
    expect(staged.copied).toHaveLength(1);
    const first = staged.byPath.get("out/a.pdf");
    expect(first && "id" in first ? first.kind : null).toBe("pdf");
    expect(staged.byPath.get(join(project, "out", "a.pdf"))).toEqual(first);
    await discardStagedFiles(staged.copied);
    expect(await readCardFile(staged.copied[0]!)).toBeNull();
  });

  it("stops at the first refused file and copies nothing after it", async () => {
    writeFileSync(join(project, "out", "ok.zip"), "PK zip");
    writeFileSync(join(project, ".env"), "TOKEN=1");
    const stored: string[] = [];
    const staged = await stageReportFiles(["out/ok.zip", ".env", "out/ok.zip"], roots(), {
      store: async (realPath, name, projectPath) => {
        const s = await storeCardFile(realPath, name, projectPath);
        stored.push(s.id);
        return s;
      },
    });
    const refused = staged.byPath.get(".env");
    expect(refused && "error" in refused ? refused.error : "").toContain("environment file");
    expect(stored).toHaveLength(1);
    await discardStagedFiles(staged.copied);
  });
});

describe("sniffCardFile and telegramFilePlan", () => {
  it("names pictures, videos, PDFs, and calls SVG and HEIC other", () => {
    expect(sniffCardFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).kind).toBe("image");
    expect(sniffCardFile(Buffer.from("GIF89a....")).mime).toBe("image/gif");
    expect(sniffCardFile(Buffer.from("RIFF....WEBPVP8 ")).mime).toBe("image/webp");
    expect(sniffCardFile(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])).mime).toBe("video/webm");
    expect(sniffCardFile(Buffer.from("\0\0\0\x14ftypqt  ")).mime).toBe("video/quicktime");
    expect(sniffCardFile(Buffer.from("\0\0\0\x18ftypheic")).kind).toBe("other");
    expect(sniffCardFile(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")).kind).toBe("other");
    expect(sniffCardFile(Buffer.from("%PDF-1.4")).kind).toBe("pdf");
  });

  it("sends every file as a document, and compresses or refuses one past 50 MB", () => {
    const MB = 1024 * 1024;
    // The original, byte for byte: never sendPhoto (re-encoded) or sendVideo.
    for (const kind of ["image", "video", "pdf", "other"] as const) {
      expect(telegramFilePlan({ kind, size: 27 * MB }, true).method).toBe("sendDocument");
    }
    expect(telegramFilePlan({ kind: "video", size: 80 * MB }, true).method).toBe("compress");
    expect(telegramFilePlan({ kind: "video", size: 80 * MB }, false).method).toBe("too_large");
    expect(telegramFilePlan({ kind: "other", size: 80 * MB }, true).method).toBe("too_large");
    expect(telegramFilePlan({ kind: "image", size: 80 * MB }, true).method).toBe("too_large");
  });
});
