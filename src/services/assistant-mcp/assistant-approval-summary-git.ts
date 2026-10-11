import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import { exactFact, fact } from "./assistant-approval-summary.ts";

/**
 * The approval cards of the Assistant's git tools. Built only from what the tool read back
 * through PPM's own git routes — the files git lists, the branch it reports, the stash it holds —
 * plus the one agent-written text that will actually be used (a commit or stash message), shown
 * verbatim in the card's body. Paths, branches and the repository are exact facts: a cut copy
 * could name a different file than the one acted on. Long lists live in the body, after which a
 * count fact lets the user check that nothing was hidden in a message made to look like a list.
 */

/** Where a git card acts: always shown, whatever the tool. */
export interface GitCardTarget {
  project: string;
  /** Path relative to the project, `.` for the project folder itself. */
  repository: string;
  /** The branch checked out, or null on a detached HEAD. */
  branch: string | null;
  /** The commit HEAD is on, for a detached HEAD's label. */
  oid: string | null;
}

const short = (hash: string | null | undefined): string => (hash ? hash.slice(0, 7) : "(none)");

export function branchLabel(target: Pick<GitCardTarget, "branch" | "oid">): string {
  if (target.branch) return target.branch;
  return target.oid ? `detached HEAD at ${short(target.oid)}` : "no commit yet";
}

export const repositoryLabel = (relative: string): string => (relative === "." ? ". (the project folder)" : relative);

