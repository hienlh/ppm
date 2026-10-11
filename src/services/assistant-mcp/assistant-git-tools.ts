import { allowRoute, type RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandlers } from "./assistant-tool-family.ts";
import {
  GIT_BRANCH_TOOL, GIT_BRANCHES_TOOL, GIT_COMMIT_TOOL, GIT_DIFF_TOOL, GIT_DISCARD_TOOL, GIT_LOG_TOOL, GIT_STAGE_TOOL,
  GIT_STASH_TOOL, GIT_STATUS_TOOL, GIT_SYNC_TOOL, GIT_UNDO_TOOL,
} from "../../shared/assistant-git-tool-names.ts";
import { gitBranches, gitDiff, gitLog, gitStatus } from "./assistant-git-read-tools.ts";
import { gitCommit, gitDiscard, gitStage, gitUndo } from "./assistant-git-change-tools.ts";
import { gitBranch, gitStash, gitSync } from "./assistant-git-remote-tools.ts";

/**
 * The git tools' handlers and the only routes they may call. `GIT_ROUTES` is this family's whole
 * reach into PPM's routes (see `assistant-route-call.ts`): exactly the routes the tools call, each
 * with the query keys it is sent. Nothing for merge, rebase, cherry-pick, revert, tags, worktrees,
 * branch deletion, block-level staging or aborting an operation — those stay in PPM's UI.
 */

const git = (method: "GET" | "POST", sub: string, query: string[] = []): RouteRule =>
  allowRoute(method, `/api/project/:project/git/${sub}`, ["repo", ...query]);

export const GIT_ROUTES: readonly RouteRule[] = [
  // Discovery is always asked of the project folder itself, never of a repository in it.
  allowRoute("GET", "/api/project/:project/git/repos"),
  git("GET", "changes"),
  git("GET", "changes/file", ["path"]),
  git("GET", "stashes"),
  git("GET", "discards"),
  git("GET", "graph", ["max", "skip"]),
  git("GET", "diff", ["ref1", "ref2"]),
  git("GET", "file-diff", ["file", "ref"]),
  git("GET", "branches"),
  git("POST", "stage"),
  git("POST", "unstage"),
  git("POST", "discard"),
  git("POST", "discard/undo"),
  git("POST", "commit"),
  git("POST", "commit/undo"),
  git("POST", "fetch"),
  git("POST", "pull"),
  git("POST", "push"),
  git("POST", "publish"),
  git("POST", "branch/create"),
  git("POST", "checkout"),
  git("POST", "stash"),
  git("POST", "stash/apply"),
  git("POST", "stash/pop"),
  git("POST", "stash/drop"),
];

export const GIT_TOOL_HANDLERS: FamilyHandlers = {
  [GIT_STATUS_TOOL]: gitStatus,
  [GIT_LOG_TOOL]: gitLog,
  [GIT_DIFF_TOOL]: gitDiff,
  [GIT_BRANCHES_TOOL]: gitBranches,
  [GIT_STAGE_TOOL]: gitStage,
  [GIT_DISCARD_TOOL]: gitDiscard,
  [GIT_UNDO_TOOL]: gitUndo,
  [GIT_COMMIT_TOOL]: gitCommit,
  [GIT_SYNC_TOOL]: gitSync,
  [GIT_BRANCH_TOOL]: gitBranch,
  [GIT_STASH_TOOL]: gitStash,
};
