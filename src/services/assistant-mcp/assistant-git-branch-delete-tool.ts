import type { Json } from "../mcp-http-endpoint.ts";
import type { GitChanges } from "../../shared/git-changes.ts";
import type { GitRef } from "../../types/git.ts";
import { gitHooksPresent } from "../git-workflow/git-hooks-present.ts";
import { GIT_BRANCH_TOOL } from "../../shared/assistant-git-tool-names.ts";
import { gitBranchDeleteSummary } from "./assistant-approval-summary-git-history.ts";
import type { GitRepoScope } from "./assistant-git-repo-scope.ts";
import {
  askFirst, cardTarget, gitRoute, optionalBoolean, readChanges, repoLabel, routeErrorResult, scopeOrError, staleResult,
} from "./assistant-git-tool-helpers.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * `git_branch` with `action: "delete"`: one local branch, never the one checked out. The card
 * names the commit the branch points at, and the answer repeats it, so a deleted branch can be
 * made again from it (`git_branch create` with `from`). After the user answers, the branch must
 * still point at that commit and still not be checked out, or nothing is deleted.
 */

/** Deleting a branch rewrites refs only, so the one hook it can run is the ref-update one. */
const DELETE_HOOKS = ["reference-transaction"] as const;

type Found = { ok: true; changes: GitChanges; commit: string } | { ok: false; result: Json };

/** The repository's state and the local branch `name`'s full commit, from PPM's routes. */
async function findBranch(ctx: ToolContext, scope: GitRepoScope, name: string): Promise<Found> {
  const [read, refs] = await Promise.all([
    readChanges(ctx.callRoute, scope),
    ctx.callRoute<GitRef[]>("GET", gitRoute(scope, "refs")),
  ]);
  if (!read.ok) return read;
  if (!refs.ok || !refs.data) return { ok: false, result: routeErrorResult("PPM could not list the branches", refs) };
  const branch = refs.data.find((r) => r.type === "branch" && r.name === name);
  if (!branch) return { ok: false, result: errorResult(`There is no local branch named ${name}. See git_branches.`) };
  return { ok: true, changes: read.changes, commit: branch.hash };
}

export async function gitBranchDelete(ctx: ToolContext, args: Record<string, unknown>, name: string): Promise<Json> {
  const force = optionalBoolean(args.force, "force");
  if (!force.ok) return errorResult(force.error);
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const { scope } = got;
  const before = await findBranch(ctx, scope, name);
  if (!before.ok) return before.result;
  if (before.changes.branch.head === name) return errorResult(`${name} is the branch checked out; switch to another branch first.`);

  const input = { ...repoLabel(scope), action: "delete", name, ...(force.value ? { force: true } : {}) };
  const hooks = await gitHooksPresent(scope.path, DELETE_HOOKS);
  const refused = await askFirst(ctx, GIT_BRANCH_TOOL, input, gitBranchDeleteSummary({
    target: cardTarget(scope, before.changes), name, commit: before.commit, force: force.value, hooks,
  }));
  if (refused) return refused;

  const after = await findBranch(ctx, scope, name);
  if (!after.ok) return after.result;
  if (after.commit !== before.commit || after.changes.branch.head === name) {
    return staleResult(GIT_BRANCH_TOOL, `${name} moved to another commit, or was checked out, while the card waited.`);
  }
  const res = await ctx.callRoute("POST", gitRoute(scope, "branch/delete"), { name, force: force.value });
  if (!res.ok) {
    return routeErrorResult(force.value ? "Deleting the branch failed" : "Deleting the branch failed (git refuses a branch that is not merged)", res);
  }
  return jsonResult({
    ...repoLabel(scope), deleted: name, commit: before.commit,
    note: `To bring it back: git_branch create with name ${name} and from ${before.commit}.`,
  });
}
