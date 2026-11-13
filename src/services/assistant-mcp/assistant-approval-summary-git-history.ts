import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { GitOperation } from "../../shared/git-changes.ts";
import type { PresentHooks } from "../git-workflow/git-hooks-present.ts";
import { exactFact, fact } from "./assistant-approval-summary.ts";
import { branchLabel, short, targetFacts, type GitCardTarget } from "./assistant-approval-summary-git.ts";

/**
 * The cards of `git_history` (merge, cherry-pick, revert, tag, abort, continue) and of
 * `git_branch`'s delete. Built only from what PPM's git routes answered: the branch and commit
 * HEAD is on, the source branch's tip, the commit picked or reverted as the history lists it.
 * A commit subject is repository text: it is cut, quoted, and never the only name of the
 * commit — the hash beside it is exact. Every card says which of the repository's own hooks
 * the operation runs, because those run inside PPM.
 */

export interface HistoryCommit {
  hash: string;
  subject: string;
}

export type HistoryCard =
  | { action: "merge"; source: string; sourceTip: string | null }
  | { action: "cherry_pick" | "revert"; commit: HistoryCommit }
  | { action: "tag"; name: string; commit: HistoryCommit }
  | { action: "abort" | "continue"; operation: GitOperation };

const quoted = (subject: string): string => {
  const line = subject.split("\n")[0] ?? "";
  return `"${line.length > 80 ? `${line.slice(0, 80)}…` : line}"`;
};

/** The hooks fact: the ones found, or, when git could not say where hooks live, that they may run. */
export function hooksFacts(hooks: PresentHooks | null): ApprovalFact[] {
  if (!hooks) return [fact("Hooks", "Could not tell where this repository keeps its git hooks; any it has will run.", "warning")];
  const facts: ApprovalFact[] = [];
  if (hooks.hooks.length) facts.push(exactFact("Hooks", `Runs this repository's git hooks: ${hooks.hooks.join(", ")} (${hooks.where})`, "warning"));
  if (hooks.incoming === null) {
    facts.push(fact("Incoming hooks", "Could not tell which git hooks the incoming commit adds; any it adds will run.", "warning"));
  } else if (hooks.incoming?.length) {
    facts.push(exactFact("Incoming hooks", `Added by the incoming commit, then run: ${hooks.incoming.join(", ")} (${hooks.where})`, "warning"));
  }
  return facts;
}

const operationLabel = (op: GitOperation): string => {
  const what = op.name ?? op.head ?? null;
  const progress = op.step && op.total ? `, step ${op.step} of ${op.total}` : "";
  return `${op.kind}${what ? ` of ${what}` : ""}${progress}`;
};

export function gitHistorySummary(input: { target: GitCardTarget; card: HistoryCard; hooks: PresentHooks | null }): ApprovalSummary {
  const { target, card } = input;
  const head = branchLabel(target);
  const where = [...targetFacts(target), exactFact("HEAD at", short(target.oid))];
  const hooks = hooksFacts(input.hooks);
  switch (card.action) {
    case "merge":
      return {
        headline: `Merge ${card.source} into ${head}`,
        facts: [
          ...where,
          exactFact("Source", card.source),
          exactFact("Source at", short(card.sourceTip)),
          fact("Conflicts", "Conflicts stop the merge; finish or abort it with git_history"),
          ...hooks,
        ],
        warning: "Your files change, and a merge commit is made unless the branch only moves forward.",
      };
    case "cherry_pick":
    case "revert": {
      const pick = card.action === "cherry_pick";
      return {
        headline: pick
          ? `Copy commit ${short(card.commit.hash)} ${quoted(card.commit.subject)} onto ${head}`
          : `Add a commit undoing ${short(card.commit.hash)} ${quoted(card.commit.subject)} on ${head}`,
        facts: [...where, exactFact(pick ? "Commit copied" : "Commit undone", card.commit.hash), fact("Its subject", card.commit.subject), ...hooks],
        warning: `Your files change and a new commit is made on ${head}. A conflict stops it part way; finish or abort it with git_history.`,
      };
    }
    case "tag":
      return {
        headline: `Tag ${short(card.commit.hash)} ${quoted(card.commit.subject)} as ${card.name}`,
        facts: [...where, exactFact("Tag", card.name), exactFact("Commit", card.commit.hash), fact("Its subject", card.commit.subject), ...hooks],
        warning: "A lightweight tag, kept in this repository only: the git tools never push tags.",
      };
    case "abort":
      return {
        headline: `Abort the ${card.operation.kind} — the tree returns to before it started`,
        facts: [...where, fact("Operation", operationLabel(card.operation)), ...hooks],
        warning: `Everything the ${card.operation.kind} changed so far is thrown away, conflicts resolved by hand included.`,
      };
    case "continue":
      return {
        headline: `Continue the ${card.operation.kind} — creates its commit`,
        facts: [...where, fact("Operation", operationLabel(card.operation)), ...hooks],
        warning: "The resolved files are committed exactly as they are staged now.",
      };
  }
}

export function gitBranchDeleteSummary(input: {
  target: GitCardTarget;
  name: string;
  /** The commit the branch points at, so the answer and the card can bring it back. */
  commit: string;
  force: boolean;
  hooks: PresentHooks | null;
}): ApprovalSummary {
  return {
    headline: `Delete the branch ${input.name} in "${input.target.project}"`,
    facts: [
      ...targetFacts(input.target),
      exactFact("Deletes", input.name),
      exactFact("Its last commit", input.commit),
      fact("Force", input.force ? "Yes — deleted even if it is not merged" : "No — git refuses if it is not merged"),
      ...hooksFacts(input.hooks),
    ],
    warning: input.force
      ? "Forced: its commits not on another branch become unreachable, and git may later remove them for good."
      : "Only the branch name goes; git refuses if its commits are not merged into the current branch or its upstream.",
  };
}
