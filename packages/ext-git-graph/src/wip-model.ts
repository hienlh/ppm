/**
 * The uncommitted-changes arithmetic the graph's WIP row and inspector show:
 * a file's checkbox and status letter, its block dots, the totals the commit
 * box reads, the sync button's mode and the discard confirmation's wording.
 *
 * A port of `src/web/lib/git-changes-view.ts`, not an import of it: this
 * package ships beside the install as source and never reaches into PPM's own
 * tree. The two copies are held together by
 * `tests/unit/extensions/git-graph-wip-model-parity.test.ts`, which runs both
 * over the same files — Source Control and the graph showing different counts
 * for one working tree is exactly the drift that test is there to catch.
 *
 * Every function is injected into the webview by `toString()` (`WIP_MODEL_JS`),
 * so none may reach anything in this module's scope except the other functions
 * listed there, which the webview gets under the same names. Lookup tables are
 * therefore written inside the functions that use them.
 */

export type ChangeSideName = "staged" | "unstaged";

export interface WipBlock {
  id?: string;
  index?: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added?: number;
  removed?: number;
}

export interface WipSide {
  blocks: WipBlock[];
  whole?: string;
  added: number;
  removed: number;
}

export interface WipFile {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
  untracked: boolean;
  conflict: boolean;
  staged: WipSide | null;
  unstaged: WipSide | null;
}

export interface WipBranch {
  head: string | null;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  hasRemote: boolean;
}

export interface WipOperation {
  kind: "merge" | "rebase" | "cherry-pick" | "revert" | "am";
  head?: string;
  name?: string;
  step?: number;
  total?: number;
}

export type CheckState = "all" | "some" | "none";
export type ChangeLetter = "A" | "M" | "D" | "R" | "U";
export type SyncMode = "publish" | "sync" | "pull" | "push" | "synced";

export interface ChangeTotals {
  files: number;
  filesStaged: number;
  blocks: number;
  blocksStaged: number;
  conflicts: number;
}

/** Where a block sits in the index version of the file — the one coordinate both sides share. */
export function blockAnchor(side: ChangeSideName, block: WipBlock): number {
  if (side === "staged") return block.newLines === 0 ? block.newStart + 0.5 : block.newStart;
  return block.oldLines === 0 ? block.oldStart + 0.5 : block.oldStart;
}

export function plural(n: number, word: string): string {
  return n + " " + (n === 1 ? word : word + "s");
}

/** `src/web/app.tsx` → `["src/web", "app.tsx"]`. */
export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
}

/** Ticked when everything in the file is staged, a dash when only part of it is. */
export function fileCheckState(file: WipFile): CheckState {
  if (!file.staged) return "none";
  return file.unstaged ? "some" : "all";
}

/** The header's checkbox. Conflicts are left out: staging one marks it resolved. */
export function allCheckState(files: WipFile[]): CheckState {
  const states = files.filter((f) => !f.conflict).map(fileCheckState);
  if (!states.length) return "none";
  if (states.every((s) => s === "all")) return "all";
  return states.some((s) => s !== "none") ? "some" : "none";
}

/** The status tile. `U` is a conflict; a new file is `A` whether or not it is staged. */
export function changeLetter(file: WipFile): ChangeLetter {
  if (file.conflict) return "U";
  if (file.untracked || file.x === "A") return "A";
  if (file.oldPath !== undefined) return "R";
  if (file.x === "D" || file.y === "D") return "D";
  return "M";
}

export function changeLetterName(letter: ChangeLetter): string {
  const names: Record<ChangeLetter, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", U: "Conflict" };
  return names[letter];
}

/** Lines added and removed, over both sides. */
export function changeCounts(file: WipFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const side of [file.staged, file.unstaged]) {
    if (!side) continue;
    added += side.added;
    removed += side.removed;
  }
  return { added, removed };
}

/** What a change with no lines shows where the counts would be. Null for a rename, which its tile names. */
export function lineNote(file: WipFile): string | null {
  const notes: Record<string, string> = { binary: "binary", submodule: "submodule", mode: "mode", type: "type", empty: "empty" };
  for (const side of [file.unstaged, file.staged]) {
    const note = side && side.whole ? notes[side.whole] : undefined;
    if (note) return note;
  }
  return null;
}

