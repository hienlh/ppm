import { describe, expect, it } from "bun:test";
import { parsePorcelainV2 } from "../../../../src/services/git-changes/porcelain-v2.ts";
import { parseRenameNumstat } from "../../../../src/services/git-changes/git-changes.service.ts";

const z = (...tokens: string[]) => tokens.join("\0") + "\0";

describe("parsePorcelainV2", () => {
  it("reads the branch headers", () => {
    const { branch } = parsePorcelainV2(z(
      "# branch.oid a7513fde721717237afd68e3a5bdc3c4f6bfdbc1",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "# branch.ab +2 -1",
    ));
    expect(branch).toEqual({
      oid: "a7513fde721717237afd68e3a5bdc3c4f6bfdbc1", head: "feat/x", upstream: "origin/feat/x",
      ahead: 2, behind: 1, compared: true,
    });
  });

  it("reports a detached HEAD, an unborn branch and a gone upstream", () => {
    const { branch } = parsePorcelainV2(z("# branch.oid (initial)", "# branch.head (detached)", "# branch.upstream origin/x"));
    expect(branch.oid).toBeNull();
    expect(branch.head).toBeNull();
    expect(branch.upstream).toBe("origin/x");
    expect(branch.compared).toBe(false);
  });

  it("reads every entry type, with spaces in paths", () => {
    const { entries } = parsePorcelainV2(z(
      "1 .M N... 100644 100644 100644 aaaa bbbb docs/my guide.md",
      "2 R. N... 100644 100644 100644 cccc cccc R100 src/new name.ts",
      "src/old name.ts",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict file.txt",
      "1 M. SC.. 160000 160000 160000 dddd eeee vendor/lib",
      "? untracked dir/file.txt",
      "! ignored.log",
    ));
    expect(entries.map((e) => [e.kind, e.x, e.y, e.path])).toEqual([
      ["ordinary", ".", "M", "docs/my guide.md"],
      ["renamed", "R", ".", "src/new name.ts"],
      ["unmerged", "U", "U", "conflict file.txt"],
      ["ordinary", "M", ".", "vendor/lib"],
      ["untracked", "?", "?", "untracked dir/file.txt"],
      ["ignored", "!", "!", "ignored.log"],
    ]);
    expect(entries[1]!.origPath).toBe("src/old name.ts");
    expect(entries[3]!.sub).toBe("SC..");
    expect(entries[2]!.modes).toHaveLength(4);
  });
});

describe("parseRenameNumstat", () => {
  it("keys a rename by its destination and a plain change by its path", () => {
    const counts = parseRenameNumstat(z("3\t1\t", "old.ts", "new.ts", "-\t-\tlogo.png", "2\t0\tplain.ts"));
    expect(counts.get("new.ts")).toEqual({ added: 3, removed: 1 });
    expect(counts.get("logo.png")).toEqual({ added: 0, removed: 0 });
    expect(counts.get("plain.ts")).toEqual({ added: 2, removed: 0 });
    expect(counts.has("old.ts")).toBe(false);
  });
});
