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

export async function branchDiff(
  repoPath: string,
  baseRef: string | undefined,
  headRef: string | undefined,
  mode: BranchDiffMode = "three-dot",
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

  const [numstatOut, rawOut] = await Promise.all([
    git.raw(["diff", "--numstat", "-z", "-M", mergeBase, head]),
    git.raw(["diff", "--raw", "-z", "-M", "--no-abbrev", mergeBase, head]),
  ]);

  return {
    base,
    head,
    mode,
    mergeBase,
    files: mergeBranchDiff(parseNumstatZ(numstatOut), parseRawZ(rawOut)),
  };
}
