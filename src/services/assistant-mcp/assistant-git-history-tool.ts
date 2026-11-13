import type { Json } from "../mcp-http-endpoint.ts";
import type { GitChanges } from "../../shared/git-changes.ts";
import type { GitRef } from "../../types/git.ts";
import { gitHooksPresent, hooksInCommits, type PresentHooks } from "../git-workflow/git-hooks-present.ts";
import { GIT_HISTORY_TOOL } from "../../shared/assistant-git-tool-names.ts";
import { gitHistorySummary } from "./assistant-approval-summary-git-history.ts";
import { actionOf, mergeSource, planHistory, strayArgument, type HistoryAction, type HistoryPlan } from "./assistant-git-history-plan.ts";
import type { GitRepoScope } from "./assistant-git-repo-scope.ts";
import {
  askFirst, cardTarget, gitRoute, hideRemoteUrls, readChanges, repoLabel, routeErrorMessage, scopeOrError, staleResult,
} from "./assistant-git-tool-helpers.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * `git_history`: merge, cherry-pick, revert, tag, and aborting or continuing an operation that
 * stopped part way. One card per call, built from what PPM's routes answered; after the user
 * answers, HEAD's branch and commit and the operation under way must be what the card showed (and
 * a merge's source still at the commit it showed), or nothing runs. Exactly one write route is
 * called. A merge, pick or revert that stops on a conflict is not a failure to hide: the answer
 * lists the conflicted files and says how to finish or abort.
 */

const ROUTES: Record<HistoryAction, string> = {
  merge: "merge", cherry_pick: "cherry-pick", revert: "revert", tag: "tag", abort: "operation/abort", continue: "operation/continue",
};

/**
 * The hooks each action can run, generously: a hook listed here that git skips costs a line on
 * the card, one left out would hide code that runs. Every ref update can run `reference-transaction`.
 */
const COMMITTING = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];
const HOOKS: Record<HistoryAction, readonly string[]> = {
  merge: ["pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-merge", "reference-transaction"],
  cherry_pick: [...COMMITTING, "reference-transaction"],
  revert: [...COMMITTING, "reference-transaction"],
  tag: ["reference-transaction"],
  abort: ["post-checkout", "reference-transaction"],
  continue: [...COMMITTING, "post-merge", "post-rewrite", "post-checkout", "reference-transaction"],
};

const MAX_LISTED_CONFLICTS = 50;

const signature = (c: GitChanges): string => JSON.stringify([c.branch.head, c.branch.oid, c.operation]);

/** What the repository looks like after the write, with the files left in conflict. */
function stateOf(changes: GitChanges) {
  const conflicts = changes.files.filter((f) => f.conflict).map((f) => f.path);
  return {
    branch: { name: changes.branch.head, commit: changes.branch.oid },
    operation: changes.operation,
    ...(conflicts.length ? { conflictCount: conflicts.length, conflicts: conflicts.slice(0, MAX_LISTED_CONFLICTS) } : {}),
  };
}

/**
 * The commits whose tree git writes before it runs the hooks: a merge's source tip, a picked
 * commit, and for a revert both the commit and its parent (a revert brings back what the commit
 * removed, from the parent's tree).
 */
function incomingCommits(plan: HistoryPlan): string[] {
  const { card } = plan;
  if (card.action === "merge") return plan.sourceTip ? [plan.sourceTip] : [];
  if (card.action === "cherry_pick") return [card.commit.hash];
  if (card.action === "revert") return [card.commit.hash, `${card.commit.hash}^`];
  return [];
}

/** The hooks present now, plus those the incoming commit adds to a tracked hooks folder. */
async function hooksWithIncoming(repoPath: string, action: HistoryAction, plan: HistoryPlan): Promise<PresentHooks | null> {
  const hooks = await gitHooksPresent(repoPath, HOOKS[action]);
  const commits = incomingCommits(plan);
  if (!hooks || !commits.length) return hooks;
  const inCommits = await hooksInCommits(repoPath, commits, HOOKS[action], hooks.where);
  return { ...hooks, incoming: inCommits && inCommits.filter((name) => !hooks.hooks.includes(name)) };
}

async function sourceMoved(ctx: ToolContext, scope: GitRepoScope, source: string, tip: string): Promise<boolean> {
  const res = await ctx.callRoute<GitRef[]>("GET", gitRoute(scope, "refs"));
  return !res.ok || !res.data || mergeSource(res.data, source)?.hash !== tip;
}

export async function gitHistory(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const action = actionOf(args.action);
  if (!action) return errorResult("`action` must be \"merge\", \"cherry_pick\", \"revert\", \"tag\", \"abort\" or \"continue\".");
  const stray = strayArgument(action, args);
  if (stray) return errorResult(stray);
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const { scope } = got;
  const read = await readChanges(ctx.callRoute, scope);
  if (!read.ok) return read.result;
  const planned = await planHistory(ctx, scope, action, args, read.changes);
  if (!planned.ok) return planned.result;
  const { plan } = planned;

  const hooks = await hooksWithIncoming(scope.path, action, plan);
  const input = { ...repoLabel(scope), action, ...plan.body };
  const refused = await askFirst(ctx, GIT_HISTORY_TOOL, input, gitHistorySummary({ target: cardTarget(scope, read.changes), card: plan.card, hooks }));
  if (refused) return refused;

  // The user approved this change on this commit: anything that moved since would make it another.
  const again = await readChanges(ctx.callRoute, scope);
  if (!again.ok) return again.result;
  if (signature(again.changes) !== signature(read.changes)) {
    return staleResult(GIT_HISTORY_TOOL, "The branch, the commit HEAD is on, or the operation under way changed while the card waited.");
  }
  if (plan.card.action === "merge" && plan.sourceTip && await sourceMoved(ctx, scope, plan.card.source, plan.sourceTip)) {
    return staleResult(GIT_HISTORY_TOOL, `${plan.card.source} moved to another commit while the card waited.`);
  }

  const res = await ctx.callRoute("POST", gitRoute(scope, ROUTES[action]), plan.body);
  const after = await readChanges(ctx.callRoute, scope);
  const state = after.ok ? stateOf(after.changes) : {};
  if (!res.ok) {
    // A merge, pick, revert or continue that stopped on a conflict has still changed the tree.
    if (action !== "abort" && after.ok && after.changes.operation) {
      return jsonResult({
        ...repoLabel(scope), action, stopped: true, reason: hideRemoteUrls(res.error ?? `PPM answered ${res.status}`), ...state,
        next: "Resolve the conflicted files and stage them with git_stage, then call git_history with action continue; or abort to go back to before it started.",
      });
    }
    return errorResult(`${routeErrorMessage(`The ${action.replace("_", "-")} failed`, res)}\nNow: ${JSON.stringify(state)}`);
  }
  // A merge's source is answered as the card named it, not as the full ref sent to git.
  const named = plan.card.action === "merge" ? { source: plan.card.source } : {};
  return jsonResult({ ...repoLabel(scope), action, done: true, ...plan.body, ...named, ...state });
}
