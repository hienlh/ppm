import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseSha256Sums,
  sha256File,
  verifyChecksum,
} from "../../../src/services/binary-upgrade-verify.ts";

let dir: string;
let filePath: string;
let knownHash: string;
const CONTENT = "ppm-fixture-payload\n";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-verify-"));
  filePath = join(dir, "archive.tar.gz");
  writeFileSync(filePath, CONTENT);
  knownHash = createHash("sha256").update(CONTENT).digest("hex");
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("sha256File", () => {
  it("computes the file hash", () => {
    expect(sha256File(filePath)).toBe(knownHash);
  });
});

describe("verifyChecksum", () => {
  it("passes for the correct hash", () => {
    expect(() => verifyChecksum(filePath, knownHash)).not.toThrow();
  });
  it("is case-insensitive on the expected hash", () => {
    expect(() => verifyChecksum(filePath, knownHash.toUpperCase())).not.toThrow();
  });
  it("throws on mismatch", () => {
    expect(() => verifyChecksum(filePath, "0".repeat(64))).toThrow(/checksum mismatch/);
  });
  it("throws on missing/blank expected hash", () => {
    expect(() => verifyChecksum(filePath, null)).toThrow(/SHA256SUMS missing/);
  });
});

describe("parseSha256Sums", () => {
  const text = [
    `${"a".repeat(64)}  ppm-linux-x64.tar.gz`,
    `${"b".repeat(64)}  ppm-windows-x64.zip`,
    `${"c".repeat(64)} *ppm-darwin-arm64.tar.gz`, // binary-mode marker + single space
  ].join("\n");

  it("returns the hash for a present filename", () => {
    expect(parseSha256Sums(text, "ppm-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(parseSha256Sums(text, "ppm-windows-x64.zip")).toBe("b".repeat(64));
  });
  it("tolerates single-space + binary marker", () => {
    expect(parseSha256Sums(text, "ppm-darwin-arm64.tar.gz")).toBe("c".repeat(64));
  });
  it("returns null for an absent filename", () => {
    expect(parseSha256Sums(text, "not-present.tar.gz")).toBeNull();
  });
  it("returns null on empty/garbage input", () => {
    expect(parseSha256Sums("", "x.tar.gz")).toBeNull();
    expect(parseSha256Sums("garbage line without hash", "x.tar.gz")).toBeNull();
  });
});
