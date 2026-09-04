import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { isAllowedPath, readSystemFileSync } from "../../../src/services/fs-browse.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { ensureUploadsDir } from "../../../src/services/chat-upload-storage.service.ts";

const isWin = process.platform === "win32";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-allowlist-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isAllowedPath — re-exported guard", () => {
  it("allows any absolute path now that the scope is the whole disk", () => {
    expect(isAllowedPath(isWin ? "C:\\Windows\\System32" : "/etc")).toBe(true);
    expect(isAllowedPath(homedir())).toBe(true);
  });

  it("still allows SDK background-command output files", () => {
    expect(
      isAllowedPath("/var/folders/73/xx/T/claude/-Users-x-proj/sess/tasks/ab.output"),
    ).toBe(true);
  });

  it("rejects relative input", () => {
    expect(isAllowedPath("relative/path.txt")).toBe(false);
  });
});

// The re-exported reader is the blocking variant kept for the project diff route.
describe("readSystemFileSync — PPM directory shield", () => {
  it("refuses to read the config database", () => {
    expect(() => readSystemFileSync(resolve(getPpmDir(), "ppm.db"))).toThrow("Access denied");
  });

  it("refuses a symlink that escapes into the PPM directory", () => {
    const link = join(dir, "escape-link");
    try {
      symlinkSync(getPpmDir(), link, "junction");
    } catch {
      return; // no privilege to create links on this host — nothing to assert
    }
    expect(() => readSystemFileSync(join(link, "ppm.db"))).toThrow("Access denied");
  });

  it("reads an ordinary file", () => {
    const file = join(dir, "hello.txt");
    writeFileSync(file, "hi");
    expect(readSystemFileSync(file).content).toBe("hi");
  });

  // Chat attachments are the one readable subtree of the PPM directory: the
  // editor opens the file the transcript just referenced.
  it("reads a chat attachment despite it living inside the PPM directory", () => {
    const uploads = ensureUploadsDir();
    const file = join(uploads, "fs-allowlist-attachment.txt");
    writeFileSync(file, "attached");
    try {
      expect(readSystemFileSync(file).content).toBe("attached");
    } finally {
      rmSync(file, { force: true });
    }
  });
});
