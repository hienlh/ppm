/**
 * The working tree as the Git surfaces see it: every changed file, and each
 * file's changes cut into the blocks (hunks) a user stages one at a time.
 *
 * Built on the server from one `git status` and up to three `git diff` runs
 * (`GET /git/changes`), and read by Source Control, the Review tab and the
 * Git Graph inspector, so all three agree on what a "block" is. A block's `id`
 * is the same `hunkFingerprint` the hunk routes resolve a request by, so a
 * block listed here can be staged, unstaged or discarded without re-listing.
 */

/** Which comparison a block belongs to: HEAD → index, or index → working tree. */
export type ChangeSideName = "staged" | "unstaged";

/**
 * Why a side is not split into blocks. Such a side is staged, unstaged or
 * discarded as one unit.
 */
export type WholeReason =
  /** git cannot express it as text. */
  | "binary"
  /** Too big to send as blocks. */
  | "large"
  /** A staged rename or copy, which git treats as one change. */
  | "rename"
  /** A submodule: a commit id, not lines. */
  | "submodule"
  /** Only the file mode changed. */
  | "mode"
  /** The path changed kind, e.g. a file replaced by a symlink. */
  | "type"
  /** Created or deleted with no lines in it. */
  | "empty"
  /** Not diffed: an untracked directory, or past the untracked-file cap. */
  | "unread";

export interface ChangeBlock {
  /** `hunkFingerprint` of the hunk — what the hunk routes resolve a request by. */
  id: string;
  /** Position in that side's hunk list: the `hunk` hint a request carries. */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: number;
  removed: number;
}

export interface ChangeSide {
  /** Empty when `whole` is set. */
  blocks: ChangeBlock[];
  whole?: WholeReason;
  added: number;
  removed: number;
}

export interface ChangedFile {
  /** Repository-relative. */
  path: string;
  /** Source of a staged rename or copy. */
  oldPath?: string;
  /** git's XY letters: `.` is unchanged on that side, `?` untracked. */
  x: string;
  y: string;
  untracked: boolean;
  /** Unmerged: neither side has blocks until it is resolved. */
  conflict: boolean;
  /** HEAD → index; null when the index matches HEAD for this path. */
  staged: ChangeSide | null;
  /** Index → working tree; null when the working tree matches the index. */
  unstaged: ChangeSide | null;
}

export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "am";

/** A multi-step command that stopped part way, usually on a conflict. */
export interface GitOperation {
  kind: GitOperationKind;
  /** Short id of the commit being merged, picked or reverted, when known. */
  head?: string;
  /** What is being merged ("main"), or the branch a rebase is rewriting. */
  name?: string;
  /** Rebase / am progress, when git records it. */
  step?: number;
  total?: number;
}

export interface GitBranchState {
  /** Branch name; null when HEAD is detached. */
  head: string | null;
  /** HEAD commit; null before the first commit. */
  oid: string | null;
  upstream: string | null;
  /** The upstream is configured but no longer on the remote, so ahead/behind mean nothing. */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  /** The repository has a remote to push to at all. */
  hasRemote: boolean;
}

export interface LastCommit {
  hash: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
  /** Reachable from a remote-tracking branch: undoing it would rewrite pushed history. */
  pushed: boolean;
  /** The root commit cannot be undone with a soft reset. */
  hasParent: boolean;
}

export interface GitChanges {
  branch: GitBranchState;
  operation: GitOperation | null;
  files: ChangedFile[];
  stashes: number;
  lastCommit: LastCommit | null;
  /** More entries existed than were listed. */
  truncated: boolean;
}

export interface ChangeLine {
  kind: " " | "+" | "-";
  text: string;
  noNewline?: boolean;
}

export interface ChangeHunk extends ChangeBlock {
  /** Text after the closing `@@`, usually the enclosing function. */
  heading: string;
  lines: ChangeLine[];
}

export interface ChangeSideDetail {
  /** Empty when `whole` is set, except for a rename, whose hunks are shown but not actionable. */
  hunks: ChangeHunk[];
  whole?: WholeReason;
  added: number;
  removed: number;
}

/** One file with its lines, for the Review tab (`GET /git/changes/file`). */
export interface FileChangeDetail {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
  untracked: boolean;
  conflict: boolean;
  staged: ChangeSideDetail | null;
  unstaged: ChangeSideDetail | null;
}

/**
 * Where a block sits in the *index* version of the file — the one coordinate
 * both sides share, so staged and unstaged blocks can be shown in one list.
 *
 * A staged block (HEAD → index) occupies `newStart…` of the index; an unstaged
 * one (index → working tree) replaces `oldStart…` of it. A block with no lines
 * on the index side sits *after* the line its start names, hence the half.
 */
export function blockAnchor(side: ChangeSideName, block: Pick<ChangeBlock, "oldStart" | "oldLines" | "newStart" | "newLines">): number {
  if (side === "staged") return block.newLines === 0 ? block.newStart + 0.5 : block.newStart;
  return block.oldLines === 0 ? block.oldStart + 0.5 : block.oldStart;
}

/** A discard that can still be undone (`GET /git/discards`, and every discard route's answer). */
export interface DiscardRecord {
  id: string;
  createdAt: number;
  /** One file's blocks, or whole files. */
  kind: "hunks" | "files";
  paths: string[];
  /** For a block discard: the blocks that went, as the patch held them (old side = index). */
  hunks?: ChangeHunk[];
  /** Files too large to keep a copy of: these are gone for good. */
  skipped?: string[];
}

/** One entry of `git stash list`. */
export interface StashEntry {
  index: number;
  /** Full commit id: the routes check it before acting, since indexes shift. */
  hash: string;
  /** The commit the stash was made on. */
  base: string | null;
  /** The branch it was made on, when git recorded one. */
  branch: string | null;
  message: string;
  /** ISO 8601. */
  date: string;
}

/** The commit message being written for one repository, shared by every surface. */
export interface CommitDraft {
  message: string;
  updatedAt: string | null;
}

/** Sent over `/ws/global` after anything PPM writes to a repository. */
export interface GitChangedEvent {
  type: "git:changed";
  projectName: string;
  /** The repository's absolute path, as the route resolved it. */
  repo: string;
}

/** Sent over `/ws/global` when the shared commit message changes. */
export interface CommitDraftEvent extends CommitDraft {
  type: "git:commit-draft";
  projectName: string;
  repo: string;
  /** The surface that typed it, so it can ignore its own echo; null for the server's own changes. */
  clientId: string | null;
}

export type GitEvent = GitChangedEvent | CommitDraftEvent;
