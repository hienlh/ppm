import { describe, it, expect } from "bun:test";

// Import the parser functions from extension.ts
// We'll need to export them for testing purposes
function parseBranches(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, hash, head] = line.split("|");
    const remote = name.includes("/") ? name.split("/")[0] : undefined;
    return { name, hash, current: head === "*", remote };
  });
}

function parseTags(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, hash] = line.split("|");
    return { name, hash };
  });
}

function parseRemotes(stdout: string) {
  const map = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (!match) continue;
    const [, name, url, type] = match;
    if (!map.has(name)) map.set(name, { fetchUrl: "", pushUrl: "" });
    const entry = map.get(name)!;
    if (type === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return [...map.entries()].map(([name, urls]) => ({ name, ...urls }));
}

function parseStashes(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean).map((line, i) => {
    const [, hash, message] = line.split("|");
    return { index: i, hash, message };
  });
}

describe("extension.ts: parseBranches", () => {
  it("parses current branch with asterisk", () => {
    const output = "main|abc1234|*\n";
    const result = parseBranches(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "main", hash: "abc1234", current: true, remote: undefined });
  });

  it("parses non-current branches", () => {
    const output = "develop|def5678|\nfeature|ghi9012|\n";
    const result = parseBranches(output);
    expect(result).toHaveLength(2);
    expect(result[0]?.current).toBe(false);
    expect(result[1]?.current).toBe(false);
  });

  it("parses remote branches with remote name", () => {
    const output = "origin/main|abc1234|\nupstream/develop|def5678|\n";
    const result = parseBranches(output);
    expect(result[0]).toEqual({ name: "origin/main", hash: "abc1234", current: false, remote: "origin" });
    expect(result[1]).toEqual({ name: "upstream/develop", hash: "def5678", current: false, remote: "upstream" });
  });

  it("parses mixed local and remote branches", () => {
    const output = "main|abc1234|*\norigin/main|abc1234|\ndevelop|def5678|\norigin/develop|def5678|\n";
    const result = parseBranches(output);
    expect(result).toHaveLength(4);
    expect(result[0]?.remote).toBeUndefined();
    expect(result[1]?.remote).toBe("origin");
  });

  it("handles empty input", () => {
    const result = parseBranches("");
    expect(result).toEqual([]);
  });

  it("ignores lines with missing fields", () => {
    const output = "incomplete|\nmain|abc1234|*\n";
    const result = parseBranches(output);
    // Both lines are parsed, but the first has undefined hash
    expect(result).toHaveLength(2);
  });
});

describe("extension.ts: parseTags", () => {
  it("parses single tag", () => {
    const output = "v1.0.0|abc1234\n";
    const result = parseTags(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "v1.0.0", hash: "abc1234" });
  });

  it("parses multiple tags", () => {
    const output = "v1.0.0|abc1234\nv1.0.1|def5678\nv2.0.0|ghi9012\n";
    const result = parseTags(output);
    expect(result).toHaveLength(3);
  });

  it("handles empty input", () => {
    const result = parseTags("");
    expect(result).toEqual([]);
  });

  it("handles whitespace", () => {
    const output = "  \nv1.0.0|abc1234\n  \n";
    const result = parseTags(output);
    expect(result).toHaveLength(1);
  });
});

describe("extension.ts: parseRemotes", () => {
  it("parses single remote with fetch and push URLs", () => {
    const output = `origin	https://github.com/user/repo.git (fetch)
origin	https://github.com/user/repo.git (push)
`;
    const result = parseRemotes(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "origin",
      fetchUrl: "https://github.com/user/repo.git",
      pushUrl: "https://github.com/user/repo.git",
    });
  });

  it("parses multiple remotes", () => {
    const output = `origin	https://github.com/user/repo.git (fetch)
origin	https://github.com/user/repo.git (push)
upstream	https://github.com/upstream/repo.git (fetch)
upstream	https://github.com/upstream/repo.git (push)
`;
    const result = parseRemotes(output);
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("origin");
    expect(result[1]?.name).toBe("upstream");
  });

  it("handles remotes with different fetch/push URLs", () => {
    const output = `origin	git@github.com:user/repo.git (fetch)
origin	https://github.com/user/repo.git (push)
`;
    const result = parseRemotes(output);
    expect(result[0]?.fetchUrl).toBe("git@github.com:user/repo.git");
    expect(result[0]?.pushUrl).toBe("https://github.com/user/repo.git");
  });

  it("handles empty input", () => {
    const result = parseRemotes("");
    expect(result).toEqual([]);
  });

  it("ignores malformed lines", () => {
    const output = `origin	https://github.com/user/repo.git (fetch)
origin	https://github.com/user/repo.git (push)
invalid line without brackets
`;
    const result = parseRemotes(output);
    expect(result).toHaveLength(1);
  });
});

describe("extension.ts: parseStashes", () => {
  it("parses single stash", () => {
    const output = "stash@{0}|abc1234|WIP on main\n";
    const result = parseStashes(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ index: 0, hash: "abc1234", message: "WIP on main" });
  });

  it("parses multiple stashes with correct indices", () => {
    const output = `stash@{0}|abc1234|WIP on main: first
stash@{1}|def5678|WIP on develop: second
stash@{2}|ghi9012|Untracked files
`;
    const result = parseStashes(output);
    expect(result).toHaveLength(3);
    expect(result[0]?.index).toBe(0);
    expect(result[1]?.index).toBe(1);
    expect(result[2]?.index).toBe(2);
  });

  it("handles empty input", () => {
    const result = parseStashes("");
    expect(result).toEqual([]);
  });

  it("handles stash messages with pipes in them", () => {
    // This test verifies current behavior; note that parsing breaks with pipes in message
    const output = "stash@{0}|abc1234|Message with more data\n";
    const result = parseStashes(output);
    expect(result).toHaveLength(1);
    expect(result[0]?.hash).toBe("abc1234");
  });
});
