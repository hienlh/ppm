/**
 * `origin/HEAD` is the remote's pointer to its default branch. Git reports it in
 * two places and the graph showed it in both: as a pill beside the branch it
 * points at, and, because `refname:short` shortens it to the bare remote name,
 * as a local branch called "origin".
 */
import { describe, it, expect } from "bun:test";
import { parseBranches } from "./extension.ts";
import { parseGitLog } from "./git-log-parser.ts";

const commitWith = (decorations: string) => [
  "abc123", "def456", "Author", "a@e.x", "1609459200", "Committer", "c@e.x", "1609459200",
  decorations, "Subject", "<END_COMMIT>",
].join("\n");

describe("a remote's HEAD", () => {
  it("is not a pill of its own", () => {
    const [commit] = parseGitLog(commitWith("HEAD -> main, origin/main, origin/HEAD"));
    expect(commit!.refs).toEqual([{ name: "main", type: "head" }, { name: "origin/main", type: "remote" }]);
  });

  it("is not a branch, though git names it after the remote", () => {
    // `git branch -a --format=...|%(symref)` for a fresh clone, as git 2.56 prints it.
    const out = "main|c9657bf|*|\norigin|c9657bf| |refs/remotes/origin/main\norigin/main|c9657bf| |\n";
    expect(parseBranches(out).map((b) => b.name)).toEqual(["main", "origin/main"]);
  });

  it("leaves refs that merely mention HEAD alone", () => {
    const [commit] = parseGitLog(commitWith("tag: release/HEAD, HEADroom, origin/HEADroom"));
    expect(commit!.refs.map((r) => r.name)).toEqual(["release/HEAD", "HEADroom", "origin/HEADroom"]);
  });
});
