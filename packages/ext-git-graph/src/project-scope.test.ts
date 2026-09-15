import { describe, expect, test } from "bun:test";
import { pickProject, toProjectRelative } from "./project-scope.ts";

const projects = [
  { name: "workspace", path: "/home/me/work" },
  { name: "inner", path: "/home/me/work/inner" },
  { name: "other", path: "/home/me/other" },
];

describe("pickProject", () => {
  test("matches a project by its own path", () => {
    expect(pickProject(projects, "/home/me/other")?.name).toBe("other");
  });

  test("finds the project containing a repository one level down", () => {
    // The whole point: a panel is opened on the repository, and the project it
    // belongs to is what every API route and tab is keyed by.
    expect(pickProject(projects, "/home/me/work/service-a")?.name).toBe("workspace");
  });

  test("prefers the innermost project when they nest", () => {
    expect(pickProject(projects, "/home/me/work/inner/pkg")?.name).toBe("inner");
  });

  test("does not match a sibling that merely shares a prefix", () => {
    expect(pickProject(projects, "/home/me/work-evil/repo")).toBeNull();
  });

  test("ignores a trailing separator on either side", () => {
    expect(pickProject([{ name: "w", path: "/home/me/work/" }], "/home/me/work")?.name).toBe("w");
  });

  test("treats a Windows path the same as a POSIX one", () => {
    const win = [{ name: "w", path: "C:\\Users\\me\\work" }];
    expect(pickProject(win, "C:\\Users\\me\\work\\service-a")?.name).toBe("w");
  });

  test("answers null when nothing owns the path", () => {
    expect(pickProject(projects, "/tmp/elsewhere")).toBeNull();
  });
});

describe("toProjectRelative", () => {
  test("is the identity when the repository is the project", () => {
    // Every ordinary project takes this path, so it must not be able to change.
    expect(toProjectRelative("/home/me/work", "/home/me/work", "src/index.ts")).toBe("src/index.ts");
  });

  test("prefixes the repository's own directory when it is nested", () => {
    expect(toProjectRelative("/home/me/work", "/home/me/work/service-a", "src/index.ts")).toBe(
      "service-a/src/index.ts",
    );
  });

  test("keeps a repository two levels down whole", () => {
    expect(toProjectRelative("/home/me/work", "/home/me/work/apps/api", "main.go")).toBe(
      "apps/api/main.go",
    );
  });

  test("strips a leading ./ and normalises separators", () => {
    expect(toProjectRelative("/home/me/work", "/home/me/work/svc", "./src\\a.ts")).toBe(
      "svc/src/a.ts",
    );
  });

  test("leaves the path alone when the repository is not inside the project", () => {
    // A worktree opened from outside the project: there is no prefix that would
    // make the path meaningful, and inventing one would name a file that is not
    // there.
    expect(toProjectRelative("/home/me/work", "/tmp/wt", "src/index.ts")).toBe("src/index.ts");
  });

  test("answers the repository directory itself for an empty path", () => {
    expect(toProjectRelative("/home/me/work", "/home/me/work/svc", "")).toBe("svc");
  });
});
