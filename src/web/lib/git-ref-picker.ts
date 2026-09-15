/**
 * The decisions behind the branch picker, kept out of the component.
 *
 * Two of them are not presentation at all. `checkoutTarget` decides what git is
 * actually asked to run, and `buildRows` decides what Enter lands on — both are
 * worth a test, and importing the component to reach them would pull in the
 * zustand stores, which read `localStorage` at module scope and throw under
 * `bun:test`.
 */
import type { CheckoutMode, GitRef } from "../../types/git";

/** The three items above the ref list, in VS Code's order. */
export type PickerAction = "create" | "create-from" | "detach";

export const PICKER_ACTIONS: { action: PickerAction; label: string }[] = [
  { action: "create", label: "Create new branch..." },
  { action: "create-from", label: "Create new branch from..." },
  { action: "detach", label: "Checkout detached..." },
];

/** Group headers, and the order the groups appear in. */
const GROUPS: { type: GitRef["type"]; label: string }[] = [
  { type: "branch", label: "branches" },
  { type: "remote", label: "remote branches" },
  { type: "tag", label: "tags" },
];

export type PickerRow =
  | { kind: "action"; action: PickerAction; label: string }
  | { kind: "separator"; label: string }
  | { kind: "ref"; ref: GitRef };

function matchesRef(ref: GitRef, q: string): boolean {
  return !q || ref.name.toLowerCase().includes(q) || ref.subject.toLowerCase().includes(q);
}

/**
 * The visible rows for one query.
 *
 * A group header is emitted only when something survives the filter under it —
 * a "tags" heading over nothing reads as a list that failed to load. The
 * actions are filtered by their own labels, which is what VS Code's quick pick
 * does to every item it is given; `actions: false` is the second stage, where
 * the question is only which ref to branch from or detach at.
 */
export function buildRows(
  refs: GitRef[],
  query: string,
  opts: { actions: boolean } = { actions: true },
): PickerRow[] {
  const q = query.trim().toLowerCase();
  const rows: PickerRow[] = [];

  if (opts.actions) {
    for (const a of PICKER_ACTIONS) {
      if (!q || a.label.toLowerCase().includes(q)) rows.push({ kind: "action", ...a });
    }
  }

  for (const group of GROUPS) {
    const matched = refs.filter((r) => r.type === group.type && matchesRef(r, q));
    if (!matched.length) continue;
    rows.push({ kind: "separator", label: group.label });
    for (const ref of matched) rows.push({ kind: "ref", ref });
  }

  return rows;
}

/** The first row Enter may land on, or -1 when the filter matched nothing. */
export function firstSelectable(rows: PickerRow[]): number {
  return rows.findIndex((r) => r.kind !== "separator");
}

/** Arrow-key movement: wraps, and never stops on a group header. */
export function moveSelection(rows: PickerRow[], current: number, step: 1 | -1): number {
  const n = rows.length;
  if (!n) return -1;
  let idx = current;
  for (let i = 0; i < n; i++) {
    idx = (idx + step + n) % n;
    if (rows[idx]!.kind !== "separator") return idx;
  }
  return -1;
}

/** `origin/feature/x` → `feature/x`. The remote name is the first segment and only the first. */
export function localNameFor(remoteName: string): string {
  const slash = remoteName.indexOf("/");
  return slash < 0 ? remoteName : remoteName.slice(slash + 1);
}

/**
 * What picking a ref actually has to run.
 *
 * A remote-tracking ref is not a branch: `git checkout origin/foo` lands on a
 * **detached HEAD** at that commit, which looks like it worked right up until
 * the first commit made on it belongs to no branch. `-t` is what creates the
 * local branch that follows it — but `-t` *fails* when that local branch
 * already exists, and checking the existing one out is what the user meant
 * anyway. Deciding here rather than server-side is deliberate: the answer needs
 * the whole ref list, which the picker already has and the route does not.
 */
export function checkoutTarget(ref: GitRef, refs: GitRef[]): { ref: string; mode: CheckoutMode } {
  if (ref.type !== "remote") return { ref: ref.name, mode: "checkout" };
  const local = localNameFor(ref.name);
  const exists = refs.some((r) => r.type === "branch" && r.name === local);
  return exists ? { ref: local, mode: "checkout" } : { ref: ref.name, mode: "track" };
}

/** The second line of a row: `thawngho · 7b758e3 · fix(NX-5832): stop retrying…` */
export function refDetail(ref: GitRef): string {
  return [ref.author, ref.shortHash, ref.subject].filter(Boolean).join(" · ");
}
