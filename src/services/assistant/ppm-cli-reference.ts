import { basename, join, resolve } from "node:path";
import { getDbPath } from "../db.service.ts";
import { getPpmDir } from "../ppm-dir.ts";

/**
 * What the Assistant's `ppm_cli_reference` tool answers: how to run the PPM CLI against *this*
 * PPM, which commands go through the running server and which touch its data directly, then
 * the reference itself, generated from the CLI source (`bun scripts/generate-ppm-cli-reference.ts
 * --update` rewrites `PPM_CLI_REFERENCE` below; a test fails when it drifts).
 *
 * The header matters more than the reference. Almost every `ppm` command opens PPM's database
 * itself rather than asking the server, and only `start` can choose a database profile, so the
 * Assistant of a dev server (`ppm.dev.db`) running `ppm config set …` would write to `ppm.db` —
 * another instance's data. The shell does get `PPM_HOME` (`assistant-shell-env.ts`), which
 * fixes the folder but not the file.
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
  const dbFile = getDbPath();
  const profile = /^ppm\.(.+)\.db$/.exec(basename(dbFile))?.[1] ?? null;
  // A compiled binary is its own CLI; from source (or an npm install) the entry is src/index.ts.
  const compiled = import.meta.url.includes("$bunfs");
  const command = compiled ? quote(process.execPath) : `bun ${quote(join(resolve(import.meta.dir, "..", "..", ".."), "src", "index.ts"))}`;
  return { ppmDir: getPpmDir(), dbFile, profile, command };
}

const VIA_SERVER = ["status", "restart", "stop", "open", "schedule run-now"];
const DIRECT = ["config", "projects", "db", "schedule (all but run-now)", "cloud", "ext", "jira", "backup", "autostart",
  "chat (also runs an AI turn inside the command itself)"];

export function ppmCliReferenceHeader(instance: PpmInstance): string {
  const lines = [
    "# Running `ppm` from this Assistant",
    "",
    `This PPM keeps its data in ${instance.ppmDir} (database ${basename(instance.dbFile)}). Your shell has`,
    `PPM_HOME set to that folder. Invoke the CLI as: ${instance.command}`,
    "Every shell command asks the user first; say what the command does when you ask.",
    "",
  ];
  if (instance.profile) {
    lines.push(
      `WARNING: this server runs on the "${instance.profile}" database profile (${basename(instance.dbFile)}).`,
      "The CLI cannot choose a profile for any command but `start`: every command below that reads or",
      "changes PPM's data opens ppm.db, which belongs to a different PPM instance. Do not run those",
      "commands from here. Use the Assistant's own tools, or give the user the command to run themselves.",
      "",
    );
  }
  lines.push(
    "## Commands that go through the running server (prefer these)",
    VIA_SERVER.map((c) => `- ppm ${c}`).join("\n"),
    "",
    "## Commands that read or write PPM's data directly",
    "The running server keeps much of this in memory: a change may not show until it restarts, and the",
    "server may write its own copy back over it. Prefer the Assistant's tools or the PPM screen where one exists.",
    DIRECT.map((c) => `- ppm ${c}`).join("\n"),
    "",
    "`ppm git` works on a project's repository, not on PPM's data.",
    "",
  );
  return lines.join("\n");
}

/** The tool's whole answer. */
export function ppmCliReference(instance: PpmInstance = currentPpmInstance()): string {
  return `${ppmCliReferenceHeader(instance)}\n${PPM_CLI_REFERENCE}`;
}

