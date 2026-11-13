import { basename, join, resolve } from "node:path";
import { getDbPath, getDbProfile } from "../db.service.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { commandPathsWithRouting } from "./ppm-cli-routing.ts";

/**
 * What the Assistant's `ppm_cli_reference` tool answers: how to run the PPM CLI against *this*
 * PPM and how each command reaches it, then the reference itself, generated from the command tree
 * (`bun scripts/generate-ppm-cli-reference.ts --update` rewrites `PPM_CLI_REFERENCE` below; a
 * test fails when it drifts). Asked for one `group`, it answers that group's commands; asked for
 * none, the header and an index of the groups, which keeps the usual answer short.
 *
 * The Assistant's shell carries `PPM_PROFILE` and `PPM_INSTANCE_ID` (`assistant-shell-env.ts`),
 * so a command reaches this server on this database, and every command that goes through a
 * server prints the one it reached. The header tells the Assistant to check that line.
 */

export interface PpmInstance {
  ppmDir: string;
  dbFile: string;
  /** The database profile this server runs on; null for the default `ppm.db`. */
  profile: string | null;
  /** How to invoke this PPM's own CLI from a shell. */
  command: string;
}

const quote = (p: string): string => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

export function currentPpmInstance(): PpmInstance {
  // A compiled binary is its own CLI; from source (or an npm install) the entry is src/index.ts.
  const compiled = import.meta.url.includes("$bunfs");
  const command = compiled ? quote(process.execPath) : `bun ${quote(join(resolve(import.meta.dir, "..", "..", ".."), "src", "index.ts"))}`;
  return { ppmDir: getPpmDir(), dbFile: getDbPath(), profile: getDbProfile(), command };
}

/**
 * The Assistant's own tools that replace whole command groups. They call the routes PPM's screens
 * call (same checks, same live updates) and show a card PPM builds, where a shell call shows only
 * the command line — so the reference sends the Assistant to them first.
 */
export const TOOLS_INSTEAD_OF_CLI: readonly { area: string; tools: readonly string[] }[] = [
  {
    area: "Git (instead of `ppm git`)",
    tools: ["git_status", "git_log", "git_diff", "git_branches", "git_stage", "git_discard", "git_undo",
      "git_commit", "git_sync", "git_branch", "git_stash", "git_history"],
  },
  {
    area: "Schedules (instead of `ppm schedule`)",
    tools: ["schedules_list", "schedule_get", "schedule_save", "schedule_delete", "schedule_run_now"],
  },
  {
    area: "Port forwards and PPM's own public link",
    tools: ["tunnels_status", "port_forward_start", "port_forward_stop", "public_link_set"],
  },
  {
    area: "Projects (instead of `ppm projects` add, rename, move, color, remove)",
    tools: ["projects_list", "project_add", "project_update", "project_remove"],
  },
  {
    area: "Chats (instead of `ppm chat` stop, rename, pin, tag, read, delete, changes, revert-turn)",
    tools: ["chat_stop", "chat_organize", "chat_delete", "chat_changes", "chat_changes_answer"],
  },
  {
    area: "Database connections (instead of `ppm db` add, edit, remove, test)",
    tools: ["db_connection_save", "db_connection_delete", "db_connection_test"],
  },
];

export interface ReferenceOptions {
  /** The provider of the session asking; `codex` runs its shell in a sandbox with no network. */
  provider?: string | null;
}

const list = (paths: readonly string[]) => paths.map((p) => `ppm ${p}`).join(", ");

