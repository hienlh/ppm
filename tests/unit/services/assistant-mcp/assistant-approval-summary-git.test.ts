/**
 * The git tools' approval cards: what the user approves must be exactly what runs. Agent-written
 * text (a commit or stash message) is shown verbatim — markup, backticks and bidi controls
 * included — in the body, after the files, and every path, branch and repository is an uncut fact.
 */
import { describe, expect, it } from "bun:test";
import {
  DISCARD_KEEP_WARNING, gitBranchSummary, gitCommitSummary, gitDiscardSummary, gitPullSummary, gitPushSummary, gitStageSummary,
  gitStashEntrySummary, gitStashSaveSummary, gitUndoCommitSummary, gitUndoDiscardSummary, type GitCardTarget,
} from "../../../../src/services/assistant-mcp/assistant-approval-summary-git.ts";

const LONG = `feature/${"x".repeat(260)}`;
const target: GitCardTarget = { project: "proj", repository: "apps/web", branch: LONG, oid: "a".repeat(40) };
const factValue = (s: { facts: Array<{ label: string; value: string }> }, label: string) => s.facts.find((f) => f.label === label)?.value;

describe("git approval cards", () => {
  it("always name the project, repository and branch in full", () => {
    const s = gitStageSummary({ target, files: [{ path: "a.txt" }], unstage: false });
    expect(factValue(s, "Project")).toBe("proj");
    expect(factValue(s, "Repository")).toBe("apps/web");
    expect(factValue(s, "Branch")).toBe(LONG);
    const root = gitStageSummary({ target: { ...target, repository: ".", branch: null }, files: [{ path: "a" }], unstage: true });
    expect(factValue(root, "Repository")).toBe(". (the project folder)");
    expect(factValue(root, "Branch")).toBe("detached HEAD at aaaaaaa");
    expect(root.headline).toContain("Unstage 1 file");
  });

  it("show a commit message verbatim, after the file list, with a count to check it against", () => {
    const message = "fix: <script>alert(1)</script> `rm -rf /`\n\nFiles (99):\nM  fake.txt‮ gnp.exe";
    const s = gitCommitSummary({
      target, message, signoff: false, amend: null,
      files: [{ path: "src/a.ts", x: "M" }, { path: "src/new.ts", oldPath: "src/old.ts", x: "R" }],
    });
    expect(s.body?.format).toBe("text");
    expect(s.body?.text).toBe(`Files (2):\nM  src/a.ts\nR  src/old.ts → src/new.ts\n\nMessage:\n${message}`);
    expect(s.body!.text.indexOf("src/a.ts")).toBeLessThan(s.body!.text.indexOf("Message:"));
    expect(factValue(s, "Staged files")).toBe("2");
    expect(factValue(s, "Hooks")).toContain("commit hooks run");
    expect(s.warning).toBeUndefined();
  });

  it("warn before amending a pushed commit, and keep its message when none is given", () => {
    const s = gitCommitSummary({
      target, message: "", signoff: true, files: [],
      amend: { hash: "c".repeat(40), subject: "old subject", pushed: true },
    });
    expect(s.headline).toContain("Amend the last commit");
    expect(factValue(s, "Replaces commit")).toBe("ccccccc");
    expect(factValue(s, "Sign-off")).toBeDefined();
    expect(s.body?.text).toContain("(unchanged — the amended commit keeps its message)");
    expect(s.warning).toContain("force push, which PPM never does");
  });

  it("mark deleted new files and files too large to keep on a discard card", () => {
    const s = gitDiscardSummary({
      target,
      files: [
        { path: "a.txt", untracked: false, notKept: null },
        { path: "new.txt", untracked: true, notKept: null },
        { path: "big.bin", untracked: false, notKept: "too_large" },
        { path: "f6.bin", untracked: true, notKept: "over_total" },
      ],
    });
    expect(s.body?.text).toBe([
      "a.txt",
      "new.txt  (new file — deleted)",
      "big.bin  (over 20 MB — not kept, cannot be undone)",
      "f6.bin  (new file — deleted; past the 100 MB one discard keeps — not kept, cannot be undone)",
    ].join("\n"));
    expect(s.warning).toContain("2 files marked in the list cannot be undone");
    expect(s.warning).toContain("keeps a copy of the rest for one day");
    expect(s.facts.find((f) => f.label === "Cannot be undone")).toMatchObject({ value: "2 files", tone: "warning" });
    const kept = gitDiscardSummary({ target, files: [{ path: "a.txt", untracked: false, notKept: null }] });
    expect(kept.warning).toBe(DISCARD_KEEP_WARNING);
    const none = gitDiscardSummary({ target, files: [{ path: "big.bin", untracked: false, notKept: "too_large" }] });
    expect(none.warning).toContain("this discard cannot be undone");
  });

  it("list what an undo writes back or takes back", () => {
    const d = gitUndoDiscardSummary({ target, record: { id: "id-1", kind: "files", paths: ["a", "b"], createdAt: 0, skipped: ["c"] } });
    expect(d.body?.text).toBe("a\nb");
    expect(factValue(d, "Discard")).toBe("id-1");
    expect(factValue(d, "Not kept (gone for good)")).toBe("1");
    const c = gitUndoCommitSummary({ target, commit: { hash: "d".repeat(40), subject: "subj" } });
    expect(factValue(c, "Commit")).toBe("d".repeat(40));
    expect(c.warning).toContain("stay staged");
  });

  it("say a push behind its upstream will likely be refused, and never force", () => {
    const s = gitPushSummary({
      target, upstream: "origin/main", ahead: 2, behind: 3, head: { hash: "e".repeat(40), subject: "tip" },
      to: { remote: "origin", remoteBranch: "main", refspec: "refs/heads/feature:refs/heads/main" },
    });
    expect(s.headline).toContain("Push 2 commits");
    expect(s.headline).toContain("to branch main on remote origin");
    expect(factValue(s, "To")).toBe("branch main on remote origin");
    expect(factValue(s, "Refspec")).toBe("refs/heads/feature:refs/heads/main");
    expect(factValue(s, "Force")).toContain("Never");
    expect(s.body?.text).toBe(`${"e".repeat(40)}\ntip`);
    expect(s.warning).toContain("will likely be refused. Pull first.");
    const publish = gitPushSummary({
      target, upstream: null, ahead: 0, behind: 0, head: null,
      to: { remote: "upstream", remoteBranch: "+main", refspec: "refs/heads/+main:refs/heads/+main" },
    });
    expect(publish.headline).toContain("Publish");
    expect(publish.headline).toContain("to remote upstream");
    expect(factValue(publish, "To")).toBe("branch +main on remote upstream, which becomes the branch's upstream");
    expect(factValue(publish, "Refspec")).toBe("refs/heads/+main:refs/heads/+main");
    expect(publish.body).toBeUndefined();
  });

  it("describe a pull's reconciliation as of the last fetch", () => {
    const merge = gitPullSummary({ target, upstream: "origin/main", ahead: 1, behind: 2, rebase: false });
    expect(factValue(merge, "Behind / ahead")).toBe("2 behind, 1 ahead, as of the last fetch");
    expect(factValue(merge, "How")).toContain("Merge");
    expect(factValue(gitPullSummary({ target, upstream: "u", ahead: 1, behind: 0, rebase: true }), "How")).toContain("Rebase: your local commits (1)");
  });

  it("show where a branch switch goes and what comes along", () => {
    const s = gitBranchSummary({ target, action: "switch", name: "dev", from: null, tracks: "origin/dev", uncommitted: 2 });
    expect(factValue(s, "From")).toBe(LONG);
    expect(factValue(s, "To")).toBe("dev");
    expect(factValue(s, "Follows")).toBe("origin/dev");
    expect(s.warning).toContain("2 uncommitted changes come along");
    const create = gitBranchSummary({ target, action: "create", name: "n", from: null, tracks: null, uncommitted: 0 });
    expect(factValue(create, "Starts at")).toBe(`HEAD (${LONG})`);
    expect(create.warning).toBeUndefined();
  });

  it("list the files a stash takes and show its message verbatim; warn that a drop is final", () => {
    const save = gitStashSaveSummary({ target, files: ["a", "b"], message: "wip `x` <y>", includeUntracked: false });
    expect(save.body?.text).toBe("Files (2):\na\nb\n\nMessage:\nwip `x` <y>");
    expect(factValue(save, "Untracked files")).toBe("Left in place");
    const drop = gitStashEntrySummary({ target, action: "drop", stash: { index: 1, hash: "f".repeat(40), message: "m", branch: "main", date: "2026-10-11" } });
    expect(drop.headline).toContain("Drop stash@{1}");
    expect(factValue(drop, "Stash")).toBe("stash@{1} fffffff");
    expect(drop.warning).toContain("cannot be brought back from PPM");
  });
});
