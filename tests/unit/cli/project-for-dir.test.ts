/**
 * The project a `ppm` command run without `-p` works in: the registered project whose folder holds
 * the current one. Joined with the platform's own separator and case-blind on Windows, so a
 * subfolder of `C:\Work\app` is found there and not only `/`-joined paths.
 */
import { describe, expect, it } from "bun:test";
import { projectForDir } from "../../../src/cli/utils/project-resolver.ts";

const projects = [
  { name: "app", path: "C:\\Work\\app" },
  { name: "lib", path: "C:\\Work\\app\\packages\\lib" },
  { name: "posix", path: "/srv/posix" },
];

describe("projectForDir", () => {
  it("finds a Windows subfolder whatever its case, with backslashes", () => {
    expect(projectForDir("c:\\work\\APP\\src", projects, "win32", "\\")?.name).toBe("app");
    expect(projectForDir("C:\\Work\\app", projects, "win32", "\\")?.name).toBe("app");
  });

  it("prefers the innermost project when projects nest", () => {
    expect(projectForDir("C:\\Work\\app\\packages\\lib\\src", projects, "win32", "\\")?.name).toBe("lib");
  });

  it("does not take a sibling folder sharing a prefix", () => {
    expect(projectForDir("C:\\Work\\app2", projects, "win32", "\\")).toBeUndefined();
    expect(projectForDir("/srv/posix-old", projects, "linux", "/")).toBeUndefined();
  });

  it("stays case-sensitive off Windows", () => {
    expect(projectForDir("/srv/posix/a", projects, "linux", "/")?.name).toBe("posix");
    expect(projectForDir("/srv/POSIX/a", projects, "linux", "/")).toBeUndefined();
  });
});
