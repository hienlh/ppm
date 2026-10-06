/** Message types for Extension ↔ Webview communication */
import type { SearchHit, SearchMode } from "./commit-search.ts";
import type { CommitStat } from "./shortstat-parser.ts";
import type { Submodule } from "./submodule-parser.ts";

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
  type: "head" | "local" | "remote" | "tag" | "stash";
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
  parentHash: string;
  message: string;
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  date: number;
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
  /** Files the `MAX_DETAIL_FILES` cap dropped, so the panel can say it capped. */
  filesOmitted: number;
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
  /** Where a commit opens in a browser (`base + commitPath + hash`); null for a remote no browser can open. */
  remoteWeb: { base: string; commitPath: string; label: string } | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * PPM's `GitChanges` (`src/shared/git-changes.ts`), passed through to the
 * webview untouched. Not imported: this package does not reach into PPM's
 * source tree, and the host never looks inside it beyond the branch state.
 */
export interface PpmGitChanges {
  branch: { head: string | null; upstream: string | null; upstreamGone: boolean; ahead: number; behind: number; hasRemote: boolean };
  [key: string]: unknown;
}

/** The commit message being written for the repository, shared with Source Control and the Review tab. */
export interface CommitDraftData {
  message: string;
  updatedAt: string | null;
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
  /*
   * Which columns the commit table shows. Flat keys rather than one nested
   * object, because the stored settings are merged over the defaults one level
   * deep: a nested object saved by an older version would keep its own shape
   * and any key added later would arrive undefined.
   *
   * A narrow panel drops columns of its own accord regardless of these — they
   * say what to show when there is room for it.
   */
  colChanges: boolean;
  colAuthor: boolean;
  colDate: boolean;
  colHash: boolean;
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
  colChanges: true,
  colAuthor: true,
  colDate: true,
  colHash: true,
};

// --- Extension → Webview messages ---

export type ExtToWebview =
  | { command: "loadRepoInfo"; data: RepoInfo }
  /** `scope` is the branch the window was read for, or "all"; `skip`, how many commits precede it. */
  | { command: "loadCommits"; data: GitVertex[]; append: boolean; skip: number; scope: string }
  | { command: "loadCommitStats"; data: Record<string, CommitStat> }
  | { command: "commitDetails"; data: CommitDetail }
  | { command: "loadSearchResults"; data: { mode: SearchMode; text: string; hits: SearchHit[] } }
  | { command: "loadSettings"; data: GitGraphSettings }
  | { command: "loadUserDetails"; data: { name: string; email: string } }
  | { command: "loadOwnerRepo"; data: { owner: string; repo: string } }
  /**
   * `data` is what the write returned (a route's answer), for the toast that reports it.
   * `reqId` is the request's own, echoed: two of one action can finish in either order.
   */
  | { command: "actionResult"; action: string; args?: Record<string, unknown>; result: ActionResult & { data?: unknown }; reqId?: number }
  | { command: "loadWorktrees"; data: Worktree[] }
  | { command: "loadStashes"; data: Stash[] }
  | { command: "loadSubmodules"; data: Submodule[] }
  | { command: "loadChanges"; data: PpmGitChanges | null; error?: string }
  | { command: "loadDraft"; data: CommitDraftData }
  /** `failed` and `reqId` name the request this error answers, when one was waiting. */
  | { command: "error"; message: string; failed?: string; reqId?: number };

// --- Webview → Extension messages ---

export type WebviewToExt =
  | { command: "ready" }
  | { command: "requestRepoInfo" }
  | { command: "requestCommits"; maxCommits?: number; skip?: number; branch?: string }
  | { command: "requestCommitDetails"; hash: string }
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
  | { command: "requestStashes" }
  | { command: "searchCommits"; mode: string; text: string }
  | { command: "openBlame"; filePath: string; hash?: string }
  | { command: "openFileHistory"; filePath: string }
  | { command: "openCompare"; ref1?: string; ref2?: string }
  | { command: "openReflog" }
  | { command: "requestSubmodules" }
  | { command: "updateSubmodule"; path: string }
  | { command: "openSubmodule"; path: string }
  | { command: "requestChanges" }
  | { command: "requestStashDetails"; hash: string }
  | { command: "saveDraft"; message: string }
  | { command: "stageFiles"; paths: string[] }
  | { command: "unstageFiles"; paths: string[] }
  | { command: "discardFiles"; paths: string[] }
  | { command: "undoDiscard"; id: string }
  | { command: "commitStaged"; message: string; amend?: boolean; signoff?: boolean; push?: boolean }
  | { command: "undoCommit"; hash: string }
  | { command: "sync"; action: "fetch" | "pull" | "push" | "publish" | "sync" }
  | { command: "stash"; message?: string; includeUntracked?: boolean }
  /** By index and hash: PPM's route refuses when the index no longer holds that stash. */
  | { command: "stashAction"; action: "apply" | "pop" | "drop"; index: number; hash: string }
  | { command: "operation"; action: "abort" | "continue" }
  | { command: "openReview"; path?: string };
