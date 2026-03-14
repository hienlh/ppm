/** Git commit data for graph rendering */
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
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied";
  staged: boolean;
  oldPath?: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

/** Data needed to render the git graph visualization */
export interface GitGraphData {
  commits: GitCommit[];
  branches: GitBranch[];
}

export interface GitDiffResult {
  from: string;
  to: string;
  diff: string;
}
