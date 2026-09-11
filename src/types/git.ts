export interface GitCommit {
  hash: string;
  abbreviatedHash: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  parents: string[];
  refs: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  commitHash: string;
  ahead: number;
  behind: number;
  /** Remote names that track this local branch (e.g. ["origin", "upstream"]) */
  remotes: string[];
}

export interface GitStatus {
  current: string | null;
  /** Commits ahead of the upstream branch. */
  ahead: number;
  /** Commits behind the upstream branch. */
  behind: number;
  /** Upstream tracking ref (e.g. "origin/main"), or null when untracked. */
  tracking: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
}

export interface GitFileChange {
  path: string;
  status: "M" | "A" | "D" | "R" | "C" | "?";
  oldPath?: string;
}

export interface GitGraphData {
  commits: GitCommit[];
  branches: GitBranch[];
  /** Full hash of the currently checked-out commit (HEAD) */
  head: string;
}

export interface GitDiffResult {
  files: GitDiffFile[];
  raw: string;
}

export interface GitDiffFile {
  path: string;
  additions: number;
  deletions: number;
  content: string;
}

/**
 * Both sides of a single-file diff, as whole files.
 *
 * `binary` is decided from the bytes, and when it is true both sides come back
 * **empty**: decoded, a PNG is megabytes of U+FFFD that no one can read and that
 * JSON has to escape. The viewer asks again with `text=1` ("Open Anyway") when
 * the user wants them anyway. A null size means the file does not exist on that
 * side, which is how the binary view tells an added or deleted file from a
 * changed one.
 */
export interface FileFullDiff {
  original: string;
  modified: string;
  binary: boolean;
  originalSize: number | null;
  modifiedSize: number | null;
}

export interface GitWorktree {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch name (empty string if detached HEAD) */
  branch: string;
  /** HEAD commit hash */
  head: string;
  /** True for the main (original) worktree */
  isMain: boolean;
  /** True if bare repository worktree */
  isBare: boolean;
  /** True if in detached HEAD state */
  isDetached: boolean;
  /** True if worktree is locked (prevented from auto-pruning) */
  locked: boolean;
  /** Reason for lock, if any */
  lockReason?: string;
  /** True if this worktree can be pruned (directory missing/stale) */
  prunable: boolean;
}

/**
 * A whole branch's changes against a base, as one list.
 *
 * `mergeBase` is the commit every per-file diff has to be opened against — in
 * three-dot mode it is where the two refs diverged, not `base` itself.
 */
export interface BranchDiff {
  base: string;
  head: string;
  mode: "three-dot" | "two-dot";
  mergeBase: string;
  files: BranchDiffFile[];
}

export interface BranchDiffFile {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Head-side blob id; what a "reviewed" flag is remembered against. */
  blob: string;
}
