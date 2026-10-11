import type { AssistantToolDefinition } from "./assistant-tool-family.ts";
import {
  GIT_BRANCH_TOOL, GIT_BRANCHES_TOOL, GIT_COMMIT_TOOL, GIT_DIFF_TOOL, GIT_DISCARD_TOOL, GIT_LOG_TOOL, GIT_STAGE_TOOL,
  GIT_STASH_TOOL, GIT_STATUS_TOOL, GIT_SYNC_TOOL, GIT_UNDO_TOOL,
} from "../../shared/assistant-git-tool-names.ts";

/**
 * How the git tools are described to the agent, in the order of `GIT_TOOLS`. Definitions only, so
 * the tool list can be built without loading what the tools reach (handlers:
 * `assistant-git-tools.ts`).
 */

const PROJECT = { type: "string", description: "Name of a registered PPM project, as projects_list gives it." };
const REPO = {
  type: "string",
  description: "Only when the project folder holds several repositories: the one to use, by the relative path git_status lists.",
};
const FILES = {
  type: "array", minItems: 1, maxItems: 200, items: { type: "string" },
  description: "Repository-relative paths exactly as git_status lists them.",
};
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties: { project: PROJECT, repo: REPO, ...properties }, required: ["project", ...required], additionalProperties: false,
});
const ASKS = " The user approves a card first; nothing runs without it.";

export const GIT_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: GIT_STATUS_TOOL,
    title: "Git status",
    description: "A repository's branch (upstream, ahead/behind), any merge or rebase under way, changed files with staged "
      + "and unstaged line counts (up to 300), the last commit (and whether it is pushed), stashes, and discards that can "
      + "still be undone. For a project folder holding several repositories without `repo`, lists them instead.",
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: GIT_LOG_TOOL,
    title: "Git history",
    description: "Commits of every branch, newest first: hash, subject, body (shortened), author name, date, parents and refs.",
    inputSchema: object({
      max: { type: "integer", minimum: 1, maximum: 100, description: "How many commits (default 30)." },
      skip: { type: "integer", minimum: 0, description: "How many to skip, for the next page." },
    }),
    annotations: READ_ONLY,
  },
  {
    name: GIT_DIFF_TOOL,
    title: "Git diff",
    description: "A diff, cut at 40 KB. With `file` alone: that file's uncommitted changes, staged and unstaged. With `from` "
      + "(and `file`): the working tree, or that file, against a revision. With `from` and `to`: between two revisions.",
    inputSchema: object({
      file: { type: "string", description: "Repository-relative path." },
      from: { type: "string", description: "A revision: a branch, tag, hash or HEAD~1." },
      to: { type: "string", description: "A second revision, with `from`." },
    }),
    annotations: READ_ONLY,
  },
  {
    name: GIT_BRANCHES_TOOL,
    title: "Git branches",
    description: "Local and remote branches (remotes by name only), the current branch and its upstream.",
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: GIT_STAGE_TOOL,
    title: "Stage or unstage files",
    description: `Stage files for the next commit, or with \`unstage: true\` take them back out of it (their edits stay).${ASKS}`,
    inputSchema: object({ files: FILES, unstage: { type: "boolean", description: "Unstage instead of stage." } }, ["files"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: GIT_DISCARD_TOOL,
    title: "Discard unstaged changes",
    description: "Throw away files' unstaged changes; an untracked file is deleted. Staged changes are untouched. PPM keeps a "
      + `copy for one day (except files over 20 MB) and answers with an undo id for git_undo.${ASKS}`,
    inputSchema: object({ files: FILES }, ["files"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: GIT_UNDO_TOOL,
    title: "Undo a discard or the last commit",
    description: "`kind: \"discard\"` with `id` writes back what a discard threw away. `kind: \"commit\"` with `hash` undoes "
      + `the last commit while it is not pushed: its changes stay staged and its message returns to the commit box.${ASKS}`,
    inputSchema: object({
      kind: { type: "string", enum: ["discard", "commit"] },
      id: { type: "string", description: "The discard's id (kind discard)." },
      hash: { type: "string", description: "The last commit's id (kind commit)." },
    }, ["kind"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: GIT_COMMIT_TOOL,
    title: "Commit staged changes",
    description: "Commit what is staged; the repository's hooks run. `message` is committed verbatim, byte for byte: when "
      + "the user gave the message, pass exactly what they wrote and add nothing to it (no Co-Authored-By or other "
      + "trailer, no extra line) unless they ask. `amend` replaces the last "
      + `commit (with no message it keeps its message).${ASKS}`,
    inputSchema: object({
      message: { type: "string", description: "The commit message, committed verbatim. The user's own words when they gave them, with nothing added." },
      amend: { type: "boolean" },
      signoff: { type: "boolean", description: "Add a Signed-off-by line. Only when the user asks for one." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: GIT_SYNC_TOOL,
    title: "Fetch, pull or push",
    description: "`fetch` every remote; `pull` the current branch's upstream (merge, or `rebase: true`); `push` the current "
      + `branch to its upstream, or publish it to the remote if it has none. Never a force push.${ASKS}`,
    inputSchema: object({
      action: { type: "string", enum: ["fetch", "pull", "push"] },
      rebase: { type: "boolean", description: "Pull with rebase." },
    }, ["action"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: GIT_BRANCH_TOOL,
    title: "Create or switch branch",
    description: "`create` a branch (from `from`, default HEAD) and switch to it, or `switch` to a branch; one only on a "
      + `remote gets a local branch following it. Uncommitted changes come along.${ASKS}`,
    inputSchema: object({
      action: { type: "string", enum: ["create", "switch"] },
      name: { type: "string", description: "The branch name." },
      from: { type: "string", description: "Where a new branch starts (create only)." },
    }, ["action", "name"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: GIT_STASH_TOOL,
    title: "Stash changes",
    description: "`save` the uncommitted changes to a new stash (untracked files only with `includeUntracked`); `apply`, `pop` "
      + `or \`drop\` the stash at \`index\` (from git_status).${ASKS}`,
    inputSchema: object({
      action: { type: "string", enum: ["save", "apply", "pop", "drop"] },
      message: { type: "string", description: "The stash's message (save)." },
      includeUntracked: { type: "boolean", description: "Also stash untracked files (save)." },
      index: { type: "integer", minimum: 0, description: "The stash's index (apply, pop, drop)." },
    }, ["action"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];