function targetFacts(target: GitCardTarget): ApprovalFact[] {
  return [
    exactFact("Project", target.project),
    exactFact("Repository", repositoryLabel(target.repository)),
    exactFact("Branch", branchLabel(target)),
  ];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const fileList = (paths: string[]): string => paths.join("\n");

export function gitStageSummary(input: { target: GitCardTarget; files: Array<{ path: string; conflict?: boolean }>; unstage: boolean }): ApprovalSummary {
  const n = input.files.length;
  const resolving = input.files.filter((f) => f.conflict).length;
  return {
    headline: input.unstage
      ? `Unstage ${plural(n, "file")} in "${input.target.project}" (the changes stay in the files)`
      : `Stage ${plural(n, "file")} in "${input.target.project}" for the next commit`,
    facts: [...targetFacts(input.target), fact("Files", String(n))],
    body: { label: "Files", text: fileList(input.files.map((f) => (f.conflict ? `${f.path}  (conflict — staging marks it resolved)` : f.path))), format: "text" },
    ...(resolving ? { warning: `${plural(resolving, "file")} still in conflict: staging marks them resolved as they are now.` } : {}),
  };
}

export interface DiscardFile {
  path: string;
  untracked: boolean;
  /** Over the size PPM keeps a copy of, so its discard cannot be undone. */
  tooLarge: boolean;
}

export const DISCARD_KEEP_WARNING = "PPM keeps a copy for one day; undo with git_undo or Source Control. Staged changes are untouched.";

export function gitDiscardSummary(input: { target: GitCardTarget; files: DiscardFile[] }): ApprovalSummary {
  const lost = input.files.filter((f) => f.tooLarge).length;
  const lines = input.files.map((f) => {
    const notes = [f.untracked ? "new file — deleted" : null, f.tooLarge ? "over 20 MB — not kept, cannot be undone" : null].filter(Boolean);
    return notes.length ? `${f.path}  (${notes.join("; ")})` : f.path;
  });
  return {
    headline: `Discard the unstaged changes to ${plural(input.files.length, "file")} in "${input.target.project}"`,
    facts: [
      ...targetFacts(input.target),
      fact("Files", String(input.files.length)),
      ...(lost ? [fact("Cannot be undone", plural(lost, "file"), "warning")] : []),
    ],
    body: { label: "Files", text: fileList(lines), format: "text" },
    warning: DISCARD_KEEP_WARNING,
  };
}

export function gitUndoDiscardSummary(input: {
  target: GitCardTarget;
  record: { id: string; kind: "hunks" | "files"; paths: string[]; createdAt: number; skipped?: string[] };
}): ApprovalSummary {
  const { record } = input;
  const what = record.kind === "hunks" ? `the discarded blocks of ${plural(record.paths.length, "file")}` : plural(record.paths.length, "file");
  return {
    headline: `Undo a discard in "${input.target.project}": write back ${what}`,
    facts: [
      ...targetFacts(input.target),
      exactFact("Discard", record.id),
      fact("Discarded at", new Date(record.createdAt).toISOString()),
      ...(record.skipped?.length ? [fact("Not kept (gone for good)", String(record.skipped.length), "warning")] : []),
    ],
    body: { label: "Files written back", text: fileList(record.paths), format: "text" },
    warning: "Each file goes back to how it was before the discard. If one has changed since, PPM writes nothing.",
  };
}

export function gitUndoCommitSummary(input: { target: GitCardTarget; commit: { hash: string; subject: string } }): ApprovalSummary {
  return {
    headline: `Undo the last commit in "${input.target.project}"`,
    facts: [
      ...targetFacts(input.target),
      exactFact("Commit", input.commit.hash),
      fact("Subject", input.commit.subject),
    ],
    warning: "Its changes stay staged, and its message goes back to the commit box.",
  };
}

export interface CommitFile {
  path: string;
  oldPath?: string;
  /** git's index letter for the file: M, A, D, R, C, T. */
  x: string;
}

export function gitCommitSummary(input: {
  target: GitCardTarget;
  files: CommitFile[];
  message: string;
  amend: { hash: string; subject: string; pushed: boolean } | null;
  signoff: boolean;
}): ApprovalSummary {
  const n = input.files.length;
  const lines = input.files.map((f) => `${f.x}  ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`);
  const message = input.message.trim() ? input.message : "(unchanged — the amended commit keeps its message)";
  return {
    headline: input.amend
      ? `Amend the last commit in "${input.target.project}" with ${plural(n, "staged file")}`
      : `Commit ${plural(n, "staged file")} in "${input.target.project}"`,
    facts: [
      ...targetFacts(input.target),
      fact("Staged files", String(n)),
      ...(input.amend ? [exactFact("Replaces commit", short(input.amend.hash)), fact("Its subject", input.amend.subject)] : []),
      ...(input.signoff ? [fact("Sign-off", "A Signed-off-by line is added")] : []),
      fact("Hooks", "The repository's commit hooks run, as when you commit in PPM."),
    ],
    // The files come first, so a message written to look like a file list cannot pass for one.
    body: { label: "Commit", text: `Files (${n}):\n${fileList(lines) || "(none)"}\n\nMessage:\n${message}`, format: "text" },
    ...(input.amend?.pushed
      ? { warning: "That commit is already on the remote: amending rewrites pushed history, and pushing it then needs a force push, which PPM never does." }
      : {}),
  };
}

export function gitFetchSummary(input: { target: GitCardTarget }): ApprovalSummary {
  return {
    headline: `Fetch from every remote of the repository in "${input.target.project}"`,
    facts: targetFacts(input.target),
    warning: "This contacts the remotes. Nothing in your files changes; only what PPM knows about the remote branches is updated.",
  };
}

export function gitPullSummary(input: { target: GitCardTarget; upstream: string; ahead: number; behind: number; rebase: boolean }): ApprovalSummary {
  return {
    headline: `Pull ${input.upstream} into ${branchLabel(input.target)} in "${input.target.project}"`,
    facts: [
      ...targetFacts(input.target),
      exactFact("Upstream", input.upstream),
      fact("Behind / ahead", `${input.behind} behind, ${input.ahead} ahead, as of the last fetch`),
      fact("How", input.rebase
        ? `Rebase: your local commits (${input.ahead}) are replayed on top of the upstream`
        : "Merge, unless the repository is configured otherwise"),
    ],
    warning: "This contacts the remote and changes your files. A conflict stops the pull part way, to be resolved in PPM.",
  };
}

export function gitPushSummary(input: {
  target: GitCardTarget;
  /** The upstream pushed to; null publishes the branch. */
  upstream: string | null;
  ahead: number;
  behind: number;
  head: { hash: string; subject: string } | null;
}): ApprovalSummary {
  const publish = input.upstream === null;
  const branch = branchLabel(input.target);
  return {
    headline: publish
      ? `Publish ${branch} from "${input.target.project}" to its remote for the first time`
      : `Push ${plural(input.ahead, "commit")} of ${branch} to ${input.upstream}`,
    facts: [
      ...targetFacts(input.target),
      publish
        ? fact("To", "origin if the repository has it, otherwise its first remote; it becomes the branch's upstream")
        : exactFact("To", input.upstream!),
      fact("Commits", publish ? "the whole branch" : String(input.ahead)),
      fact("Force", "Never — PPM does not force push"),
    ],
    ...(input.head ? { body: { label: "Newest commit pushed", text: `${input.head.hash}\n${input.head.subject}`, format: "text" as const } } : {}),
    warning: input.behind > 0
      ? `${branch} is ${plural(input.behind, "commit")} behind ${input.upstream}: the push will likely be refused. Pull first.`
      : "This sends your commits to the remote, where others can see them.",
  };
}

export function gitBranchSummary(input: {
  target: GitCardTarget;
  action: "create" | "switch";
  /** The branch switched to or created. */
  name: string;
  /** Where a new branch starts; null starts it at HEAD. */
  from: string | null;
  /** A remote branch a new local one will follow. */
  tracks: string | null;
  uncommitted: number;
}): ApprovalSummary {
  const current = branchLabel(input.target);
  return {
    headline: input.action === "create"
      ? `Create the branch ${input.name} in "${input.target.project}" and switch to it`
      : input.tracks
        ? `Switch to ${input.name}, a new local branch following ${input.tracks}`
        : `Switch from ${current} to ${input.name}`,
    facts: [
      ...targetFacts(input.target),
      exactFact("From", current),
      exactFact("To", input.name),
      ...(input.action === "create" ? [exactFact("Starts at", input.from ?? `HEAD (${current})`)] : []),
      ...(input.tracks ? [exactFact("Follows", input.tracks)] : []),
      fact("Uncommitted changes", String(input.uncommitted)),
    ],
    ...(input.uncommitted
      ? { warning: `${plural(input.uncommitted, "uncommitted change")} ${input.uncommitted === 1 ? "comes" : "come"} along; git refuses if they would be overwritten.` }
      : {}),
  };
}

export function gitStashSaveSummary(input: { target: GitCardTarget; files: string[]; message: string | null; includeUntracked: boolean }): ApprovalSummary {
  const n = input.files.length;
  const text = `Files (${n}):\n${fileList(input.files)}${input.message ? `\n\nMessage:\n${input.message}` : ""}`;
  return {
    headline: `Stash ${plural(n, "changed file")} in "${input.target.project}" and clean them from the working tree`,
    facts: [
      ...targetFacts(input.target),
      fact("Files", String(n)),
      fact("Untracked files", input.includeUntracked ? "Included" : "Left in place"),
    ],
    body: { label: "Stash", text, format: "text" },
    warning: "The changes come back with git_stash apply or pop, or from Source Control.",
  };
}

export interface StashCard {
  index: number;
  hash: string;
  message: string;
  branch: string | null;
  date: string;
}

const STASH_VERBS = { apply: "Apply", pop: "Pop", drop: "Drop" } as const;
const STASH_WARNINGS = {
  apply: "Its changes are written into your files; the stash stays in the list.",
  pop: "Its changes are written into your files and the stash leaves the list once it applies.",
  drop: "The stash is deleted and cannot be brought back from PPM.",
} as const;

export function gitStashEntrySummary(input: { target: GitCardTarget; action: "apply" | "pop" | "drop"; stash: StashCard }): ApprovalSummary {
  const { stash } = input;
  return {
    headline: `${STASH_VERBS[input.action]} stash@{${stash.index}} in "${input.target.project}"`,
    facts: [
      ...targetFacts(input.target),
      exactFact("Stash", `stash@{${stash.index}} ${short(stash.hash)}`),
      fact("Message", stash.message),
      ...(stash.branch ? [exactFact("Made on", stash.branch)] : []),
      fact("Date", stash.date),
    ],
    warning: STASH_WARNINGS[input.action],
  };
}
