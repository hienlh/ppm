import { describe, it, expect } from "bun:test";
import { parseGitLog } from "./git-log-parser.ts";
import type { GitVertex } from "./types.ts";

describe("git-log-parser: parseGitLog", () => {
  it("parses single commit with minimal data", () => {
    const input = `abc123
def456
John Doe
john@example.com
1609459200
Jane Reviewer
jane@example.com
1609459200

Initial commit
<END_COMMIT>`;

    const result = parseGitLog(input);
    expect(result).toHaveLength(1);
    const commit = result[0] as GitVertex;
    expect(commit.hash).toBe("abc123");
    expect(commit.parents).toEqual(["def456"]);
    expect(commit.author).toBe("John Doe");
    expect(commit.authorEmail).toBe("john@example.com");
    expect(commit.authorDate).toBe(1609459200);
    expect(commit.committer).toBe("Jane Reviewer");
    expect(commit.committerEmail).toBe("jane@example.com");
    expect(commit.commitDate).toBe(1609459200);
    expect(commit.message).toBe("Initial commit");
  });

  it("parses commit with multiple parents (merge commit)", () => {
    const input = `abc123
def456 ghi789
Author Name
author@example.com
1609459200
Committer Name
committer@example.com
1609459200

Merge branch 'feature'
<END_COMMIT>`;

    const result = parseGitLog(input);
    expect(result).toHaveLength(1);
    const commit = result[0] as GitVertex;
    expect(commit.parents).toEqual(["def456", "ghi789"]);
  });

  it("parses commit with no parents (root commit)", () => {
    const input = `abc123

Author Name
author@example.com
1609459200
Committer Name
committer@example.com
1609459200

Root commit
<END_COMMIT>`;

    const result = parseGitLog(input);
    expect(result).toHaveLength(1);
    const commit = result[0] as GitVertex;
    expect(commit.parents).toEqual([]);
  });

  it("parses refs with HEAD pointer", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200
HEAD -> main, origin/main
Commit message
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    expect(commit.refs).toHaveLength(2);
    expect(commit.refs[0]).toEqual({ name: "main", type: "head" });
    expect(commit.refs[1]).toEqual({ name: "origin/main", type: "remote" });
  });

  it("parses refs with tags", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200
tag: v1.0.0, tag: latest
Commit message
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    const tags = commit.refs.filter((r) => r.type === "tag");
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ name: "v1.0.0", type: "tag" });
    expect(tags[1]).toEqual({ name: "latest", type: "tag" });
  });

  it("parses refs with local branches", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200
feature-branch, develop
Commit message
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    const locals = commit.refs.filter((r) => r.type === "local");
    expect(locals).toHaveLength(2);
    expect(locals[0]).toEqual({ name: "feature-branch", type: "local" });
    expect(locals[1]).toEqual({ name: "develop", type: "local" });
  });

  it("parses commit with empty refs", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200

Commit with no refs
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    expect(commit.refs).toEqual([]);
  });

  it("parses multiple commits in sequence", () => {
    const input = `abc123
def456
Author A
authorA@example.com
1609459200
Committer A
committerA@example.com
1609459200

First commit
<END_COMMIT>def456
ghi789
Author B
authorB@example.com
1609459201
Committer B
committerB@example.com
1609459201

Second commit
<END_COMMIT>`;

    const result = parseGitLog(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.hash).toBe("abc123");
    expect(result[1]?.hash).toBe("def456");
  });

  it("handles multiline commit messages", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200

Fix: multiple fixes
- Fix issue A
- Fix issue B
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    // Only the first line of the message is captured (git log format)
    expect(commit.message).toBe("Fix: multiple fixes");
  });

  it("filters out malformed blocks (less than 10 lines)", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200

Complete commit
<END_COMMIT>incomplete
block
<END_COMMIT>`;

    const result = parseGitLog(input);
    expect(result).toHaveLength(1);
  });

  it("parses empty input as empty array", () => {
    const result = parseGitLog("");
    expect(result).toEqual([]);
  });

  it("handles whitespace-only input", () => {
    const result = parseGitLog("   \n  \n  ");
    expect(result).toEqual([]);
  });

  it("correctly parses unix timestamps as numbers", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459300

Commit
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    expect(typeof commit.authorDate).toBe("number");
    expect(typeof commit.commitDate).toBe("number");
    expect(commit.authorDate).toBe(1609459200);
    expect(commit.commitDate).toBe(1609459300);
  });

  it("parses refs with remote branches (origin/feature)", () => {
    const input = `abc123
def456
Author
author@example.com
1609459200
Committer
committer@example.com
1609459200
origin/feature, upstream/main
Commit
<END_COMMIT>`;

    const result = parseGitLog(input);
    const commit = result[0] as GitVertex;
    const remotes = commit.refs.filter((r) => r.type === "remote");
    expect(remotes).toHaveLength(2);
    expect(remotes[0]).toEqual({ name: "origin/feature", type: "remote" });
    expect(remotes[1]).toEqual({ name: "upstream/main", type: "remote" });
  });
});
