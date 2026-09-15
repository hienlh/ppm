/**
 * The rows a branch picker shows for one query.
 *
 * Pure, and in `lib` rather than beside the component, for the reason the rest
 * of this directory exists: importing the component reaches the icon barrel and
 * the sheet's hooks, which want a DOM — the decisions here are testable without
 * one.
 *
 * Local branches are listed before remote-tracking ones because that is the
 * order a review is chosen in, and because a repository with a few dozen local
 * branches routinely has hundreds of remote ones; ungrouped, the handful anyone
 * is looking for is lost among them. A heading is emitted only when something
 * under it survived the filter, the same rule `git-ref-picker.ts` follows — a
 * "Remote branches" heading over nothing reads as a list that failed to load.
 */
import type { GitBranch } from "../../types/git";

export type BranchRow =
  | { kind: "separator"; label: string }
  | { kind: "branch"; branch: GitBranch };

const GROUPS = [
  { label: "Branches", remote: false },
  { label: "Remote branches", remote: true },
] as const;

/**
 * Substring, case-insensitive, over the whole name — the same match the
 * checkout quick pick makes.
 *
 * Whole name including the `remotes/origin/` prefix, so typing `origin` narrows
 * to one remote, and typing the ticket number in the middle of a name finds it
 * where a prefix match never would: these branches are named
 * `fix/NX-5175-ni-rounding-unification`, and their first segment is the least
 * distinguishing part of them.
 */
export function branchRows(branches: GitBranch[], query: string): BranchRow[] {
  const q = query.trim().toLowerCase();
  const rows: BranchRow[] = [];

  for (const group of GROUPS) {
    const matched = branches.filter(
      (b) => b.remote === group.remote && (!q || b.name.toLowerCase().includes(q)),
    );
    if (!matched.length) continue;
    rows.push({ kind: "separator", label: group.label });
    for (const branch of matched) rows.push({ kind: "branch", branch });
  }

  return rows;
}

/** Where a branch sits in the rows, or -1 — what opens the list on the current value. */
export function rowIndexOf(rows: BranchRow[], name: string): number {
  return rows.findIndex((r) => r.kind === "branch" && r.branch.name === name);
}