export function ppmCliReferenceHeader(instance: PpmInstance, opts: ReferenceOptions = {}): string {
  const target = `→ PPM ${instance.profile ?? "default"} (${basename(instance.dbFile)}) at 127.0.0.1:<port>`;
  const lines = [
    "# Running `ppm` from this Assistant",
    "",
    `This PPM keeps its data in ${instance.ppmDir} (database ${basename(instance.dbFile)}). Invoke the CLI as: ${instance.command}`,
    "Your shell already names this PPM (PPM_HOME, PPM_PROFILE, PPM_INSTANCE_ID): do not pass --profile or --instance.",
    "Every shell command asks the user first; say what the command does when you ask.",
    `A command that goes through the server prints the PPM it reached on stderr: \`${target}\`.`,
    "If that line names another database, stop and tell the user. A command that would change another PPM's",
    "database is refused from here.",
    "",
  ];
  if (opts.provider === "codex") {
    lines.push(
      "Your shell runs in a read-only sandbox with no network, so a `ppm` command cannot reach PPM from inside it.",
      "Run every `ppm` command with escalated permissions (`sandbox_permissions: \"require_escalated\"` and a",
      "one-line `justification`). The user still approves each one; with the sandbox, the command fails.",
      "",
    );
  }
  lines.push(
    "## Use the Assistant's tools instead",
    "These areas have tools of their own. They go through the running server's own checks, update PPM's",
    "screens at once, and show the user a card that says what will change. Use them, not the commands below:",
    ...TOOLS_INSTEAD_OF_CLI.map(({ area, tools }) => `- ${area}: ${tools.join(", ")}`),
    "Run `ppm git` only for what the git tools leave out (worktrees, for instance).",
    "`ppm git` stages, unstages and discards whole files; staging single blocks of a file is done in PPM's Source Control.",
    "",
    "## Commands that go through the running server (prefer these)",
    "They change the running PPM itself, with the checks PPM's screens make. With no PPM running they write",
    "the database directly and say so.",
    `- ${list(commandPathsWithRouting("server"))}`,
    "- schedule run-now: prefer the schedule_run_now tool",
    "- projects add/rename/move/remove: prefer project_add, project_update and project_remove",
    "- chat stop/rename/pin/tag/read/delete: prefer chat_stop, chat_organize and chat_delete",
    "- chat stop sends the stop PPM's Stop button sends; chat delete stops a running turn first and deletes nothing if it does not stop",
    "- chat changes/turns/revert-turn: prefer chat_changes and chat_changes_answer; revert-turn prints its preview and writes only with --yes",
    "- git: prefer the git tools; every git command takes -p <project> and --repo <path> (a repository inside the project)",
    "- db add/edit/remove/test: prefer db_connection_save, db_connection_delete and db_connection_test. Neither path sends",
    "  read-only: a new connection is read-only, and the tools cannot make one writable. A shell command can reach any of",
    "  PPM's routes, so there the user's approval of the command is the control. db import is refused from an AI chat",
    "",
    "## Commands that write PPM's data directly",
    "The running server keeps much of this in memory: a change may not show until it restarts, and the",
    "server may write its own copy back over it. Prefer the Assistant's tools or the PPM screen where one exists.",
    `- ${list(commandPathsWithRouting("direct-pending"))}`,
    "",
    "## Commands that need no server",
    "Process control, setup, reading, and work outside PPM's live data (a repository, a backup, the cloud account).",
    `- ${list(commandPathsWithRouting("direct-allowed"))}`,
    "",
  );
  return lines.join("\n");
}

/** The generated reference cut at its `## ` headings: `core` for the top-level commands, else the group's name. */
export function cliReferenceSections(reference: string = PPM_CLI_REFERENCE): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of reference.split(/\n(?=## )/).slice(1)) {
    const heading = part.slice(3, part.indexOf("\n") === -1 ? undefined : part.indexOf("\n"));
    const name = heading.startsWith("Core Commands") ? "core" : heading.startsWith("ppm ") ? heading.slice(4).split(" ")[0]! : heading.toLowerCase();
    out.set(name, part.trimEnd());
  }
  return out;
}

function groupIndex(sections: Map<string, string>): string {
  const rows = [...sections.entries()].filter(([name]) => name !== "tips").map(([name, text]) => {
    const heading = text.slice(3, text.indexOf("\n"));
    const count = (text.match(/^ppm /gm) ?? []).length;
    return `- ${name}: ${heading.includes(" — ") ? heading.split(" — ")[1] : heading} (${count} command${count === 1 ? "" : "s"})`;
  });
  return ["## Command groups", "Ask for one with `group` (for example `group: \"config\"`) to see its commands and options.", ...rows].join("\n");
}

/** The tool's whole answer: the header, then one group's commands, or the index of groups. */
export function ppmCliReference(instance: PpmInstance = currentPpmInstance(), opts: ReferenceOptions & { group?: string } = {}): string {
  const header = ppmCliReferenceHeader(instance, opts);
  const sections = cliReferenceSections();
  if (!opts.group) return `${header}\n${groupIndex(sections)}\n`;
  const section = sections.get(opts.group.trim().toLowerCase());
  if (!section) return `${header}\nNo command group "${opts.group}". ${groupIndex(sections)}\n`;
  return `${header}\n${section}\n${sections.get("tips") ?? ""}\n`;
}

