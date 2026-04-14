/** Message types for Extension ↔ Webview communication */

// --- Git data types ---

export interface GitVertex {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  refs: RefData[];
  message: string;
}

export interface RefData {
  name: string;
  type: "head" | "local" | "remote" | "tag";
}

export interface Branch {
  name: string;
  remote?: string;
  current: boolean;
  hash: string;
}

export interface Tag {
  name: string;
  hash: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Stash {
  index: number;
  hash: string;
  message: string;
}

export interface CommitDetail {
  hash: string;
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  message: string;
  parents: string[];
  fileChanges: FileChange[];
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C";
  additions: number;
  deletions: number;
}

export interface RepoInfo {
  path: string;
  branches: Branch[];
  tags: Tag[];
  remotes: Remote[];
  stashes: Stash[];
  head: string;
  currentBranch: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// --- Extension → Webview messages ---

export type ExtToWebview =
  | { command: "loadRepoInfo"; data: RepoInfo }
  | { command: "loadCommits"; data: GitVertex[]; append: boolean }
  | { command: "commitDetails"; data: CommitDetail }
  | { command: "refresh"; data: GitVertex[]; repoInfo: RepoInfo }
  | { command: "actionResult"; action: string; result: ActionResult }
  | { command: "error"; message: string };

// --- Webview → Extension messages ---

export type WebviewToExt =
  | { command: "ready" }
  | { command: "requestRepoInfo" }
  | { command: "requestCommits"; maxCommits?: number; skip?: number; branch?: string }
  | { command: "requestCommitDetails"; hash: string }
  | { command: "gitAction"; action: string; args: Record<string, unknown> };
