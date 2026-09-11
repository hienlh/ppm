/**
 * The UI's side of "this workspace folder is not the repository".
 */
import { describe, it, expect } from "bun:test";
import {
  resolveRepo,
  needsPick,
  hasNoRepo,
  withRepoParam,
  repoRelativePath,
  projectRelativePath,
  commandRunsGit,
  type GitRepoDiscovery,
} from "../../../src/web/lib/git-repo-scope.ts";

const ROOT: GitRepoDiscovery = {
  root: "/ws/one",
  rootIsRepo: true,
  repos: [{ path: "/ws/one", name: "one", relative: "." }],
};

const TWO: GitRepoDiscovery = {
  root: "/ws",
  rootIsRepo: false,
  repos: [
    { path: "/ws/backend", name: "backend", relative: "backend" },
    { path: "/ws/frontend", name: "frontend", relative: "frontend" },
  ],
};

const ONE_SUB: GitRepoDiscovery = {
  root: "/ws",
  rootIsRepo: false,
  repos: [{ path: "/ws/frontend", name: "frontend", relative: "frontend" }],
};

const NONE: GitRepoDiscovery = { root: "/ws", rootIsRepo: false, repos: [] };

describe("resolveRepo", () => {
  it("uses the project root when the root is a repository", () => {
    expect(resolveRepo(ROOT, undefined)?.relative).toBe(".");
    // A stale choice from another project cannot override it.
    expect(resolveRepo(ROOT, "/ws/one/sub")?.relative).toBe(".");
  });

  it("chooses a single candidate without asking", () => {
    // A picker offering one option is a click that cannot go any other way.
    expect(resolveRepo(ONE_SUB, undefined)?.name).toBe("frontend");
    expect(needsPick(ONE_SUB, undefined)).toBe(false);
  });

  it("waits for a choice when there are several", () => {
    expect(resolveRepo(TWO, undefined)).toBeNull();
    expect(needsPick(TWO, undefined)).toBe(true);
    expect(resolveRepo(TWO, "/ws/frontend")?.name).toBe("frontend");
    expect(needsPick(TWO, "/ws/frontend")).toBe(false);
  });

  it("ignores a remembered repository that is no longer there", () => {
    // The choice is device-local and outlives the directory; falling back to a
    // picker is right, silently using the first one is not.
    expect(resolveRepo(TWO, "/ws/deleted")).toBeNull();
    expect(needsPick(TWO, "/ws/deleted")).toBe(true);
  });

  it("says when there is no repository anywhere under the project", () => {
    expect(hasNoRepo(NONE)).toBe(true);
    expect(needsPick(NONE, undefined)).toBe(false);
    expect(resolveRepo(NONE, undefined)).toBeNull();
    expect(hasNoRepo(ROOT)).toBe(false);
    expect(hasNoRepo(undefined)).toBe(false);
  });

  it("resolves to null before the answer arrives", () => {
    expect(resolveRepo(undefined, "/ws/frontend")).toBeNull();
    expect(needsPick(undefined, undefined)).toBe(false);
  });
});

describe("withRepoParam", () => {
  it("leaves a single-repo project's URL exactly as it was", () => {
    // Nothing about the common case may regress on this path.
    const url = "/api/project/one/git/status";
    expect(withRepoParam(url, ROOT.repos[0]!)).toBe(url);
    expect(withRepoParam(url, null)).toBe(url);
  });

  it("adds the parameter with the right separator", () => {
    const repo = TWO.repos[1]!;
    expect(withRepoParam("/git/status", repo)).toBe("/git/status?repo=%2Fws%2Ffrontend");
    expect(withRepoParam("/git/graph?max=50", repo)).toBe("/git/graph?max=50&repo=%2Fws%2Ffrontend");
  });
});

describe("repoRelativePath", () => {
  it("strips the repository's prefix", () => {
    const repo = TWO.repos[1]!;
    expect(repoRelativePath("frontend/src/a.ts", repo)).toBe("src/a.ts");
    expect(repoRelativePath("./frontend/src/a.ts", repo)).toBe("src/a.ts");
  });

  it("passes a path through when the repository is the project root", () => {
    expect(repoRelativePath("src/a.ts", ROOT.repos[0]!)).toBe("src/a.ts");
    expect(repoRelativePath("src/a.ts", null)).toBe("src/a.ts");
  });

  it("refuses a file outside the chosen repository", () => {
    // `git blame -- ../docs/x.md` does not fail usefully: it reports the file
    // as untracked and the annotation shows nothing rather than saying why.
    const repo = TWO.repos[1]!;
    expect(repoRelativePath("docs/x.md", repo)).toBeNull();
    expect(repoRelativePath("backend/src/a.ts", repo)).toBeNull();
    // A sibling whose name merely starts the same must not slip through.
    expect(repoRelativePath("frontend-old/src/a.ts", repo)).toBeNull();
  });

  it("maps the repository's own directory to the empty path", () => {
    expect(repoRelativePath("frontend", TWO.repos[1]!)).toBe("");
  });
});

describe("projectRelativePath", () => {
  it("puts a path git reported back into the project's terms", () => {
    // `git status` inside the repository names files relative to *it*, and a
    // tab's filePath is relative to the project — so opening a changed file
    // without this lands one directory too high on an empty buffer.
    const repo = TWO.repos[1]!;
    expect(projectRelativePath("src/a.ts", repo)).toBe("frontend/src/a.ts");
    expect(projectRelativePath("./src/a.ts", repo)).toBe("frontend/src/a.ts");
    expect(projectRelativePath("", repo)).toBe("frontend");
  });

  it("round-trips with repoRelativePath", () => {
    const repo = TWO.repos[1]!;
    for (const file of ["src/a.ts", "README.md", "a/b/c.txt"]) {
      expect(repoRelativePath(projectRelativePath(file, repo), repo)).toBe(file);
    }
  });

  it("is the identity when the repository is the project root", () => {
    expect(projectRelativePath("src/a.ts", ROOT.repos[0]!)).toBe("src/a.ts");
    expect(projectRelativePath("src/a.ts", null)).toBe("src/a.ts");
  });
});

describe("commandRunsGit", () => {
  it("re-points the git views and nothing else", () => {
    // Every dispatch site hands over one path. A git view has to be given the
    // repository; any other extension was told about a workspace folder and
    // still wants that, so the rewrite is opt-in by namespace.
    expect(commandRunsGit("git-graph.view")).toBe(true);
    expect(commandRunsGit("git-graph.fileHistory")).toBe(true);
    expect(commandRunsGit("hello-world.open")).toBe(false);
    expect(commandRunsGit("")).toBe(false);
  });
});
