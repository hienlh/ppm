import { isAbsolute, resolve } from "node:path";
import { OPEN_BRANCH_REVIEW_TOOL, type TabOpenAsk } from "../../shared/tab-open-protocol.ts";
import { branchDiff } from "../git-branch-diff/branch-diff.service.ts";
import { assertRef } from "../git-branch-diff/branch-diff-parse.ts";
import { runGit, toDisplay } from "../git-hunks/git-hunks.service.ts";
import { discoverGitRepos, type GitRepoCandidate, type GitRepoDiscovery } from "../git-repos/git-repo-discovery.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { deviceError, type TabOpenOutcome } from "./tab-open-broker.ts";
import type { TabToolsBinding } from "./tab-target.ts";

/**
 * `open_branch_review`: the Branch Review tab (`src/web/components/branch-review/`) on the pair of
 * refs the AI names, on the user's device — so work the AI just finished on a branch is reviewed
 * file by file in PPM instead of being summarised in the chat.
 *
 * Everything that can be wrong is found here, on the host, before a tab opens: a ref that names
 * nothing, a project folder holding several repositories, a branch with no base to measure it by.
 * The tab would otherwise open on an error the AI never hears about. The comparison is run once
 * here too, so the AI learns what the user is looking at — and how much of its work the review
 * leaves out because it is not committed, which is the usual reason a review comes up short.
 */

/** How long a device has to say the tab is open. */
export const OPEN_BRANCH_REVIEW_WAIT_MS = 8_000;

export interface BranchReviewDeps {
  request: (sessionId: string, req: TabOpenAsk, waitMs: number) => Promise<TabOpenOutcome>;
  /** The repositories under a project folder, as `GET /git/repos` answers. */
  discover?: (projectPath: string) => GitRepoDiscovery;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const git = async (repo: string, args: string[]): Promise<{ ok: boolean; out: string }> => {
  const result = await runGit(repo, args, { env: { GIT_OPTIONAL_LOCKS: "0" } });
  return { ok: result.exitCode === 0, out: toDisplay(result.stdout).trim() };
};

/** An optional ref argument: absent, or one `assertRef` accepts. */
function refArg(value: unknown, label: string): Outcome<string | undefined> {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `\`${label}\` must be a branch name.` };
  try {
    return { ok: true, value: assertRef(value, label) };
  } catch {
    return { ok: false, error: `\`${label}\` is not a valid branch name: "${value.trim().slice(0, 200)}".` };
  }
}

/** The repository to review: the one named, else the project when it is one, else the only one in it. */
function pickRepo(discovery: GitRepoDiscovery, projectPath: string, asked: unknown): Outcome<GitRepoCandidate> {
  const list = () => discovery.repos.map((r) => r.relative).join(", ");
  if (asked !== undefined && asked !== null && asked !== "") {
    if (typeof asked !== "string") return { ok: false, error: "`repo` must be a folder path." };
    const raw = asked.trim().replace(/[\\/]+$/, "");
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(projectPath, raw);
    const match = discovery.repos.find((r) => r.path === absolute || r.relative === raw);
    if (match) return { ok: true, value: match };
    return {
      ok: false,
      error: discovery.repos.length
        ? `${asked} is not one of the project's repositories. They are: ${list()}.`
        : "The project folder holds no git repository.",
    };
  }
  if (discovery.repos.length === 1) return { ok: true, value: discovery.repos[0]! };
  if (!discovery.repos.length) return { ok: false, error: "The project folder holds no git repository." };
  return { ok: false, error: `The project folder holds several repositories; pass \`repo\`, one of: ${list()}.` };
}

