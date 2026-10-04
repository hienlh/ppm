/**
 * What the Source Control panel shows for `GET /git/changes`, as pure
 * functions: a file's checkbox, its status letter, its block dots, the sync
 * button's mode and the commit box's hint.
 *
 * Kept out of the components so it can be tested directly: importing them
 * pulls in the zustand stores, which read `localStorage` at module scope.
 */
import {
  blockAnchor,
  type ChangedFile,
  type ChangeSide,
  type ChangeSideName,
  type GitBranchState,
  type GitChanges,
  type GitOperation,
  type WholeReason,
} from "../../shared/git-changes";
import type { GitFileChange, GitStatus } from "../../types/git";

/** A checkbox: ticked, a dash for part of it, or empty. */
export type CheckState = "all" | "some" | "none";

/** Ticked when everything in the file is staged, a dash when only part of it is. */
export function fileCheckState(file: ChangedFile): CheckState {
  if (!file.staged) return "none";
  return file.unstaged ? "some" : "all";
}

/**
 * The header's checkbox. Conflicts are left out: staging one marks it
 * resolved, which a bulk tick must never do behind the user's back.
 */
export function allCheckState(files: ChangedFile[]): CheckState {
  const states = files.filter((f) => !f.conflict).map(fileCheckState);
  if (!states.length) return "none";
  if (states.every((s) => s === "all")) return "all";
  return states.some((s) => s !== "none") ? "some" : "none";
}

/** The status tile. `U` is a conflict, as in the merge banner; a new file is `A` whether or not it is staged. */
export type ChangeLetter = "A" | "M" | "D" | "R" | "U";

export const CHANGE_LETTER_NAME: Record<ChangeLetter, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  U: "Conflict",
};

export function changeLetter(file: ChangedFile): ChangeLetter {
  if (file.conflict) return "U";
  if (file.untracked || file.x === "A") return "A";
  if (file.oldPath !== undefined) return "R";
  if (file.x === "D" || file.y === "D") return "D";
  return "M";
}

/** git's own conflict markers are still in the text: a `<<<<<<<` or `>>>>>>>` line. */
export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7}|>{7})(?: |$)/m.test(text);
}

/** Lines added and removed, over both sides. */
export function changeCounts(file: ChangedFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const side of [file.staged, file.unstaged]) {
    if (!side) continue;
    added += side.added;
    removed += side.removed;
  }
  return { added, removed };
}

const WHOLE_NOTE: Partial<Record<WholeReason, string>> = {
  binary: "binary",
  submodule: "submodule",
  mode: "mode",
  type: "type",
  empty: "empty",
};

/**
 * What a change with no lines shows where the counts would be — `+0` on an
 * edited image says nothing changed. Null for a rename, which its tile names.
 */
export function lineNote(file: ChangedFile): string | null {
  for (const side of [file.unstaged, file.staged]) {
    const note = side?.whole && WHOLE_NOTE[side.whole];
    if (note) return note;
  }
  return null;
}

/**
 * One dot per block in file order, true when it is staged. A side that is not
 * split into blocks (a binary, a rename, a mode change) is one dot.
 */
export function blockDots(file: ChangedFile): boolean[] {
  const dots: { at: number; staged: boolean }[] = [];
  const add = (name: ChangeSideName, side: ChangeSide | null) => {
    if (!side) return;
    const staged = name === "staged";
    if (side.whole || !side.blocks.length) dots.push({ at: 0, staged });
    else for (const block of side.blocks) dots.push({ at: blockAnchor(name, block), staged });
  };
  add("staged", file.staged);
  add("unstaged", file.unstaged);
  return dots.sort((a, b) => a.at - b.at).map((d) => d.staged);
}

/** Something not yet staged, which is what Discard puts back. */
export function hasUnstaged(file: ChangedFile): boolean {
  return !!file.unstaged && !file.conflict;
}

/**
 * What unstaging the whole file has to name: a staged rename is two index
 * entries, and resetting only the new path leaves the old one deleted.
 */
export function unstagePaths(file: ChangedFile): string[] {
  return file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path];
}

export interface ChangeTotals {
  /** Files with anything in them. */
  files: number;
  /** Files with something staged: what a commit would take. */
  filesStaged: number;
  blocks: number;
  blocksStaged: number;
  conflicts: number;
}

export function changeTotals(files: ChangedFile[]): ChangeTotals {
  const totals: ChangeTotals = { files: 0, filesStaged: 0, blocks: 0, blocksStaged: 0, conflicts: 0 };
  for (const file of files) {
    totals.files++;
    if (file.conflict) totals.conflicts++;
    if (file.staged) totals.filesStaged++;
    const dots = blockDots(file);
    totals.blocks += dots.length;
    totals.blocksStaged += dots.filter(Boolean).length;
  }
  return totals;
}

/** What the button beside the branch does. Null when there is nothing it could do. */
export type SyncMode = "publish" | "sync" | "pull" | "push" | "synced";

