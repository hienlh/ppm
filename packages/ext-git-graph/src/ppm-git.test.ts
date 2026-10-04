import { describe, expect, test } from "bun:test";
import { gitRouteUrl, ppmRepoFor, remoteWeb, remoteWebBase, repoParam } from "./ppm-git.ts";

describe("which repository a panel's routes address", () => {
  test("the project root itself carries no repo parameter", () => {
    expect(repoParam("/home/u/app", "/home/u/app")).toBeNull();
    expect(repoParam("/home/u/app/", "/home/u/app")).toBeNull();
    expect(repoParam("C:\\work\\app", "C:/work/app")).toBeNull();
  });

  test("a repository inside the project is named by its absolute path", () => {
    expect(repoParam("/home/u/ws", "/home/u/ws/api")).toBe("/home/u/ws/api");
  });

  test("the URL is byte-identical to every other surface's for an ordinary project", () => {
    expect(gitRouteUrl("http://localhost:8080", { projectName: "app", repo: null }, "/changes"))
      .toBe("http://localhost:8080/api/project/app/git/changes");
  });

  test("names and paths are encoded", () => {
    expect(gitRouteUrl("", { projectName: "my app", repo: "/w/a b" }, "/stash/apply"))
      .toBe("/api/project/my%20app/git/stash/apply?repo=%2Fw%2Fa%20b");
  });

  test("the innermost project containing the repository owns it", () => {
    const projects = [
      { name: "ws", path: "/home/u/ws" },
      { name: "api", path: "/home/u/ws/api" },
    ];
    expect(ppmRepoFor(projects, "/home/u/ws/api")).toEqual({ projectName: "api", repo: null });
    expect(ppmRepoFor(projects, "/home/u/ws/web")).toEqual({ projectName: "ws", repo: "/home/u/ws/web" });
  });

  test("a repository outside every project is not guessed at", () => {
    // The basename fallback `resolveProject` keeps would build URLs for a
    // project that does not exist; here that is an error instead.
    expect(ppmRepoFor([{ name: "app", path: "/home/u/app" }], "/srv/other")).toBeNull();
    expect(ppmRepoFor([{ name: "app", path: "/home/u/app" }], "/home/u/app2")).toBeNull();
  });
});

describe("where a commit opens in a browser", () => {
  test("ssh and https remotes name the same page", () => {
    const page = "https://github.com/hienlh/ppm";
    expect(remoteWebBase("git@github.com:hienlh/ppm.git")).toBe(page);
    expect(remoteWebBase("ssh://git@github.com/hienlh/ppm.git")).toBe(page);
    expect(remoteWebBase("ssh://git@github.com:22/hienlh/ppm")).toBe(page);
    expect(remoteWebBase("https://github.com/hienlh/ppm.git")).toBe(page);
    expect(remoteWebBase("https://github.com/hienlh/ppm/")).toBe(page);
  });

  test("credentials in an https remote never reach the page URL", () => {
    expect(remoteWebBase("https://user:s3cret@github.com/hienlh/ppm.git")).toBe("https://github.com/hienlh/ppm");
  });

  test("an http remote keeps its scheme and port", () => {
    expect(remoteWebBase("http://gitea.lan:3000/team/app.git")).toBe("http://gitea.lan:3000/team/app");
  });

  test("a path is not a web page", () => {
    expect(remoteWebBase("/srv/git/app.git")).toBeNull();
    expect(remoteWebBase("../remote.git")).toBeNull();
    expect(remoteWebBase("file:///srv/git/app.git")).toBeNull();
    expect(remoteWebBase("C:/repos/app.git")).toBeNull();
    expect(remoteWebBase("C:\\repos\\app.git")).toBeNull();
    expect(remoteWebBase("https://github.com/")).toBeNull();
  });

  test("each host's commit page", () => {
    expect(remoteWeb("git@github.com:a/b.git")).toEqual({ base: "https://github.com/a/b", commitPath: "/commit/", label: "GitHub" });
    expect(remoteWeb("git@gitlab.com:g/sub/b.git")).toEqual({ base: "https://gitlab.com/g/sub/b", commitPath: "/-/commit/", label: "GitLab" });
    expect(remoteWeb("https://bitbucket.org/a/b.git")).toEqual({ base: "https://bitbucket.org/a/b", commitPath: "/commits/", label: "Bitbucket" });
    expect(remoteWeb("https://git.example.com/a/b.git")?.label).toBe("remote");
    expect(remoteWeb("/srv/git/b.git")).toBeNull();
  });
});