/** The branch a review is measured against when none is named, as the tab picks it: main, else master. */
async function defaultBase(repo: string, head: string): Promise<Outcome<string>> {
  const { out } = await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const local = out.split("\n").filter((name) => name && name !== head);
  const base = local.find((b) => b === "main") ?? local.find((b) => b === "master");
  if (base) return { ok: true, value: base };
  return {
    ok: false,
    error: local.length
      ? `This repository has no main or master branch; pass \`base\`, such as ${local.slice(0, 5).join(", ")}.`
      : `${head} is the repository's only branch, so there is nothing to compare it with; pass \`base\`.`,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function createBranchReviewTool(deps: BranchReviewDeps) {
  const discover = deps.discover ?? ((path: string) => discoverGitRepos(path));

  return async function openBranchReview(binding: TabToolsBinding, args: Json): Promise<Json> {
    if (!binding.projectPath || !binding.projectName) {
      return textResult("This chat is not in a PPM project, so there is no repository to review.", true);
    }
    const baseArg = refArg(args.base, "base");
    if (!baseArg.ok) return textResult(baseArg.error, true);
    const headArg = refArg(args.head, "head");
    if (!headArg.ok) return textResult(headArg.error, true);

    const discovery = discover(binding.projectPath);
    const picked = pickRepo(discovery, binding.projectPath, args.repo);
    if (!picked.ok) return textResult(picked.error, true);
    const repo = picked.value;
    const where = discovery.rootIsRepo ? "" : ` in ${repo.relative}`;

    const current = await git(repo.path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const checkedOut = current.ok ? current.out : null;
    const head = headArg.value ?? checkedOut;
    if (!head) return textResult(`No branch is checked out${where} (a detached HEAD); pass \`head\`.`, true);
    let base = baseArg.value;
    if (!base) {
      const found = await defaultBase(repo.path, head);
      if (!found.ok) return textResult(found.error, true);
      base = found.value;
    }
    for (const ref of [base, head]) {
      if (!(await git(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok) {
        return textResult(`No branch or commit is named ${ref}${where}.`, true);
      }
    }

    let diff: Awaited<ReturnType<typeof branchDiff>>;
    try {
      diff = await branchDiff(repo.path, base, head);
    } catch (e) {
      return textResult(`Could not compare ${head} with ${base}${where}: ${(e as Error).message}`, true);
    }

    const outcome = await deps.request(binding.sessionId, {
      tool: OPEN_BRANCH_REVIEW_TOOL,
      projectName: binding.projectName,
      repo: discovery.rootIsRepo ? null : repo.path,
      base,
      head,
    }, OPEN_BRANCH_REVIEW_WAIT_MS);
    if (!outcome.ok) {
      const hint = outcome.reason === "no-device"
        ? ` The user can open it from Source Control → Branch Review, with ${base} as the base and ${head} to review.`
        : "";
      return textResult(outcome.message + hint, true);
    }
    if (!outcome.result.opened) {
      return textResult(`The user's device could not open Branch Review: ${deviceError(outcome.result.error)}`, true);
    }

    const additions = diff.files.reduce((n, f) => n + f.additions, 0);
    const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);
    const listed = diff.files.length + diff.omitted;
    const lines = [
      `Opened Branch Review${where} on the user's device: ${head} against ${base} `
        + `(merge base ${diff.mergeBase.slice(0, 7)}).`,
      listed === 0
        ? "The two have identical trees: the review is empty."
        : `${plural(listed, "file")} changed, +${additions.toLocaleString("en-US")} −${deletions.toLocaleString("en-US")}`
          + (diff.omitted ? ` (${plural(diff.omitted, "file")} past the tab's limit are not listed).` : "."),
    ];
    if (head === checkedOut) {
      const status = await git(repo.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
      const pending = status.ok ? status.out.split("\n").filter(Boolean).length : 0;
      if (pending) {
        lines.push(
          `${plural(pending, "file")} in the working tree ${pending === 1 ? "has" : "have"} changes not committed to ${head}, `
            + "which the review does not show. Commit them and call again if they belong in it.",
        );
      }
    }
    return textResult(lines.join("\n"));
  };
}
