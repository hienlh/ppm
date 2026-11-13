import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveProjectSearchGrep, resolveProjectSearchTool } from "../../../src/services/project-content-search.service";

// The search itself runs in the search host now: tests/unit/services/content-search/.
describe("project content search tool", () => {
  test("finds GNU grep bundled with Git when grep is absent from PATH", async () => {
    const root = tmpdir();
    const git = resolve(root, "Git/cmd/git.exe");
    const expected = resolve(root, "Git/usr/bin/grep.exe");
    expect(await resolveProjectSearchGrep({ platform: "win32", which: (name) => name === "git" ? git : null,
      exists: async (path) => path === expected, programFiles: "", programFilesX86: "" })).toBe(expected);
  });
  test("prefers ripgrep, falls back to grep, and reports having neither", async () => {
    const which = (found: Record<string, string>) => (name: string) => found[name] ?? null;
    expect(await resolveProjectSearchTool({ which: which({ rg: "/bin/rg", grep: "/bin/grep" }) })).toEqual({ kind: "rg", path: "/bin/rg" });
    expect(await resolveProjectSearchTool({ which: which({ grep: "/bin/grep" }) })).toEqual({ kind: "grep", path: "/bin/grep" });
    expect(await resolveProjectSearchTool({ platform: "linux", which: which({}) })).toBeUndefined();
  });
});
