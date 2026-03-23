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