export const PPM_CLI_REFERENCE = `# PPM CLI Reference
## Core Commands (Server & system management)
\`\`\`
ppm start
  Start the PPM server (background by default)
  --minimal — Minimal workspace: chat, files, editor and settings
  -p, --port <port> — Port to listen on
  -s, --share — (deprecated) Tunnel is now always enabled
  --profile <name> — DB profile name (e.g. 'dev' → ppm.dev.db)

ppm stop
  Stop the PPM server (supervisor stays alive)
  -a, --all — Kill all PPM and cloudflared processes (including untracked)
  --kill — Full shutdown (kills supervisor too)

ppm down
  Fully shut down PPM (supervisor + server + tunnel)

ppm restart
  Restart the server (keeps tunnel alive)
  --force — Force resume from paused state

ppm status
  Show PPM daemon status
  -a, --all — Show all PPM and cloudflared processes (including untracked)
  --json — Output as JSON

ppm open
  Open PPM in browser

ppm logs
  View PPM daemon logs
  -n, --tail <lines> — Number of lines to show [default: 50]
  -f, --follow — Follow log output
  -l, --level <level> — Only this level and above: debug, info, warn, error, fatal
  --clear — Clear log file

ppm report
  Report a bug on GitHub (pre-fills env info + logs)

ppm init
  Initialize PPM configuration (interactive or via flags)
  -p, --port <port> — Port to listen on
  --scan <path> — Directory to scan for git repos
  --auth — Enable authentication
  --no-auth — Disable authentication
  --password <pw> — Set access password
  --share — Pre-install cloudflared for sharing
  -y, --yes — Non-interactive mode (use defaults + flags)

ppm device-name <name>
  Name this machine, as PPM's title and PPM Cloud show it ("" clears it)

ppm upgrade
  Check for and install PPM updates
  --check — Only check for updates, don't install

ppm backup
  Snapshot the PPM config database now
  --json — Output as JSON

ppm restore [backup]
  Restore the PPM config database from a snapshot
  --list — List available snapshots and exit
  --force — Restore even while PPM is running (stop it first when you can)
  --json — Output as JSON
\`\`\`
## ppm projects — Manage registered projects
\`\`\`
ppm projects list
  List all registered projects
  --json — Output as JSON

ppm projects add <path>
  Add a project to the registry, through the running PPM when one holds the database
  -n, --name <name> — Project name (defaults to folder name)

ppm projects remove <name>
  Remove a project from the registry (by name or folder); its files stay on disk

ppm projects rename <name> <newName>
  Rename a project; its chats and settings stay with it

ppm projects move <name> <path>
  Point a project at another folder; the old folder is left as it is

ppm projects color <name> <color>
  Set a project's colour (#rrggbb), or \`none\` to clear it

ppm projects icon <name> [file]
  Set a project's icon from a PNG, JPEG, GIF or WebP file (2 MB at most), or --clear it
  --clear — Remove the project's icon

ppm projects reorder <names...>
  Put projects in this order; projects not named keep their order after them

ppm projects clone <url> <dir>
  Clone a git repository into <dir>/<name> and register it as a project
  -n, --name <name> — Folder and project name (defaults to the repository's name)

ppm projects settings get <name>
  Print a project's settings as JSON
  --json — Print the JSON alone, with no banner

ppm projects settings set <name> <key> <value>
  Set one setting by its dotted key (e.g. files.useIgnoreFiles false, files.filesExclude '["dist"]')
\`\`\`
## ppm config — Get or set PPM configuration
\`\`\`
ppm config get <key>
  Get a config value (e.g. port, auth.enabled)

ppm config set <key> <value>
  Set a config value (e.g. port 9090), through the running PPM when one holds the database
\`\`\`
## ppm git — Git operations for a project, through the running PPM
\`\`\`
ppm git status
  Show the branch and every changed file, as Source Control does
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git log
  Show recent commits
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  -n, --count <n> — Number of commits to show [default: 20]

ppm git diff [ref1] [ref2]
  Show the diff between two refs, or of the working tree
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git stage <files...>
  Stage files (use "." to stage all)
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git unstage <files...>
  Unstage files
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git discard <files...>
  Throw away the files' unstaged changes; PPM keeps a copy to undo it
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git commit
  Commit the staged changes
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  -m, --message <msg> — Commit message (required unless --amend)
  --amend — Replace the last commit
  --signoff — Add a Signed-off-by line

ppm git undo discard <id>
  Put back what a discard threw away (the id 'ppm git discard' printed)
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git undo commit <hash>
  Undo the last commit, keeping its changes staged; refused if it was pushed
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git fetch
  Fetch from every remote, or one
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --remote <name> — Only this remote
  --prune — Drop remote-tracking branches the remote no longer has

ppm git pull
  Pull the current branch from its upstream
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --rebase — Rebase instead of merging

ppm git push
  Push the current branch, or a branch to a named remote
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --remote <name> — A remote the repository has (default: the branch's own)
  --branch <name> — The branch to push (needs --remote)

ppm git publish
  Push a branch with no upstream and make the remote branch its upstream
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git branch create <name>
  Create a branch and check it out
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --from <ref> — Base ref (commit/branch/tag)

ppm git branch checkout <name>
  Switch to a branch, tag or commit
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --detach — Check out the commit itself, on no branch
  --track — For a remote branch: create the local branch that follows it

ppm git branch delete <name>
  Delete a branch
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  -f, --force — Delete it even when it is not merged

ppm git branch merge <source>
  Merge a branch into the current branch
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git cherry-pick <hash>
  Apply one commit's change on the current branch
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git revert <hash>
  Make a commit that undoes another
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git tag <name>
  Tag the current commit, or another
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --at <hash> — The commit to tag (default: HEAD)

ppm git abort
  Abandon the merge, rebase, cherry-pick or revert that stopped part way
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git continue
  Finish the merge, rebase, cherry-pick or revert that stopped part way
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git stash save
  Stash the working tree's changes
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  -m, --message <msg> — A message for the stash
  -u, --include-untracked — Stash untracked files too

ppm git stash list
  List the stashes
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git stash apply <index>
  Restore stash@{index}
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --expect <hash> — Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)

ppm git stash pop <index>
  Restore and delete stash@{index}
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --expect <hash> — Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)

ppm git stash drop <index>
  Delete stash@{index}
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --expect <hash> — Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)

ppm git worktree list
  List the repository's worktrees
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON

ppm git worktree add <path>
  Add a worktree beside the repository
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  --branch <ref> — An existing branch to check out in it
  -b, --new-branch <name> — Create this branch for it

ppm git worktree remove <path>
  Remove a linked worktree
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
  -f, --force — Remove it even with uncommitted changes

ppm git worktree prune
  Forget worktrees whose folders are gone
  -p, --project <name> — Project name or path (default: the project the current folder is in)
  --repo <path> — A repository inside the project, when the project folder holds several
  --json — Print the route's answer as JSON
\`\`\`
## ppm chat — Manage AI chat sessions
\`\`\`
ppm chat list
  List all chat sessions
  -p, --project <name> — Filter by project name

ppm chat create
  Create a new chat session in a project
  -p, --project <name> — Project name or path (default: the current folder's project)
  --provider <provider> — AI provider (default: PPM's default provider)
  -t, --title <title> — The chat's title

ppm chat send <session-id> <message>
  Send a message and stream response to stdout
  -p, --project <name> — Project name or path

ppm chat resume <session-id>
  Resume an interactive chat session
  -p, --project <name> — Project name or path

ppm chat rename <session-id> <title>
  Rename a chat
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat pin <session-id>
  Pin a chat to the top of its project's list
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat unpin <session-id>
  Unpin a chat
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat tag <session-id> <tag>
  Tag a chat with one of its project's tags (by name or number)
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat untag <session-id>
  Remove a chat's tag
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat read <session-id>
  Mark a chat as read
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat unread <session-id>
  Mark a chat as unread
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat stop <session-id>
  Stop the chat's running turn, as PPM's Stop button does
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat delete <session-id>
  Delete a chat; a running turn is stopped first, and nothing is deleted if it does not stop
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat fork <session-id>
  Start a new chat that carries this chat's title and settings
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat account <session-id> <account-id>
  Move a chat onto another account of its provider
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat cleanup
  Delete a project's chats older than N days; pinned, manager, branched and running chats are kept
  --older-than <days> — Age in days (at least 1) (required)
  -p, --project <name> — Project name or path (default: the current folder's project)
  --provider <id> — Only this provider's chats (default: claude)

ppm chat changes list <session-id>
  List the files a chat changed: lines, open blocks, reviewed
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)
  --json — Print the list as JSON

ppm chat changes diff <session-id> <path>
  Show one changed file's blocks (with their keys) as a diff
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat changes keep <session-id> [paths...]
  Keep a chat's changes (every unreviewed file when no path is given)
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)
  --block <keys...> — Only these blocks of the one file named (keys from \`ppm chat changes diff\`)

ppm chat changes reopen <session-id> [paths...]
  Open kept changes for review again (every kept or reviewed file when no path is given)
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)
  --block <keys...> — Only these blocks of the one file named (keys from \`ppm chat changes diff\`)

ppm chat changes revert <session-id> <paths...>
  Put files back as they were before the chat changed them; undo is offered afterwards
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)
  --block <keys...> — Only these blocks of the one file named (keys from \`ppm chat changes diff\`)

ppm chat changes undo <session-id> <undo-id>
  Undo an earlier keep, reopen or revert by the id it printed
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)

ppm chat turns <session-id>
  List a chat's newest turns with their numbers and how many calls each made
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)
  --json — Print the turns as JSON
  --limit <n> — How many of the newest turns (at most 50) [default: 20]

ppm chat revert-turn <session-id> <n>
  Put back what one turn changed: prints the preview, and writes only with --yes
  -p, --project <name> — The chat's project (default: the one PPM recorded for it)
  --yes — Write the changes the preview shows
\`\`\`
## ppm tags — Manage a project's chat tags
\`\`\`
ppm tags list
  List a project's tags and how many chats carry each
  -p, --project <name> — Project name or path (default: the current folder's project)
  --json — Print JSON

ppm tags add <name>
  Create a tag
  -p, --project <name> — Project name or path (default: the current folder's project)
  --color <hex> — Colour as #rrggbb [default: #6b7280]

ppm tags rename <tag> <newName>
  Rename a tag
  -p, --project <name> — Project name or path (default: the current folder's project)

ppm tags remove <tag>
  Delete a tag; its chats keep existing, untagged
  -p, --project <name> — Project name or path (default: the current folder's project)
\`\`\`
## ppm theme — Show, pick, import or remove PPM's themes
\`\`\`
ppm theme get
  Show the theme in use
  --json — Print JSON

ppm theme set <theme>
  Use a theme: aurora, slate, precision, or an imported theme's id or name
  --mode <mode> — light, dark or system (default: keep the current one)

ppm theme list
  List the built-in styles and the imported themes
  --json — Print JSON

ppm theme import <fileOrUrl>
  Import a VS Code color theme from a JSON file, or from a URL (JSON or .vsix)
  --name <name> — Name to show it under

ppm theme remove <id>
  Delete an imported theme

ppm theme rename <id> <name>
  Rename an imported theme
\`\`\`
## ppm ai — Show or change the AI provider settings
\`\`\`
ppm ai get [key]
  Show the AI settings, or one of them (e.g. default_provider, providers.claude.model); secrets are never shown
  --json — Print JSON

ppm ai set <key> <value>
  Change one AI setting (e.g. default_provider codex, providers.claude.effort high, ppm_tools.open_url false)

ppm ai providers
  Which providers chat can use now, and why one cannot
  --json — Print JSON

ppm ai probe <provider>
  Check a provider again now, ahead of its next scheduled try

ppm ai models <provider>
  List the models a provider offers
  --json — Print JSON
\`\`\`
## ppm keybindings — List or change PPM's keyboard shortcuts
\`\`\`
ppm keybindings list
  List the shortcuts changed from their defaults
  --json — Print JSON

ppm keybindings set <command> <keys>
  Bind a command to keys, e.g. open-chat Mod+Shift+L (Mod is Ctrl, or Cmd on a Mac)

ppm keybindings reset [command]
  Put one shortcut, or every one, back to its default
\`\`\`
## ppm proxy — Show or change the API proxy that lends your accounts to other tools
\`\`\`
ppm proxy get
  Show the proxy's state and endpoints; the auth key only as its first characters
  --reveal — Print the whole auth key
  --json — Print JSON

ppm proxy set <setting> <value>
  Switch the proxy on or off: set enabled true|false

ppm proxy key generate
  Replace the auth key with a new random one; the old key stops working
\`\`\`
## ppm settings — PPM's file filters and how long it keeps its logs
\`\`\`
ppm settings files get
  Show the global file filters
  --json — Print JSON

ppm settings files set
  Replace the global file filters; a list option replaces that whole list ("" empties it)
  --exclude <globs...> — Globs hidden from the file tree
  --search-exclude <globs...> — Globs left out of search
  --use-ignore-files <bool> — Honour .gitignore: true or false

ppm settings query-audit get
  Show how long the log is kept and what it holds
  --json — Print JSON

ppm settings query-audit set
  Change how long the log is kept
  --retention-days <n> — Days to keep a statement (at least 1)
  --max-size-mb <n> — Size the log is cut back to (at least 10)

ppm settings query-audit clear
  Delete every recorded statement (cannot be undone)
  --yes — Confirm the deletion

ppm settings trace set
  Change how long the session trace is kept
  --retention-days <n> — Days to keep a session's trace
  --max-size-mb <n> — Size the trace is cut back to
\`\`\`
## ppm notify — What PPM notifies you about, and through which channels
\`\`\`
ppm notify get
  Show the events, the delay and the channels
  --json — Print JSON

ppm notify set <event> <state>
  Switch an event (done, approval_request, question, collab_approval, schedule, jira, design_review) or a channel (telegram, ntfy) on or off

ppm notify delay <seconds>
  Wait this long, and send only if nobody has looked by then (0 sends at once; at most 3600)

ppm notify ntfy set
  Set the server and topic; the server is checked first. A new server drops the old server's token
  --server <url> — e.g. https://ntfy.sh (default: the current one)
  --topic <topic> — 1 to 64 letters, digits, - or _ (default: the current one)
  --token-prompt — Type an access token at the terminal

ppm notify ntfy remove
  Stop publishing to ntfy and forget the server, topic and token

ppm notify ntfy test
  Publish a test notification

ppm notify telegram chats
  List the chats receiving notifications
  --json — Print JSON

ppm notify telegram remove <chatId>
  Stop sending notifications to a chat

ppm notify telegram connect
  Make a one-time link: the chat that opens it receives notifications
  --cancel — Withdraw the open link

ppm notify push test
  Send a test push to every subscribed browser, or one
  --device <id> — Only this browser (see \`ppm notify get --json\`)
\`\`\`
## ppm telegram-bot — The Telegram bot notifications are sent through
\`\`\`
ppm telegram-bot get
  Show the bot (its token only as the first characters)
  --json — Print JSON

ppm telegram-bot set
  Replace the bot's token, typed at the terminal; Telegram is asked whether it is real first
  --token-prompt — Type the token from @BotFather at the terminal (required)

ppm telegram-bot remove
  Forget the bot; no Telegram notification is sent until another is set

ppm telegram-bot test
  Send a test notification to every connected chat
\`\`\`
## ppm ppmbot — PPM Assistant on Telegram: its switch, bot and connected chats
\`\`\`
ppm ppmbot get
  Show the switch, the bot and whether the bridge is running
  --json — Print JSON

ppm ppmbot set <setting> <value>
  enabled true|false, show-tool-calls true|false, or debounce <0-30000 ms>

ppm ppmbot token
  Set the Assistant's bot token (typed at the terminal) or remove it
  --token-prompt — Type the token from @BotFather at the terminal
  --remove — Remove the bot; the bridge stops

ppm ppmbot chats
  List the chats that may talk to the Assistant
  --json — Print JSON

ppm ppmbot revoke <chatId>
  Disconnect a chat: not one more message from it reaches the Assistant

ppm ppmbot connect
  Make a one-time link: the chat that opens it may talk to the Assistant
  --cancel — Withdraw the open link
\`\`\`
## ppm mcp — The MCP servers every chat starts with
\`\`\`
ppm mcp list
  List the servers; env and header values are never shown
  --json — Print JSON (values redacted)

ppm mcp add <name>
  Add a server: --command (with --arg) or --url
  --command <cmd> — A local server: the program to run
  --arg <value> — An argument for --command (repeat for each) [default: ]
  --url <url> — A remote server's address
  --type <type> — http or sse, for --url (default http)
  --env <name> — Set an environment variable; its value is typed at the terminal (repeat) [default: ]
  --header <name> — Set a header; its value is typed at the terminal (repeat) [default: ]

ppm mcp edit <name>
  Change a server; what is not given is kept
  --command <cmd> — A local server: the program to run
  --arg <value> — An argument for --command (repeat for each) [default: ]
  --url <url> — A remote server's address
  --type <type> — http or sse, for --url (default http)
  --env <name> — Set an environment variable; its value is typed at the terminal (repeat) [default: ]
  --header <name> — Set a header; its value is typed at the terminal (repeat) [default: ]
  --unset-env <name> — Remove an environment variable (repeat) [default: ]
  --unset-header <name> — Remove a header (repeat) [default: ]

ppm mcp remove <name>
  Remove a server; chats started after this do not get it

ppm mcp import [file]
  Add the servers from ~/.claude.json, or from a JSON file (\`{ mcpServers: {...} }\`); existing names are kept
\`\`\`
## ppm accounts — The Claude and Codex accounts chats rotate across
\`\`\`
ppm accounts list
  List the accounts (no credential is ever shown)
  --provider <provider> — claude or codex
  --json — Print JSON

ppm accounts add
  How to add an account

ppm accounts pick
  Claim the account the next new chat runs on (moves the rotation on)
  --provider <provider> — claude or codex [default: claude]

ppm accounts verify <id>
  Check a Claude account's sign-in again and refresh its profile

ppm accounts rename <id> <label>
  Rename a Claude account

ppm accounts enable <id>
  Put an account back in the rotation (a Claude sign-in is proved first)

ppm accounts disable <id>
  Take an account out of the rotation

ppm accounts remove <id>
  Remove an account and its stored sign-in (cannot be undone)
  --yes — Confirm the removal

ppm accounts settings
  Show or change how chats rotate across the accounts
  --provider <provider> — claude or codex [default: claude]
  --strategy <strategy> — round-robin, fill-first, lowest-usage
  --max-retry <n> — Claude: how many other accounts a failed turn tries
  --cooldown <on|off> — Claude: rest an account that hit its limit
\`\`\`
## ppm autostart — Manage auto-start on boot (enable/disable/status)
\`\`\`
ppm autostart enable
  Register PPM to start automatically on boot
  -p, --port <port> — Override port
  -s, --share — (deprecated) Tunnel is now always enabled
  --profile <name> — DB profile name
  --minimal — Start with chat, files, editor and settings

ppm autostart disable
  Remove PPM auto-start registration

ppm autostart status
  Show auto-start status
  --json — Output as JSON
\`\`\`
## ppm cloud — PPM Cloud — device registry + tunnel URL sync
\`\`\`
ppm cloud login
  Sign in with Google
  --url <url> — Cloud URL override
  --device-code — Force device code flow (for remote terminals)

ppm cloud logout
  Sign out from PPM Cloud

ppm cloud status
  Show PPM Cloud connection status
  --json — Output as JSON

ppm cloud devices
  List all registered devices from cloud
  --json — Output as JSON

ppm cloud alias set <slug>
  Set alias for this machine (e.g. ppm cloud alias set macbook)

ppm cloud alias get
  Show current alias for this machine

ppm cloud alias remove
  Remove alias for this machine
\`\`\`
## ppm skills — Manage and inspect discovered skills & commands
\`\`\`
ppm skills list
  List all discovered skills and commands
  --json — JSON output
  --project <path> — Project path [default: the current directory]

ppm skills search <query>
  Fuzzy search skills and commands
  --json — JSON output
  --project <path> — Project path [default: the current directory]

ppm skills info <name>
  Show detailed info for a specific skill
  --json — JSON output
  --project <path> — Project path [default: the current directory]
\`\`\`
## ppm ext — Manage PPM extensions
\`\`\`
ppm ext install <name>
  Install an extension from npm (in the running PPM; may take minutes)

ppm ext remove <name>
  Remove an installed extension

ppm ext list
  List installed extensions
  --json — Print JSON

ppm ext enable <name>
  Enable an extension (its commands join every open palette)

ppm ext disable <name>
  Disable an extension (its commands leave every open palette)

ppm ext dev <path>
  Symlink a local extension for development
\`\`\`
## ppm lsp — Language servers for the editor: list, install, remove
\`\`\`
ppm lsp list
  List the language servers PPM knows, and whether this machine has each
  --json — Print JSON

ppm lsp install <id>
  Install a language server by its id (may take minutes)
  -p, --project <name> — Install for this project (its toolchain), not machine-wide

ppm lsp remove <id>
  Remove a language server PPM installed (one on PATH or in a project is left alone)
\`\`\`
## ppm speech — Speech to text for the chat mic (Whisper on this machine)
\`\`\`
ppm speech status
  Show whether Whisper is installed, which model, and any install in progress
  --json — Print JSON

ppm speech install
  Download Whisper and a model (may take minutes); waits until it is done
  --model <id> — Which model (see \`ppm speech status\`); PPM's default when left out

ppm speech remove
  Remove the Whisper build and models PPM installed
\`\`\`
## ppm db — Manage database connections and execute queries
\`\`\`
ppm db list
  List all saved database connections
  --json — Output as JSON

ppm db add
  Add a database connection (read-only; make it writable in PPM)
  -n, --name <name> — Connection name (unique) (required)
  -t, --type <type> — Database type: postgres | mysql | mariadb | sqlite (required)
  -c, --connection-string <url> — Connection string (postgres://…, mysql://…, mariadb://…)
  -f, --file <path> — SQLite file path
  -g, --group <group> — Folder it is listed in
  --color <color> — Colour (hex, e.g. #3b82f6)
  --password-mode <mode> — save (default) | ask (PPM asks for it each time) | ask-user (asks for login and password)
  --ai <on|off> — Available to the AI chat (default on)

ppm db edit <name>
  Change a saved connection (by name or ID); give only what changes
  --name <name> — New name
  -c, --connection-string <url> — New connection string (a new server or login drops the saved password)
  -f, --file <path> — New SQLite file
  -g, --group <group> — Folder it is listed in ("" for none)
  --color <color> — Colour (hex; "none" clears it)
  --password-mode <mode> — save | ask | ask-user
  --ai <on|off> — Available to the AI chat

ppm db remove <name>
  Remove a saved connection (by name or ID)

ppm db test <name>
  Test a saved connection from the PPM host (by name or ID)

ppm db duplicate <name>
  Copy a saved connection, password included (by name or ID)

ppm db import <file>
  Import connections from an export file (each keeps the file's read-only and AI settings)

ppm db tables <name>
  List tables in a database connection
  --json — Output as JSON

ppm db schema <name> <table>
  Show table schema (columns, types, constraints)
  -s, --schema <schema> — Schema (PostgreSQL, default public) or database (MySQL, default from the connection)
  --json — Output as JSON

ppm db data <name> <table>
  View table data (paginated)
  -p, --page <page> — Page number [default: 1]
  -l, --limit <limit> — Rows per page [default: 50]
  --order <column> — Order by column
  --desc — Descending order
  -s, --schema <schema> — Schema (PostgreSQL, default public) or database (MySQL, default from the connection)
  --json — Output as JSON

ppm db query <name> <sql>
  Execute a SQL query against a saved connection
  --json — Output as JSON

ppm db driver list
  List database drivers and whether each is installed
  --json — Output as JSON

ppm db driver install <id>
  Download and install a database driver (e.g. mysql)

ppm db driver remove <id>
  Remove an installed database driver

ppm db run <name> <file>
  Execute a SQL file against a saved connection
\`\`\`
## ppm jira — Jira watcher utilities
\`\`\`
ppm jira config set <projectName>
  Set a project's Jira site and email; a new site or email without a new token clears the saved token
  --url <url> — Jira base URL (https://...) (required)
  --email <email> — Jira account email (required)
  --token-prompt — Type the API token at the terminal (required for a new config)

ppm jira config show <projectName>
  Show Jira config (token masked)

ppm jira config remove <projectName>
  Remove Jira config (cascades watchers + results)

ppm jira config test <projectName>
  Test Jira connection

ppm jira watch add
  Create a new watcher
  --config <id> — Jira config ID (required)
  --name <name> — Watcher name (required)
  --jql <jql> — JQL filter query (required)
  --interval <ms> — Poll interval in ms [default: 120000]
  --prompt <template> — Custom prompt template
  --mode <mode> — debug or notify [default: debug]

ppm jira watch list
  List watchers
  --config <id> — Filter by config ID
  --json — Print JSON

ppm jira watch enable <id>
  Enable watcher

ppm jira watch disable <id>
  Disable watcher

ppm jira watch remove <id>
  Delete watcher

ppm jira watch test <id>
  Dry-run poll (show matches without creating tasks)

ppm jira watch pull [id]
  Manual pull (one watcher or all enabled)

ppm jira results delete <id>
  Soft-delete result

ppm jira track <issueKey>
  Manually track a Jira issue
  --config <id> — Jira config ID (required)
\`\`\`
## ppm system — This machine's processes and services, through PPM's Task Manager
\`\`\`
ppm system processes
  List running processes (CPU is measured between two samples, so --sort cpu takes a few seconds)
  --sort <key> — cpu or mem [default: mem]
  -n, --limit <count> — How many rows [default: 20]
  --filter <text> — Only processes whose pid, name or command line matches
  --json — Print JSON

ppm system process <pid>
  Show one process: command line, folder, user, state
  --json — Print JSON

ppm system kill <pid>
  End a process: TERM, then KILL after a grace period (--force: KILL at once)
  --force — Send KILL straight away
  --tree — End its child processes too
  --expect-name <name> — Refuse unless the process has this name (required from an AI chat)

ppm system signal <pid> <signal>
  Send a signal to a process: TERM, KILL, STOP, CONT, HUP, INT, USR1, USR2 (Windows: TERM, KILL)
  --tree — Signal its child processes too
  --expect-name <name> — Refuse unless the process has this name (required from an AI chat)

ppm system resources
  CPU, memory and swap of this machine right now (takes a few seconds to measure CPU)
  --json — Print JSON

ppm system services
  List services (systemd units, launchd jobs, Windows services)
  --user — Only the user's own
  --system — Only the machine's
  --filter <text> — Only names or descriptions containing this
  --json — Print JSON

ppm system service <nameOrAction> [name]
  Show a service, or run start|stop|restart|enable|disable on it: \`service <name>\`, \`service stop <name>\`
  --user — The user's own service rather than the machine's
  --log — Print its recent log lines too
  --json — Print JSON
\`\`\`
## ppm schedule — Scheduled Claude agents (cron) and script schedules
\`\`\`
ppm schedule add
  Add a scheduled agent (--prompt) or a script schedule (--script). Cron uses local timezone. Do not embed secrets in --prompt.
  --name <name> — Schedule name (required)
  --cron <expr> — Cron expression (local timezone, e.g. "0 7 * * *"; a script may add seconds first)
  --project <nameOrPath> — Project name or path (required)
  --prompt <text> — Prompt sent to the agent each run
  --script <file> — JavaScript module run each tick, or kept running (needs a running PPM server)
  --mode <mode> — Script mode: tick (on the cron) or always-on [default: tick]
  --permission-mode <mode> — Permission mode [default: bypassPermissions]
  --max-turns <n> — Max turns per run (prompt only)
  --timeout <ms> — Timeout per run in ms (default 1800000 for a prompt, 300000 for a script tick)
  --disabled — Create disabled

ppm schedule list
  List schedules
  --enabled-only — Only enabled schedules

ppm schedule rm <id>
  Delete a schedule (cascades run history)
  -y, --yes — Skip confirmation

ppm schedule enable <id>
  Enable a schedule

ppm schedule disable <id>
  Disable a schedule

ppm schedule run-now <id>
  Fire a schedule immediately (requires running PPM server)

ppm schedule runs <id>
  Show recent runs for a schedule
  --limit <n> — Max rows [default: 20]

ppm schedule export <id>
  Write a schedule as a shareable template — never its secrets, state or history
  -o, --output <file> — Write to this file instead of standard output

ppm schedule import <file>
  Create a schedule from a template, turned off. Read its code before you trust it.
  --project <name> — Project it runs in (required)
  --set <key=value> — Value of an input (repeatable) [default: ]
  --secret <key=value|key=@file> — Value of a secret input; @file reads it from a file (repeatable) [default: ]
  --trust — I have read this code and trust it to run on this machine

ppm schedule state <id>
  Print a script schedule's state, secrets masked

ppm schedule set-state <id> <file>
  Replace a script schedule's state with a JSON file; the schedule must be off
\`\`\`
## ppm export — Export PPM metadata for external tools (AI agents, editors)
\`\`\`
ppm export skill
  Export Claude Code skill for controlling PPM from external AI tools
  --install — Install to target dir (default scope=user → ~/.claude/skills/ppm/)
  --scope <scope> — Install scope: user | project [default: user]
  --output <dir> — Custom output directory (overrides --scope)
  --format <fmt> — Output format [default: claude-code]
\`\`\`

## Tips
- Use \`--json\` when parsing a command's output
- For git/chat/db commands, always name the project (\`--project <name>\`) or the connection
`;