export const PPM_CLI_REFERENCE = `# PPM CLI Reference
## Core Commands (Server & system management)
\`\`\`
ppm start
  Start the PPM server (background by default)
  -p, --port <port> — Port to listen on
  -s, --share — (deprecated) Tunnel is now always enabled

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

ppm upgrade
  Check for and install PPM updates
\`\`\`
## ppm projects — Manage registered projects
\`\`\`
ppm projects list
  List all registered projects

ppm projects add <path>
  Add a project to the registry
  -n, --name <name> — Project name (defaults to folder name)

ppm projects remove <name>
  Remove a project from the registry
\`\`\`
## ppm config — Configuration management
\`\`\`
ppm config get <key>
  Get a config value (e.g. port, auth.enabled)

ppm config set <key> <value>
  Set a config value (e.g. port 9090)
\`\`\`
## ppm git — Git operations for a project
\`\`\`
ppm git status
  Show working tree status
  -p, --project <name> — Project name or path

ppm git log
  Show recent commits
  -p, --project <name> — Project name or path
  -n, --count <n> — Number of commits to show [default: 20]

ppm git diff [ref1] [ref2]
  Show diff between refs or working tree
  -p, --project <name> — Project name or path

ppm git stage <files...>
  Stage files (use "." to stage all)
  -p, --project <name> — Project name or path

ppm git unstage <files...>
  Unstage files
  -p, --project <name> — Project name or path

ppm git commit
  Commit staged changes
  -p, --project <name> — Project name or path
  -m, --message <msg> — Commit message (required)

ppm git push
  Push to remote
  -p, --project <name> — Project name or path
  --remote <remote> — Remote name [default: origin]
  --branch <branch> — Branch name

ppm git pull
  Pull from remote
  -p, --project <name> — Project name or path
  --remote <remote> — Remote name
  --branch <branch> — Branch name

ppm git branch create <name>
  Create and checkout a new branch
  -p, --project <name> — Project name or path
  --from <ref> — Base ref (commit/branch/tag)

ppm git branch checkout <name>
  Switch to a branch
  -p, --project <name> — Project name or path

ppm git branch delete <name>
  Delete a branch
  -p, --project <name> — Project name or path
  -f, --force — Force delete

ppm git branch merge <source>
  Merge a branch into current branch
  -p, --project <name> — Project name or path
\`\`\`
## ppm chat — AI chat sessions
\`\`\`
ppm chat list
  List all chat sessions
  -p, --project <name> — Filter by project name

ppm chat create
  Create a new chat session
  -p, --project <name> — Project name or path
  --provider <provider> — AI provider (default: claude)

ppm chat send <session-id> <message>
  Send a message and stream response to stdout
  -p, --project <name> — Project name or path

ppm chat resume <session-id>
  Resume an interactive chat session
  -p, --project <name> — Project name or path

ppm chat delete <session-id>
  Delete a chat session
\`\`\`
## ppm db — Database connections & queries
\`\`\`
ppm db list
  List all saved database connections
  --json — Output as JSON

ppm db add
  Add a new database connection
  -n, --name <name> — Connection name (unique) (required)
  -t, --type <type> — Database type: postgres | mysql | mariadb | sqlite (required)
  -c, --connection-string <url> — Connection string (postgres://…, mysql://…, mariadb://…)
  -f, --file <path> — SQLite file path (absolute)
  -g, --group <group> — Group name
  --color <color> — Tab color (hex, e.g. #3b82f6)

ppm db remove <name>
  Remove a saved connection (by name or ID)

ppm db test <name>
  Test a saved connection

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
## ppm autostart — Auto-start on boot
\`\`\`
ppm autostart enable
  Register PPM to start automatically on boot
  -p, --port <port> — Override port
  -s, --share — (deprecated) Tunnel is now always enabled
  --profile <name> — DB profile name

ppm autostart disable
  Remove PPM auto-start registration

ppm autostart status
  Show auto-start status
  --json — Output as JSON
\`\`\`
## ppm cloud — PPM Cloud — device registry + tunnel
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

ppm cloud set <slug>
  Set alias for this machine (e.g. ppm cloud alias set macbook)

ppm cloud get
  Show current alias for this machine

ppm cloud remove
  Remove alias for this machine
\`\`\`
## ppm ext — Manage PPM extensions
\`\`\`
ppm ext install <name>
  Install an extension from npm

ppm ext remove <name>
  Remove an installed extension

ppm ext list
  List installed extensions

ppm ext enable <name>
  Enable an extension

ppm ext disable <name>
  Disable an extension

ppm ext dev <path>
  Symlink a local extension for development
\`\`\`
## ppm schedule — Scheduled agents (cron)
\`\`\`
ppm schedule add
  Add a scheduled agent. Cron uses local timezone. Do not embed secrets in --prompt.
  --name <name> — Schedule name (required)
  --project <nameOrPath> — Project name or path (required)
  --prompt <text> — Prompt sent to the agent each run (required)
  --permission-mode <mode> — Permission mode [default: bypassPermissions]
  --max-turns <n> — Max turns per run
  --timeout <ms> — Timeout per run in ms [default: 1800000]
  --disabled — Create disabled

ppm schedule list
  List schedules
  --enabled-only — Only enabled schedules

ppm schedule rm <id>
  Delete a schedule (cascades run history)
  -y, --yes — Skip confirmation

ppm schedule \${action} <id>
  \${action[0]!.toUpperCase()}\${action.slice(1)} a schedule

ppm schedule run-now <id>
  Fire a schedule immediately (requires running PPM server)

ppm schedule runs <id>
  Show recent runs for a schedule
  --limit <n> — Max rows [default: 20]
\`\`\`

## Tips
- Use \`--json\` when parsing a command's output
- For git/chat/db commands, always name the project (\`--project <name>\`) or the connection
`;