/** One dot per block in file order, true when it is staged. A side not split into blocks is one dot. */
export function blockDots(file: WipFile): boolean[] {
  const dots: { at: number; staged: boolean }[] = [];
  const add = (name: ChangeSideName, side: WipSide | null) => {
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
export function hasUnstaged(file: WipFile): boolean {
  return !!file.unstaged && !file.conflict;
}

/** A staged rename is two index entries; resetting only the new path leaves the old one deleted. */
export function unstagePaths(file: WipFile): string[] {
  return file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path];
}

export function changeTotals(files: WipFile[]): ChangeTotals {
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

/** What the push button does. Null when there is nothing it could do. */
export function syncMode(branch: WipBranch): SyncMode | null {
  if (!branch.head || !branch.hasRemote) return null;
  if (!branch.upstream || branch.upstreamGone) return "publish";
  if (branch.ahead && branch.behind) return "sync";
  if (branch.behind) return "pull";
  if (branch.ahead) return "push";
  return "synced";
}

export function commitLabel(totals: Pick<ChangeTotals, "filesStaged">): string {
  return totals.filesStaged ? "Commit " + plural(totals.filesStaged, "file") : "Commit";
}

/** The line under the message box: what is missing before a commit can be made. */
export function commitHint(totals: ChangeTotals, message: string, keys = "⌘↵"): string {
  if (!totals.files) return "Nothing to commit";
  if (totals.conflicts) return "Resolve " + plural(totals.conflicts, "conflict") + " to commit";
  if (!totals.filesStaged) return "Tick a file or stage a block to commit";
  if (!message.trim()) return "Write a message to commit";
  return totals.blocksStaged + " of " + plural(totals.blocks, "block") + " staged · " + keys + " commits";
}

export function canCommit(totals: ChangeTotals, message: string): boolean {
  return totals.filesStaged > 0 && message.trim().length > 0 && totals.conflicts === 0;
}

/**
 * What a discard confirmation says: which blocks go, which stay, and that it
 * can be undone. Only unstaged changes are discarded; a new file is deleted.
 */
export function discardSummary(files: WipFile[]): { title: string; body: string; confirm: string } {
  if (files.length === 1) {
    const file = files[0]!;
    const name = splitPath(file.path)[1];
    if (file.untracked) {
      return {
        title: "Delete " + name + "?",
        body: "It is a new file git has never stored, so this deletes it. You can undo it right after.",
        confirm: "Delete file",
      };
    }
    const dots = blockDots(file);
    const staged = dots.filter(Boolean).length;
    const open = dots.length - staged;
    const back = staged ? "the staged version" : "the last commit's version";
    const stays = staged ? " The " + plural(staged, "staged block") + " " + (staged === 1 ? "stays" : "stay") + "." : "";
    return {
      title: "Discard changes to " + name + "?",
      body: "This puts " + plural(open, "unstaged block") + " back to " + back + "." + stays + " You can undo it right after.",
      confirm: "Discard " + plural(open, "block"),
    };
  }
  const created = files.filter((f) => f.untracked).length;
  const deletes = created ? ", and deletes " + plural(created, "new file") : "";
  return {
    title: "Discard changes to " + plural(files.length, "file") + "?",
    body: "This puts the unstaged changes back the way the index has them" + deletes + ". Staged changes stay. You can undo it right after.",
    confirm: "Discard " + plural(files.length, "file"),
  };
}

/** The banner's headline for a stopped merge, rebase or cherry-pick. */
export function operationTitle(op: WipOperation, branch: string | null): string {
  const into = branch ? " into " + branch : "";
  const progress = op.step && op.total ? " (" + op.step + " of " + op.total + ")" : "";
  switch (op.kind) {
    case "merge":
      return "Merging " + (op.name ?? op.head ?? "a commit") + into;
    case "rebase":
      return "Rebasing " + (op.name ?? branch ?? "HEAD") + progress;
    case "cherry-pick":
      return "Cherry-picking " + (op.head ?? "a commit") + into;
    case "revert":
      return "Reverting " + (op.head ?? "a commit");
    case "am":
      return "Applying patches" + progress;
  }
}

export function operationNoun(kind: WipOperation["kind"]): string {
  const nouns: Record<WipOperation["kind"], string> = {
    merge: "merge",
    rebase: "rebase",
    "cherry-pick": "cherry-pick",
    revert: "revert",
    am: "patch series",
  };
  return nouns[kind];
}

/**
 * Every function above, as source for the webview script. Listed by hand
 * rather than collected from the module's exports, so that adding a helper
 * here is a decision to ship it.
 */
export const WIP_MODEL_JS = [
  blockAnchor,
  plural,
  splitPath,
  fileCheckState,
  allCheckState,
  changeLetter,
  changeLetterName,
  changeCounts,
  lineNote,
  blockDots,
  hasUnstaged,
  unstagePaths,
  changeTotals,
  syncMode,
  commitLabel,
  commitHint,
  canCommit,
  discardSummary,
  operationTitle,
  operationNoun,
].map((fn) => fn.toString()).join("\n");