export function syncMode(branch: GitBranchState): SyncMode | null {
  // A detached HEAD has nothing to push to; a repository with no remote has nowhere.
  if (!branch.head || !branch.hasRemote) return null;
  // An upstream deleted from the remote is pushed again the way a new branch is.
  if (!branch.upstream || branch.upstreamGone) return "publish";
  if (branch.ahead && branch.behind) return "sync";
  if (branch.behind) return "pull";
  if (branch.ahead) return "push";
  return "synced";
}

/** The sync button becomes the primary action once there is nothing left to commit. */
export function syncIsPrimary(mode: SyncMode | null, files: number): boolean {
  return files === 0 && mode !== null && mode !== "synced";
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

export function commitLabel(totals: Pick<ChangeTotals, "filesStaged">): string {
  return totals.filesStaged ? `Commit ${plural(totals.filesStaged, "file")}` : "Commit";
}

/** The line under the message box: what is missing before a commit can be made. */
export function commitHint(totals: ChangeTotals, message: string, keys = "⌘↵"): string {
  if (!totals.files) return "Nothing to commit";
  if (totals.conflicts) return `Resolve ${plural(totals.conflicts, "conflict")} to commit`;
  if (!totals.filesStaged) return "Tick a file or stage a block to commit";
  if (!message.trim()) return "Write a message to commit";
  return `${totals.blocksStaged} of ${plural(totals.blocks, "block")} staged · ${keys} commits`;
}

export function canCommit(totals: ChangeTotals, message: string): boolean {
  return totals.filesStaged > 0 && message.trim().length > 0 && totals.conflicts === 0;
}

/**
 * What a discard confirmation says: which blocks go, which stay, and that it
 * can be undone. Only unstaged changes are discarded — a staged block stays
 * staged — and a new file is deleted outright.
 */
export function discardSummary(files: ChangedFile[]): { title: string; body: string; confirm: string } {
  if (files.length === 1) {
    const file = files[0]!;
    const name = splitPath(file.path)[1];
    if (file.untracked) {
      return {
        title: `Delete ${name}?`,
        body: "It is a new file git has never stored, so this deletes it. You can undo it right after.",
        confirm: "Delete file",
      };
    }
    const dots = blockDots(file);
    const staged = dots.filter(Boolean).length;
    const open = dots.length - staged;
    const back = staged ? "the staged version" : "the last commit's version";
    const stays = staged ? ` The ${plural(staged, "staged block")} ${staged === 1 ? "stays" : "stay"}.` : "";
    return {
      title: `Discard changes to ${name}?`,
      body: `This puts ${plural(open, "unstaged block")} back to ${back}.${stays} You can undo it right after.`,
      confirm: `Discard ${plural(open, "block")}`,
    };
  }
  const created = files.filter((f) => f.untracked).length;
  const deletes = created ? `, and deletes ${plural(created, "new file")}` : "";
  return {
    title: `Discard changes to ${plural(files.length, "file")}?`,
    body: `This puts the unstaged changes back the way the index has them${deletes}. Staged changes stay. You can undo it right after.`,
    confirm: `Discard ${plural(files.length, "file")}`,
  };
}

/** The banner's headline for a stopped merge, rebase or cherry-pick. */
export function operationTitle(op: GitOperation, branch: string | null): string {
  const into = branch ? ` into ${branch}` : "";
  const progress = op.step && op.total ? ` (${op.step} of ${op.total})` : "";
  switch (op.kind) {
    case "merge":
      return `Merging ${op.name ?? op.head ?? "a commit"}${into}`;
    case "rebase":
      return `Rebasing ${op.name ?? branch ?? "HEAD"}${progress}`;
    case "cherry-pick":
      return `Cherry-picking ${op.head ?? "a commit"}${into}`;
    case "revert":
      return `Reverting ${op.head ?? "a commit"}`;
    case "am":
      return `Applying patches${progress}`;
  }
}

export const OPERATION_NOUN: Record<GitOperation["kind"], string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  am: "patch series",
};

/** `src/web/app.tsx` → `["src/web", "app.tsx"]`. */
export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
}

/**
 * The same answer in the `/git/status` shape the rest of the app reads — the
 * sidebar badge, the explorer's decorations, the status bar's branch — so the
 * panel can keep them current without asking git a second time.
 */
export function changesToStatus(changes: GitChanges): GitStatus {
  const letter = (c: string): GitFileChange["status"] =>
    c === "A" || c === "D" || c === "R" || c === "C" ? c : "M";
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: string[] = [];
  for (const file of changes.files) {
    if (file.untracked) {
      untracked.push(file.path);
      continue;
    }
    if (file.conflict) {
      unstaged.push({ path: file.path, status: "M" });
      continue;
    }
    if (file.staged) {
      const change: GitFileChange = { path: file.path, status: letter(file.x) };
      if (file.oldPath !== undefined) change.oldPath = file.oldPath;
      staged.push(change);
    }
    if (file.unstaged) unstaged.push({ path: file.path, status: letter(file.y) });
  }
  return {
    current: changes.branch.head,
    ahead: changes.branch.ahead,
    behind: changes.branch.behind,
    tracking: changes.branch.upstream,
    staged,
    unstaged,
    untracked,
  };
}
