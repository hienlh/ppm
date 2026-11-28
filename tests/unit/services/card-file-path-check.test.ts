/**
 * Which files a manager may attach to a report card: inside its project or a folder the user
 * allowed, never `..` out of them, never through a link out of them, never PPM's own folder or a
 * credential store, never a secret by its name, only an ordinary non-empty file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkReportFilePath, secretFileNameReason } from "../../../src/services/assistant-cards/card-file-path-check.ts";
import { assistantPrivateScope } from "../../../src/services/assistant/assistant-private-paths.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

let root: string;
let project: string;
let outside: string;
let allowed: string;
let home: string;

/** A link at `link` to `target`; false when this machine may not make one (Windows without the right). */
function tryLink(target: string, link: string, type: "file" | "junction"): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "card-file-check-"));
  project = join(root, "project");
  outside = join(root, "outside");
  allowed = join(root, "renders");
  home = join(root, "home");
  for (const d of [project, join(project, "out"), join(project, ".git"), outside, allowed, join(home, ".ssh"), join(home, ".aws")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, "out", "clip.mp4"), "video bytes");
  writeFileSync(join(project, "out", "empty.bin"), "");
  writeFileSync(join(project, ".env"), "SECRET=1");
  writeFileSync(join(project, ".env.production"), "SECRET=1");
  writeFileSync(join(project, "deploy.pem"), "-----BEGIN PRIVATE KEY-----");
  writeFileSync(join(project, ".git", "config"), "[remote]\n url = https://token@github.com/x");
  writeFileSync(join(outside, "secret.txt"), "not yours");
  writeFileSync(join(allowed, "final.mp4"), "rendered");
  writeFileSync(join(home, ".ssh", "notes.txt"), "keys");
  writeFileSync(join(home, ".aws", "report.pdf"), "creds");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const roots = (extra: Partial<Parameters<typeof checkReportFilePath>[1]> = {}) => ({
  projectPath: project,
  allowedDirs: [allowed],
  // The credential stores of a fake home folder, and PPM's own folder as the test run has it.
  scope: assistantPrivateScope({ projectRoots: [project, allowed], home, roots: [getPpmDir(), join(home, ".ssh"), join(home, ".aws")] }),
  ...extra,
});

describe("checkReportFilePath", () => {
  it("takes a file inside the project, by absolute or relative path", () => {
    const abs = checkReportFilePath(join(project, "out", "clip.mp4"), roots());
    expect(abs.ok).toBe(true);
    if (abs.ok) {
      expect(abs.name).toBe("clip.mp4");
      expect(abs.size).toBe("video bytes".length);
    }
    expect(checkReportFilePath("out/clip.mp4", roots()).ok).toBe(true);
  });

  it("takes a file in a folder the user allowed, and refuses it once the folder is not listed", () => {
    expect(checkReportFilePath(join(allowed, "final.mp4"), roots()).ok).toBe(true);
    const refused = checkReportFilePath(join(allowed, "final.mp4"), roots({ allowedDirs: [] }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("outside this project's folder");
  });

  it("refuses a file outside the allowed folders, and `..` that climbs out of the project", () => {
    expect(checkReportFilePath(join(outside, "secret.txt"), roots()).ok).toBe(false);
    const climbed = checkReportFilePath("../outside/secret.txt", roots());
    expect(climbed.ok).toBe(false);
    if (!climbed.ok) expect(climbed.error).toContain("outside");
    expect(checkReportFilePath(join(project, "out", "..", "..", "outside", "secret.txt"), roots()).ok).toBe(false);
  });

  it("refuses PPM's own folder even when an allowed folder holds it", () => {
    const ppmFile = join(getPpmDir(), "ppm-secret-probe.txt");
    writeFileSync(ppmFile, "config");
    try {
      const r = checkReportFilePath(ppmFile, roots({ allowedDirs: [dirname(getPpmDir())] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("private folder");
    } finally {
      rmSync(ppmFile, { force: true });
    }
  });

  it("refuses ~/.ssh and ~/.aws even when the home folder is the project", () => {
    const asHome = roots({
      projectPath: home, allowedDirs: [],
      scope: assistantPrivateScope({ projectRoots: [home], home, roots: [getPpmDir(), join(home, ".ssh"), join(home, ".aws")] }),
    });
    expect(checkReportFilePath(join(home, ".ssh", "notes.txt"), asHome).ok).toBe(false);
    expect(checkReportFilePath(join(home, ".aws", "report.pdf"), asHome).ok).toBe(false);
  });

  it("refuses .env files, keys and anything under .git by name", () => {
    for (const p of [".env", ".env.production", "deploy.pem", ".git/config"]) {
      const r = checkReportFilePath(p, roots());
      expect(r.ok).toBe(false);
    }
  });

  it("refuses a folder, an empty file and a missing file", () => {
    expect(checkReportFilePath("out", roots()).ok).toBe(false);
    expect(checkReportFilePath("out/empty.bin", roots()).ok).toBe(false);
    const missing = checkReportFilePath("out/nope.mp4", roots());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("no such file");
  });

  it("refuses a link inside the project that points out of it", () => {
    // A folder link (a junction on Windows needs no special right).
    const dirLink = join(project, "linked-dir");
    // Folder links need no special right anywhere, so this case always runs.
    expect(tryLink(outside, dirLink, "junction")).toBe(true);
    const r = checkReportFilePath(join(dirLink, "secret.txt"), roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("link to a file outside");
    const fileLink = join(project, "out", "innocent.txt");
    if (tryLink(join(outside, "secret.txt"), fileLink, "file")) {
      expect(checkReportFilePath(fileLink, roots()).ok).toBe(false);
    }
  });

  it("refuses a link inside the project that points into PPM's folder", () => {
    const ppmFile = join(getPpmDir(), "ppm-link-probe.txt");
    writeFileSync(ppmFile, "config");
    const link = join(project, "out", "looks-fine.txt");
    try {
      if (tryLink(ppmFile, link, "file")) expect(checkReportFilePath(link, roots()).ok).toBe(false);
      const dirLink = join(project, "ppm-dir-link");
      if (tryLink(getPpmDir(), dirLink, "junction")) expect(checkReportFilePath(join(dirLink, "ppm-link-probe.txt"), roots()).ok).toBe(false);
    } finally {
      rmSync(ppmFile, { force: true });
    }
  });

  it("refuses UNC paths and paths with control characters without touching the disk", () => {
    if (process.platform === "win32") expect(checkReportFilePath("\\\\server\\share\\clip.mp4", roots()).ok).toBe(false);
    expect(checkReportFilePath("out/clip.mp4\nx", roots()).ok).toBe(false);
    expect(checkReportFilePath("", roots()).ok).toBe(false);
    expect(checkReportFilePath(42, roots()).ok).toBe(false);
  });
});

describe("secretFileNameReason", () => {
  it("names environment files, keys, credential files and secret folders", () => {
    for (const p of ["/a/.env", "/a/.env.local", "/a/prod.env", "/a/id_rsa", "/a/id_ed25519.pub", "/a/cert.p12", "/a/.npmrc",
      "/a/credentials.json", "/a/.git/HEAD", "/a/x/.ssh/config", "C:\\a\\.aws\\credentials", "/a/state.tfstate"]) {
      expect(secretFileNameReason(p)).not.toBeNull();
    }
  });

  it("lets ordinary files through", () => {
    for (const p of ["/a/clip.mp4", "/a/report.pdf", "/a/photo.JPG", "/a/build.zip", "/a/environment.md", "/a/keynote.key.txt"]) {
      expect(secretFileNameReason(p)).toBeNull();
    }
  });
});
