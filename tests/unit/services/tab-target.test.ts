import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTabTarget } from "../../../src/services/tab-tools-mcp/tab-target.ts";

describe("tab tool targets", () => {
  let root: string, project: string, outside: string;
  const binding = () => ({ sessionId: "s1", projectPath: project, projectName: "demo" });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ppm-tab-target-"));
    project = join(root, "project");
    outside = join(root, "outside");
    mkdirSync(join(project, "site"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(project, "site", "report.html"), "<p>r</p>");
    writeFileSync(join(project, "notes.md"), "# n");
    writeFileSync(join(outside, "page.HTM"), "<p>o</p>");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names a project file relative to the project, the way the explorer does", async () => {
    for (const input of ["site/report.html", join(project, "site", "report.html"), "./site/../site/report.html"]) {
      expect(await resolveTabTarget(input, binding())).toEqual({
        ok: true, target: { filePath: "site/report.html", projectName: "demo", displayPath: "site/report.html", html: true },
      });
    }
    expect(await resolveTabTarget("notes.md", binding())).toMatchObject({ ok: true, target: { filePath: "notes.md", html: false } });
  });

  it("names any other file by its absolute path, with no project", async () => {
    const path = join(outside, "page.HTM");
    expect(await resolveTabTarget(path, binding())).toEqual({
      ok: true, target: { filePath: path, projectName: null, displayPath: path, html: true },
    });
    // A link inside the project that leads out of it is not a project file.
    symlinkSync(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(await resolveTabTarget("linked/page.HTM", binding())).toMatchObject({ ok: true, target: { filePath: join(project, "linked", "page.HTM"), projectName: null } });
  });

  it("explains a missing file, a folder, a relative path with no project and a bad argument", async () => {
    const missing = await resolveTabTarget("site/nope.html", binding());
    expect(missing).toEqual({ ok: false, error: `There is no file at ${join(project, "site", "nope.html")}. Write the file first, then call again.` });
    expect(await resolveTabTarget("site", binding())).toMatchObject({ ok: false, error: expect.stringContaining("is a folder") });
    expect(await resolveTabTarget("notes.md", { sessionId: "s1", projectPath: null, projectName: null }))
      .toMatchObject({ ok: false, error: expect.stringContaining("must be absolute") });
    for (const input of [undefined, 42, "", "   ", "a\0b", "x".repeat(5000)]) {
      expect((await resolveTabTarget(input, binding())).ok).toBe(false);
    }
  });

  it("refuses the PPM directory, directly or through a link", async () => {
    const secret = join(process.env.PPM_HOME!, "tab-target-secret.html");
    writeFileSync(secret, "<p>secret</p>");
    try {
      expect(await resolveTabTarget(secret, binding())).toMatchObject({ ok: false, error: expect.stringContaining("PPM does not open") });
      try {
        symlinkSync(secret, join(project, "innocent.html"));
      } catch {
        return; // link creation needs privileges on some hosts
      }
      expect(await resolveTabTarget("innocent.html", binding())).toMatchObject({ ok: false, error: expect.stringContaining("PPM does not open") });
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it("refuses a path before it reaches the disk, so a missing file in the PPM directory is refused too", async () => {
    // Looked up first, it answered "There is no file" here and "PPM does not open" for a file that exists.
    expect(await resolveTabTarget(join(process.env.PPM_HOME!, "no-such-page.html"), binding()))
      .toMatchObject({ ok: false, error: expect.stringContaining("keeps private") });
  });

  it.if(process.platform === "win32")("refuses a UNC path without connecting to it", async () => {
    // Resolving it would open an SMB session to that host, and hand it the user's NTLM hash.
    expect(await resolveTabTarget("\\\\ppm-tab-target.invalid\\share\\page.html", binding()))
      .toMatchObject({ ok: false, error: expect.stringContaining("not on one of this machine's drives") });
  });
});
