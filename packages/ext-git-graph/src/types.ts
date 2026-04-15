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

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  isDetached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
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
  status: "A" | "M" | "D" | "R" | "C" | "U";
  additions: number;
  deletions: number;
}

export interface MergeState {
  type: "merge" | "rebase" | "cherry-pick";
  progress?: string; // e.g. "3/5" for rebase
  message?: string;  // current commit message being rebased
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

export interface UncommittedData {
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  mergeState?: MergeState;
}

// --- Settings ---

export interface IssueLinkingRule {
  pattern: string;
  url: string;
}

export interface PrCreationConfig {
  provider: "github" | "gitlab" | "bitbucket" | "custom";
  urlTemplate: string;
  owner: string;
  repo: string;
  defaultTargetBranch: string;
}

export interface GitGraphSettings {
  maxCommits: number;
  showTags: boolean;
  showStashes: boolean;
  showRemoteBranches: boolean;
  graphStyle: "rounded" | "angular";
  firstParentOnly: boolean;
  dateFormat: "relative" | "absolute" | "iso";
  commitOrdering: "topo" | "date" | "author-date";
  issueLinkingRules: IssueLinkingRule[];
  prCreation: PrCreationConfig | null;
  autoFetchInterval: number;
}

export const DEFAULT_SETTINGS: GitGraphSettings = {
  maxCommits: 300,
  showTags: true,
  showStashes: true,
  showRemoteBranches: true,
  graphStyle: "rounded",
  firstParentOnly: false,
  dateFormat: "relative",
  commitOrdering: "topo",
  issueLinkingRules: [{ pattern: "#(\\d+)", url: "" }],
  prCreation: null,
  autoFetchInterval: 0,
};

// --- Extension → Webview messages ---

export type ExtToWebview =
  | { command: "loadRepoInfo"; data: RepoInfo }
  | { command: "loadCommits"; data: GitVertex[]; append: boolean }
  | { command: "commitDetails"; data: CommitDetail }
  | { command: "loadUncommitted"; data: UncommittedData | null }
  | { command: "loadSettings"; data: GitGraphSettings }
  | { command: "loadUserDetails"; data: { name: string; email: string } }
  | { command: "loadOwnerRepo"; data: { owner: string; repo: string } }
  | { command: "refresh"; data: GitVertex[]; repoInfo: RepoInfo }
  | { command: "actionResult"; action: string; args?: Record<string, unknown>; result: ActionResult }
  | { command: "loadWorktrees"; data: Worktree[] }
  | { command: "loadStashes"; data: Stash[] }
  | { command: "error"; message: string };

// --- Webview → Extension messages ---

export type WebviewToExt =
  | { command: "ready" }
  | { command: "requestRepoInfo" }
  | { command: "requestCommits"; maxCommits?: number; skip?: number; branch?: string }
  | { command: "requestCommitDetails"; hash: string }
  | { command: "requestUncommitted" }
  | { command: "openDiff"; filePath: string; hash: string; parentHash: string | null }
  | { command: "requestSettings" }
  | { command: "updateSetting"; key: string; value: unknown }
  | { command: "requestUserDetails" }
  | { command: "updateUserDetails"; name?: string; email?: string }
  | { command: "addRemote"; name: string; url: string }
  | { command: "removeRemote"; name: string }
  | { command: "editRemoteUrl"; name: string; url: string }
  | { command: "requestOwnerRepo" }
  | { command: "gitAction"; action: string; args: Record<string, unknown> }
  | { command: "requestWorktrees" }
  | { command: "addWorktree"; path: string; branch?: string; newBranch?: string; startPoint?: string }
  | { command: "removeWorktree"; path: string; force?: boolean }
  | { command: "pruneWorktrees" }
  | { command: "openWorktree"; path: string }
  | { command: "openFile"; filePath: string }
  | { command: "openConflictFile"; filePath: string }
  | { command: "openSourceControl" }
  | { command: "requestStashes" };
