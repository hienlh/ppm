import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isCloudflaredDirPath,
  isCredentialPath,
  assertNotPpmDir,
  assertNotPpmSubtree,
  assertNotPpmSubtreeDeep,
  realPathOrSelf,
} from "../../../src/services/fs-path-guard.service.ts";
import { assertReadPermitted } from "../../../src/services/fs-ops/fs-ops-read-write.service.ts";
import { copyPath } from "../../../src/services/fs-ops/fs-ops-copy-move.service.ts";

const cloudflaredDir = resolve(homedir(), ".cloudflared");
// Never create/remove the real dir if cloudflared already put it there — only
// clean up what this test itself creates, so a developer's real login state
// (or a real cert.pem next to it) is left untouched either way.
const dirPreexisted = existsSync(cloudflaredDir);
let markerFile: string;
let scratchDir: string;

beforeAll(() => {
  if (!dirPreexisted) mkdirSync(cloudflaredDir, { recursive: true });
  markerFile = join(cloudflaredDir, "ppm-test-guard-marker.pem");
  writeFileSync(markerFile, "not a real credential — fs-path-guard test fixture");
  scratchDir = mkdtempSync(join(tmpdir(), "fs-path-guard-cf-"));
});

afterAll(() => {
  rmSync(markerFile, { force: true });
  if (!dirPreexisted) rmSync(cloudflaredDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("cloudflared credential shield", () => {
  it("flags the cert path and its subtree", () => {
    expect(isCloudflaredDirPath(resolve(cloudflaredDir, "cert.pem"))).toBe(true);
    expect(isCredentialPath(resolve(cloudflaredDir, "cert.pem"))).toBe(true);
  });

  it("does not flag a path that merely contains the segment name elsewhere", () => {
    // A prefix match against the exact resolved cloudflared dir, not a
    // substring test — a real folder literally named "not-dot-cloudflared"
    // must stay accessible.
    expect(isCloudflaredDirPath(resolve(homedir(), "not-dot-cloudflared", "cert.pem"))).toBe(false);
    expect(isCloudflaredDirPath(resolve(homedir(), "Documents"))).toBe(false);
  });

  it("refuses a direct read of the cert path", () => {
    expect(() => assertNotPpmDir(markerFile)).toThrow("Access denied");
  });

  it("refuses a read through a symlink that resolves into the cloudflared dir", async () => {
    const link = join(scratchDir, "innocuous-name.pem");
    try {
      symlinkSync(markerFile, link);
    } catch {
      return; // no privilege to create file symlinks on this host — nothing to assert
    }
    const real = await realPathOrSelf(link);
    expect(() => assertReadPermitted(link, real)).toThrow("Access denied");
  });

  it("refuses the write/transfer guard on a direct cert path (source or destination)", () => {
    // assertNotPpmSubtree backs every copy/move/rename/upload/trash door —
    // relocating the cert out of ~/.cloudflared would defeat the read shield
    // above via a plain read of the copy.
    expect(() => assertNotPpmSubtree(markerFile)).toThrow(/credential/);
    expect(() => assertNotPpmSubtree(join(scratchDir, "unrelated.txt"))).not.toThrow();
  });

  it("refuses the deep (realpath-following) write/transfer guard through a symlink", async () => {
    const link = join(scratchDir, "escape-link.pem");
    try {
      symlinkSync(markerFile, link);
    } catch {
      return; // no privilege to create file symlinks on this host — nothing to assert
    }
    await expect(assertNotPpmSubtreeDeep(link)).rejects.toThrow(/credential/);
  });

  it("refuses copyPath from the cert path to a public destination", async () => {
    // Regression for the exact reported bypass: POST /api/fs/copy with the
    // cert as source and a readable public path as destination.
    const destination = join(scratchDir, "exfiltrated-cert.pem");
    await expect(copyPath(markerFile, destination)).rejects.toThrow(/credential/);
    expect(existsSync(destination)).toBe(false);
  });
});
