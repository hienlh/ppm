# PPM CLI Reference

_Auto-generated. Do not edit._

Root binary: `ppm`. Run `ppm <command> --help` for full usage.

## Global Options

- `-V, --version` — output the version number

## Commands

## `ppm autostart`

Manage auto-start on boot (enable/disable/status)

**Usage:** `ppm autostart [options] [command]`

### `ppm autostart enable`

Register PPM to start automatically on boot

**Options:**
- `-p, --port <port>` — Override port
- `-s, --share` — (deprecated) Tunnel is now always enabled
- `--profile <name>` — DB profile name

### `ppm autostart disable`

Remove PPM auto-start registration

### `ppm autostart status`

Show auto-start status

**Options:**
- `--json` — Output as JSON

## `ppm bot`

PPMBot utilities

**Usage:** `ppm bot [options] [command]`

### `ppm bot delegate`

Delegate a task to a project subagent

**Options:**
- `--chat <id>` — Telegram chat ID
- `--project <name>` — Project name
- `--prompt <text>` — Enriched task prompt
- `--timeout <ms>` — Timeout in milliseconds (default: `"900000"`)

### `ppm bot task-status`

Get status of a delegated task

**Usage:** `ppm bot task-status [options] <id>`

### `ppm bot task-result`

Get full result of a completed task

**Usage:** `ppm bot task-result [options] <id>`

### `ppm bot tasks`

List recent delegated tasks

**Options:**
- `--chat <id>` — Telegram chat ID (auto-detected if single)

### `ppm bot memory`

Manage cross-project memories

**Usage:** `ppm bot memory [options] [command]`

#### `ppm bot memory save`

Save a cross-project memory

**Options:**
- `-c, --category <cat>` — Category: fact|preference|decision|architecture|issue (default: `"fact"`)
- `-s, --session <id>` — Session ID (optional)

**Usage:** `ppm bot memory save [options] <content>`

#### `ppm bot memory list`

List active cross-project memories

**Options:**
- `-l, --limit <n>` — Max results (default: `"30"`)
- `--json` — Output as JSON

#### `ppm bot memory forget`

Delete memories matching a topic (FTS5 search)

**Usage:** `ppm bot memory forget [options] <topic>`

### `ppm bot project`

Manage bot project context

**Usage:** `ppm bot project [options] [command]`

#### `ppm bot project list`

List available projects

**Options:**
- `--json` — Output as JSON

### `ppm bot status`

Show current status and running tasks

**Options:**
- `--chat <id>` — Telegram chat ID (auto-detected if single)
- `--json` — Output as JSON

### `ppm bot version`

Show PPM version

### `ppm bot restart`

Restart the PPM server

### `ppm bot help`

Show all bot CLI commands

## `ppm chat`

Manage AI chat sessions

**Usage:** `ppm chat [options] [command]`

### `ppm chat list`

List all chat sessions

**Options:**
- `-p, --project <name>` — Filter by project name

### `ppm chat create`

Create a new chat session

**Options:**
- `-p, --project <name>` — Project name or path
- `--provider <provider>` — AI provider (default: claude)

### `ppm chat send`

Send a message and stream response to stdout

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm chat send [options] <session-id> <message>`

### `ppm chat resume`

Resume an interactive chat session

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm chat resume [options] <session-id>`

### `ppm chat delete`

Delete a chat session

**Usage:** `ppm chat delete [options] <session-id>`

## `ppm cloud`

PPM Cloud — device registry + tunnel URL sync

**Usage:** `ppm cloud [options] [command]`

### `ppm cloud login`

Sign in with Google

**Options:**
- `--url <url>` — Cloud URL override
- `--device-code` — Force device code flow (for remote terminals)

### `ppm cloud logout`

Sign out from PPM Cloud

### `ppm cloud status`

Show PPM Cloud connection status

**Options:**
- `--json` — Output as JSON

### `ppm cloud devices`

List all registered devices from cloud

**Options:**
- `--json` — Output as JSON

### `ppm cloud alias`

Manage machine alias (vanity URL slug)

**Usage:** `ppm cloud alias [options] [command]`

#### `ppm cloud alias set`

Set alias for this machine (e.g. ppm cloud alias set macbook)

**Usage:** `ppm cloud alias set [options] <slug>`

