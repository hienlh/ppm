/**
 * The whole of a branch's work in one list: every file that differs between a
 * base ref and a head ref, with the base the per-file diffs must also use.
 *
 * The point of returning `mergeBase` rather than just the file list is that the
 * caller opens each file separately. In three-dot mode the list is computed
 * against where the branches diverged, so a viewer handed `base` instead would
 * show the base branch's own later commits as deletions inside a review of
 * head — the file list and the file view disagreeing about what is being
 * reviewed. Every diff here is run against one resolved commit so the two
 * cannot drift.
 */
import simpleGit from "simple-git";
import type { BranchDiff } from "../../types/git.ts";
import { assertRef, mergeBranchDiff, parseNumstatZ, parseRawZ } from "./branch-diff-parse.ts";

export type BranchDiffMode = "three-dot" | "two-dot";

/**
 * How many files one comparison may answer with.
 *
 * Both git outputs are buffered as strings and the whole list is returned in
 * one JSON array, which the review tab then renders un-virtualized in a 288px
 * sidebar. A branch that vendors a dependency or lands a formatter pass is
 * 20,000 files — a multi-megabyte response and 20,000 DOM rows for a list
 * nobody is going to read to the end. Reviewing a branch that large one file at
 * a time is not the workflow this exists for, so the honest answer is to say
 * how many were left out.
 */
const MAX_FILES = 2000;

export async function branchDiff(
  repoPath: string,
  baseRef: string | undefined,
  headRef: string | undefined,
  mode: BranchDiffMode = "three-dot",
  // A parameter only so a test can trip the cap without committing 2001 files.
  maxFiles: number = MAX_FILES,
): Promise<BranchDiff> {
  const base = assertRef(baseRef, "base");
  const head = assertRef(headRef, "head");
  const git = simpleGit(repoPath);

  let mergeBase = base;
  if (mode === "three-dot") {
    // `git merge-base` exits non-zero on unrelated histories, where a three-dot
    // diff has no meaning at all. Saying so beats silently answering with the
    // two-dot list under a three-dot label.
    try {
      mergeBase = (await git.raw(["merge-base", base, head])).trim();
    } catch {
      throw new Error(`"${base}" and "${head}" have no common ancestor.`);
    }
    if (!mergeBase) throw new Error(`"${base}" and "${head}" have no common ancestor.`);
  }

  const [numstatOut, rawOut, headCommit] = await Promise.all([
    git.raw(["diff", "--numstat", "-z", "-M", mergeBase, head]),
    git.raw(["diff", "--raw", "-z", "-M", "--no-abbrev", mergeBase, head]),
    // Resolved once, here, rather than by each caller opening a file: `head` is
    // a ref name and a commit landing mid-review would move it, so the viewer
    // would render a tip the row's counts and blob id do not describe. This
    // file's own header promises one resolved commit; `mergeBase` was the only
    // half of that promise being kept.
    git.raw(["rev-parse", head]).then((s) => s.trim()),
  ]);

  const all = mergeBranchDiff(parseNumstatZ(numstatOut), parseRawZ(rawOut));

  return {
    base,
    head,
    mode,
    mergeBase,
    headCommit,
    omitted: Math.max(0, all.length - maxFiles),
    files: all.slice(0, maxFiles),
  };
}