#### `ppm cloud alias get`

Show current alias for this machine

#### `ppm cloud alias remove`

Remove alias for this machine

## `ppm config`

Get or set PPM configuration

**Usage:** `ppm config [options] [command]`

### `ppm config get`

Get a config value (e.g. port, auth.enabled)

**Usage:** `ppm config get [options] <key>`

### `ppm config set`

Set a config value (e.g. port 9090)

**Usage:** `ppm config set [options] <key> <value>`

## `ppm db`

Manage database connections and execute queries

**Usage:** `ppm db [options] [command]`

### `ppm db list`

List all saved database connections

**Options:**
- `--json` — Output as JSON

### `ppm db add`

Add a new database connection

**Options:**
- `-n, --name <name>` — Connection name (unique)
- `-t, --type <type>` — Database type: sqlite | postgres
- `-c, --connection-string <url>` — PostgreSQL connection string
- `-f, --file <path>` — SQLite file path (absolute)
- `-g, --group <group>` — Group name
- `--color <color>` — Tab color (hex, e.g. #3b82f6)

### `ppm db remove`

Remove a saved connection (by name or ID)

**Usage:** `ppm db remove [options] <name>`

### `ppm db test`

Test a saved connection

**Usage:** `ppm db test [options] <name>`

### `ppm db tables`

List tables in a database connection

**Options:**
- `--json` — Output as JSON

**Usage:** `ppm db tables [options] <name>`

### `ppm db schema`

Show table schema (columns, types, constraints)

**Options:**
- `-s, --schema <schema>` — PostgreSQL schema name (default: `"public"`)
- `--json` — Output as JSON

**Usage:** `ppm db schema [options] <name> <table>`

### `ppm db data`

View table data (paginated)

**Options:**
- `-p, --page <page>` — Page number (default: `"1"`)
- `-l, --limit <limit>` — Rows per page (default: `"50"`)
- `--order <column>` — Order by column
- `--desc` — Descending order
- `-s, --schema <schema>` — PostgreSQL schema name (default: `"public"`)
- `--json` — Output as JSON

**Usage:** `ppm db data [options] <name> <table>`

### `ppm db query`

Execute a SQL query against a saved connection

**Options:**
- `--json` — Output as JSON

**Usage:** `ppm db query [options] <name> <sql>`

### `ppm db run`

Execute a SQL file against a saved connection

**Usage:** `ppm db run [options] <name> <file>`

## `ppm down`

Fully shut down PPM (supervisor + server + tunnel)

## `ppm export`

Export PPM metadata for external tools (AI agents, editors)

**Usage:** `ppm export [options] [command]`

### `ppm export skill`

Export Claude Code skill for controlling PPM from external AI tools

**Options:**
- `--install` — Install to target dir (default scope=user → ~/.claude/skills/ppm/)
- `--scope <scope>` — Install scope: user | project (default: `"user"`)
- `--output <dir>` — Custom output directory (overrides --scope)
- `--format <fmt>` — Output format (default: `"claude-code"`)

## `ppm ext`

Manage PPM extensions

**Usage:** `ppm ext [options] [command]`

### `ppm ext install`

Install an extension from npm

**Usage:** `ppm ext install [options] <name>`

### `ppm ext remove`

Remove an installed extension

**Usage:** `ppm ext remove [options] <name>`

### `ppm ext list`

List installed extensions

### `ppm ext enable`

Enable an extension

**Usage:** `ppm ext enable [options] <name>`

### `ppm ext disable`

Disable an extension

**Usage:** `ppm ext disable [options] <name>`

### `ppm ext dev`

Symlink a local extension for development

**Usage:** `ppm ext dev [options] <path>`

## `ppm git`

Git operations for a project

**Usage:** `ppm git [options] [command]`

### `ppm git status`

Show working tree status

**Options:**
- `-p, --project <name>` — Project name or path

### `ppm git log`

Show recent commits

**Options:**
- `-p, --project <name>` — Project name or path
- `-n, --count <n>` — Number of commits to show (default: `"20"`)

### `ppm git diff`

Show diff between refs or working tree

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm git diff [options] [ref1] [ref2]`

### `ppm git stage`

Stage files (use "." to stage all)

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm git stage [options] <files...>`

### `ppm git unstage`

Unstage files

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm git unstage [options] <files...>`

### `ppm git commit`

Commit staged changes

**Options:**
- `-p, --project <name>` — Project name or path
- `-m, --message <msg>` — Commit message

### `ppm git push`

Push to remote

**Options:**
- `-p, --project <name>` — Project name or path
- `--remote <remote>` — Remote name (default: `"origin"`)
- `--branch <branch>` — Branch name

### `ppm git pull`

Pull from remote

**Options:**
- `-p, --project <name>` — Project name or path
- `--remote <remote>` — Remote name
- `--branch <branch>` — Branch name

### `ppm git branch`

Branch operations

**Usage:** `ppm git branch [options] [command]`

#### `ppm git branch create`

Create and checkout a new branch

**Options:**
- `-p, --project <name>` — Project name or path
- `--from <ref>` — Base ref (commit/branch/tag)

**Usage:** `ppm git branch create [options] <name>`

#### `ppm git branch checkout`

Switch to a branch

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm git branch checkout [options] <name>`

#### `ppm git branch delete`

Delete a branch

**Options:**
- `-p, --project <name>` — Project name or path
- `-f, --force` — Force delete

**Usage:** `ppm git branch delete [options] <name>`

#### `ppm git branch merge`

Merge a branch into current branch

**Options:**
- `-p, --project <name>` — Project name or path

**Usage:** `ppm git branch merge [options] <source>`

## `ppm init`

Initialize PPM configuration (interactive or via flags)

**Options:**
- `-p, --port <port>` — Port to listen on
- `--scan <path>` — Directory to scan for git repos
- `--auth` — Enable authentication
- `--no-auth` — Disable authentication
- `--password <pw>` — Set access password
- `--share` — Pre-install cloudflared for sharing
- `-y, --yes` — Non-interactive mode (use defaults + flags)

## `ppm jira`

Jira watcher utilities

**Usage:** `ppm jira [options] [command]`

### `ppm jira config`

Manage Jira configs

**Usage:** `ppm jira config [options] [command]`

#### `ppm jira config set`

Set Jira config for a project

**Options:**
- `--url <url>` — Jira base URL (https://...)
- `--email <email>` — Jira account email
- `--token <token>` — API token (⚠ visible in shell history)

**Usage:** `ppm jira config set [options] <projectName>`

#### `ppm jira config show`

Show Jira config (token masked)

**Usage:** `ppm jira config show [options] <projectName>`

#### `ppm jira config remove`

Remove Jira config (cascades watchers + results)

**Usage:** `ppm jira config remove [options] <projectName>`

#### `ppm jira config test`

Test Jira connection

**Usage:** `ppm jira config test [options] <projectName>`

### `ppm jira watch`

Manage Jira watchers

**Usage:** `ppm jira watch [options] [command]`

#### `ppm jira watch add`

Create a new watcher

**Options:**
- `--config <id>` — Jira config ID
- `--name <name>` — Watcher name
- `--jql <jql>` — JQL filter query
- `--interval <ms>` — Poll interval in ms (default: `"120000"`)
- `--prompt <template>` — Custom prompt template
- `--mode <mode>` — debug or notify (default: `"debug"`)

#### `ppm jira watch list`

List watchers

**Options:**
- `--config <id>` — Filter by config ID

#### `ppm jira watch enable`

Enable watcher

**Usage:** `ppm jira watch enable [options] <id>`

#### `ppm jira watch disable`

Disable watcher

**Usage:** `ppm jira watch disable [options] <id>`

#### `ppm jira watch remove`

Delete watcher

**Usage:** `ppm jira watch remove [options] <id>`

#### `ppm jira watch test`

Dry-run poll (show matches without creating tasks)

**Usage:** `ppm jira watch test [options] <id>`

#### `ppm jira watch pull`

Manual pull (one watcher or all enabled)

**Usage:** `ppm jira watch pull [options] [id]`

### `ppm jira results`

View Jira watch results

**Options:**
- `--watcher <id>` — Filter by watcher ID
- `--status <status>` — Filter by status

**Usage:** `ppm jira results [options] [command]`

#### `ppm jira results delete`

Soft-delete result

**Usage:** `ppm jira results delete [options] <id>`

### `ppm jira track`

Manually track a Jira issue

**Options:**
- `--config <id>` — Jira config ID

**Usage:** `ppm jira track [options] <issueKey>`

## `ppm logs`

View PPM daemon logs

**Options:**
- `-n, --tail <lines>` — Number of lines to show (default: `"50"`)
- `-f, --follow` — Follow log output
- `--clear` — Clear log file

## `ppm open`

Open PPM in browser

## `ppm projects`

Manage registered projects

**Usage:** `ppm projects [options] [command]`

### `ppm projects list`

List all registered projects

### `ppm projects add`

Add a project to the registry

**Options:**
- `-n, --name <name>` — Project name (defaults to folder name)

**Usage:** `ppm projects add [options] <path>`

### `ppm projects remove`

Remove a project from the registry

**Usage:** `ppm projects remove [options] <name>`

## `ppm report`

Report a bug on GitHub (pre-fills env info + logs)

## `ppm restart`

Restart the server (keeps tunnel alive)

**Options:**
- `--force` — Force resume from paused state

## `ppm schedule`

Scheduled Claude agents (cron)

**Usage:** `ppm schedule [options] [command]`

### `ppm schedule add`

Add a scheduled agent. Cron uses local timezone. Do not embed secrets in --prompt.

**Options:**
- `--name <name>` — Schedule name
- `--cron <expr>` — Cron expression (local timezone, e.g. "0 7 * * *")
- `--project <nameOrPath>` — Project name or path
- `--prompt <text>` — Prompt sent to the agent each run
- `--permission-mode <mode>` — Permission mode (default: `"bypassPermissions"`)
- `--max-turns <n>` — Max turns per run
- `--timeout <ms>` — Timeout per run in ms (default: `"1800000"`)
- `--disabled` — Create disabled

### `ppm schedule list`

List schedules

**Options:**
- `--enabled-only` — Only enabled schedules

### `ppm schedule rm`

Delete a schedule (cascades run history)

**Options:**
- `-y, --yes` — Skip confirmation

**Usage:** `ppm schedule rm [options] <id>`

### `ppm schedule enable`

Enable a schedule

**Usage:** `ppm schedule enable [options] <id>`

### `ppm schedule disable`

Disable a schedule

**Usage:** `ppm schedule disable [options] <id>`

### `ppm schedule run-now`

Fire a schedule immediately (requires running PPM server)

**Usage:** `ppm schedule run-now [options] <id>`

### `ppm schedule runs`

Show recent runs for a schedule

**Options:**
- `--limit <n>` — Max rows (default: `"20"`)

**Usage:** `ppm schedule runs [options] <id>`

## `ppm skills`

Manage and inspect discovered skills & commands

**Options:**
- `--project <path>` — Project path (default: `"C:\\Users\\PC\\ppm"`)

**Usage:** `ppm skills [options] [command]`

### `ppm skills list`

List all discovered skills and commands

**Options:**
- `--json` — JSON output
- `--project <path>` — Project path (default: `"C:\\Users\\PC\\ppm"`)

### `ppm skills search`

Fuzzy search skills and commands

**Options:**
- `--json` — JSON output
- `--project <path>` — Project path (default: `"C:\\Users\\PC\\ppm"`)

**Usage:** `ppm skills search [options] <query>`

### `ppm skills info`

Show detailed info for a specific skill

**Options:**
- `--json` — JSON output
- `--project <path>` — Project path (default: `"C:\\Users\\PC\\ppm"`)

**Usage:** `ppm skills info [options] <name>`

## `ppm start`

Start the PPM server (background by default)

**Options:**
- `-p, --port <port>` — Port to listen on
- `-s, --share` — (deprecated) Tunnel is now always enabled
- `--profile <name>` — DB profile name (e.g. 'dev' → ppm.dev.db)

## `ppm status`

Show PPM daemon status

**Options:**
- `-a, --all` — Show all PPM and cloudflared processes (including untracked)
- `--json` — Output as JSON

## `ppm stop`

Stop the PPM server (supervisor stays alive)

**Options:**
- `-a, --all` — Kill all PPM and cloudflared processes (including untracked)
- `--kill` — Full shutdown (kills supervisor too)

## `ppm upgrade`

Check for and install PPM updates

**Options:**
- `--check` — Only check for updates, don't install
