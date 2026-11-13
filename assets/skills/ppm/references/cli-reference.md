# PPM CLI Reference

_Auto-generated. Do not edit._

Root binary: `ppm`. Run `ppm <command> --help` for full usage.

## Global Options

- `-V, --version` — output the version number

## Commands

## `ppm accounts`

The Claude and Codex accounts chats rotate across

**Usage:** `ppm accounts [options] [command]`

### `ppm accounts list`

List the accounts (no credential is ever shown)

**Options:**
- `--provider <provider>` — claude or codex
- `--json` — Print JSON

### `ppm accounts add`

How to add an account

### `ppm accounts pick`

Claim the account the next new chat runs on (moves the rotation on)

**Options:**
- `--provider <provider>` — claude or codex (default: `"claude"`)

### `ppm accounts verify`

Check a Claude account's sign-in again and refresh its profile

**Usage:** `ppm accounts verify [options] <id>`

### `ppm accounts rename`

Rename a Claude account

**Usage:** `ppm accounts rename [options] <id> <label>`

### `ppm accounts enable`

Put an account back in the rotation (a Claude sign-in is proved first)

**Usage:** `ppm accounts enable [options] <id>`

### `ppm accounts disable`

Take an account out of the rotation

**Usage:** `ppm accounts disable [options] <id>`

### `ppm accounts remove`

Remove an account and its stored sign-in (cannot be undone)

**Options:**
- `--yes` — Confirm the removal

**Usage:** `ppm accounts remove [options] <id>`

### `ppm accounts settings`

Show or change how chats rotate across the accounts

**Options:**
- `--provider <provider>` — claude or codex (default: `"claude"`)
- `--strategy <strategy>` — round-robin, fill-first, lowest-usage
- `--max-retry <n>` — Claude: how many other accounts a failed turn tries
- `--cooldown <on|off>` — Claude: rest an account that hit its limit

## `ppm ai`

Show or change the AI provider settings

**Usage:** `ppm ai [options] [command]`

### `ppm ai get`

Show the AI settings, or one of them (e.g. default_provider, providers.claude.model); secrets are never shown

**Options:**
- `--json` — Print JSON

**Usage:** `ppm ai get [options] [key]`

### `ppm ai set`

Change one AI setting (e.g. default_provider codex, providers.claude.effort high, ppm_tools.open_url false)

**Usage:** `ppm ai set [options] <key> <value>`

### `ppm ai providers`

Which providers chat can use now, and why one cannot

**Options:**
- `--json` — Print JSON

### `ppm ai probe`

Check a provider again now, ahead of its next scheduled try

**Usage:** `ppm ai probe [options] <provider>`

### `ppm ai models`

List the models a provider offers

**Options:**
- `--json` — Print JSON

**Usage:** `ppm ai models [options] <provider>`

## `ppm autostart`

Manage auto-start on boot (enable/disable/status)

**Usage:** `ppm autostart [options] [command]`

### `ppm autostart enable`

Register PPM to start automatically on boot

**Options:**
- `-p, --port <port>` — Override port
- `-s, --share` — (deprecated) Tunnel is now always enabled
- `--profile <name>` — DB profile name
- `--minimal` — Start with chat, files, editor and settings

### `ppm autostart disable`

Remove PPM auto-start registration

### `ppm autostart status`

Show auto-start status

**Options:**
- `--json` — Output as JSON

## `ppm backup`

Snapshot the PPM config database now

**Options:**
- `--json` — Output as JSON

## `ppm chat`

Manage AI chat sessions

**Usage:** `ppm chat [options] [command]`

### `ppm chat list`

List all chat sessions

**Options:**
- `-p, --project <name>` — Filter by project name

### `ppm chat create`

Create a new chat session in a project

**Options:**
- `-p, --project <name>` — Project name or path (default: the current folder's project)
- `--provider <provider>` — AI provider (default: PPM's default provider)
- `-t, --title <title>` — The chat's title

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

### `ppm chat rename`

Rename a chat

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat rename [options] <session-id> <title>`

### `ppm chat pin`

Pin a chat to the top of its project's list

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat pin [options] <session-id>`

### `ppm chat unpin`

Unpin a chat

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat unpin [options] <session-id>`

### `ppm chat tag`

Tag a chat with one of its project's tags (by name or number)

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat tag [options] <session-id> <tag>`

### `ppm chat untag`

Remove a chat's tag

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat untag [options] <session-id>`

### `ppm chat read`

Mark a chat as read

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat read [options] <session-id>`

### `ppm chat unread`

Mark a chat as unread

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat unread [options] <session-id>`

### `ppm chat stop`

Stop the chat's running turn, as PPM's Stop button does

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat stop [options] <session-id>`

### `ppm chat delete`

Delete a chat; a running turn is stopped first, and nothing is deleted if it does not stop

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat delete [options] <session-id>`

### `ppm chat fork`

Start a new chat that carries this chat's title and settings

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat fork [options] <session-id>`

### `ppm chat account`

Move a chat onto another account of its provider

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat account [options] <session-id> <account-id>`

### `ppm chat cleanup`

Delete a project's chats older than N days; pinned, manager, branched and running chats are kept

**Options:**
- `--older-than <days>` — Age in days (at least 1)
- `-p, --project <name>` — Project name or path (default: the current folder's project)
- `--provider <id>` — Only this provider's chats (default: claude)

### `ppm chat changes`

Review the files a chat changed, as its Review tab does

**Usage:** `ppm chat changes [options] [command]`

#### `ppm chat changes list`

List the files a chat changed: lines, open blocks, reviewed

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)
- `--json` — Print the list as JSON

**Usage:** `ppm chat changes list [options] <session-id>`

#### `ppm chat changes diff`

Show one changed file's blocks (with their keys) as a diff

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat changes diff [options] <session-id> <path>`

#### `ppm chat changes keep`

Keep a chat's changes (every unreviewed file when no path is given)

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)
- `--block <keys...>` — Only these blocks of the one file named (keys from `ppm chat changes diff`)

**Usage:** `ppm chat changes keep [options] <session-id> [paths...]`

#### `ppm chat changes reopen`

Open kept changes for review again (every kept or reviewed file when no path is given)

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)
- `--block <keys...>` — Only these blocks of the one file named (keys from `ppm chat changes diff`)

**Usage:** `ppm chat changes reopen [options] <session-id> [paths...]`

#### `ppm chat changes revert`

Put files back as they were before the chat changed them; undo is offered afterwards

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)
- `--block <keys...>` — Only these blocks of the one file named (keys from `ppm chat changes diff`)

**Usage:** `ppm chat changes revert [options] <session-id> <paths...>`

#### `ppm chat changes undo`

Undo an earlier keep, reopen or revert by the id it printed

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)

**Usage:** `ppm chat changes undo [options] <session-id> <undo-id>`

### `ppm chat turns`

List a chat's newest turns with their numbers and how many calls each made

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)
- `--json` — Print the turns as JSON
- `--limit <n>` — How many of the newest turns (at most 50) (default: `"20"`)

**Usage:** `ppm chat turns [options] <session-id>`

### `ppm chat revert-turn`

Put back what one turn changed: prints the preview, and writes only with --yes

**Options:**
- `-p, --project <name>` — The chat's project (default: the one PPM recorded for it)
- `--yes` — Write the changes the preview shows

**Usage:** `ppm chat revert-turn [options] <session-id> <n>`

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

### `ppm cloud link`

Register this machine in PPM Cloud (needs `ppm cloud login`). Refused from an AI chat

**Options:**
- `--name <name>` — The name PPM Cloud shows (default: this machine's device name)

### `ppm cloud unlink`

Remove this machine from PPM Cloud (its permanent link stops working)

### `ppm cloud alias`

Manage machine alias (vanity URL slug)

**Usage:** `ppm cloud alias [options] [command]`

#### `ppm cloud alias set`

Set alias for this machine (e.g. ppm cloud alias set macbook), through the running PPM. Refused from an AI chat

**Usage:** `ppm cloud alias set [options] <slug>`

#### `ppm cloud alias get`

Show current alias for this machine

#### `ppm cloud alias remove`

Remove alias for this machine, through the running PPM

## `ppm config`

Get or set PPM configuration

**Usage:** `ppm config [options] [command]`

### `ppm config get`

Get a config value (e.g. port, auth.enabled)

**Usage:** `ppm config get [options] <key>`

### `ppm config set`

Set a config value (e.g. port 9090), through the running PPM when one holds the database

**Usage:** `ppm config set [options] <key> <value>`

## `ppm db`

Manage database connections and execute queries

**Usage:** `ppm db [options] [command]`

### `ppm db list`

List all saved database connections

**Options:**
- `--json` — Output as JSON

### `ppm db add`

Add a database connection (read-only; make it writable in PPM)

**Options:**
- `-n, --name <name>` — Connection name (unique)
- `-t, --type <type>` — Database type: postgres | mysql | mariadb | sqlite
- `-c, --connection-string <url>` — Connection string (postgres://…, mysql://…, mariadb://…)
- `-f, --file <path>` — SQLite file path
- `-g, --group <group>` — Folder it is listed in
- `--color <color>` — Colour (hex, e.g. #3b82f6)
- `--password-mode <mode>` — save (default) | ask (PPM asks for it each time) | ask-user (asks for login and password)
- `--ai <on|off>` — Available to the AI chat (default on)

### `ppm db edit`

Change a saved connection (by name or ID); give only what changes

**Options:**
- `--name <name>` — New name
- `-c, --connection-string <url>` — New connection string (a new server or login drops the saved password)
- `-f, --file <path>` — New SQLite file
- `-g, --group <group>` — Folder it is listed in ("" for none)
- `--color <color>` — Colour (hex; "none" clears it)
- `--password-mode <mode>` — save | ask | ask-user
- `--ai <on|off>` — Available to the AI chat

**Usage:** `ppm db edit [options] <name>`

### `ppm db remove`

Remove a saved connection (by name or ID)

**Usage:** `ppm db remove [options] <name>`

### `ppm db test`

Test a saved connection from the PPM host (by name or ID)

**Usage:** `ppm db test [options] <name>`

### `ppm db duplicate`

Copy a saved connection, password included (by name or ID)

**Usage:** `ppm db duplicate [options] <name>`

### `ppm db import`

Import connections from an export file (each keeps the file's read-only and AI settings)

**Usage:** `ppm db import [options] <file>`

### `ppm db tables`

List tables in a database connection

**Options:**
- `--json` — Output as JSON

**Usage:** `ppm db tables [options] <name>`

### `ppm db schema`

Show table schema (columns, types, constraints)

**Options:**
- `-s, --schema <schema>` — Schema (PostgreSQL, default public) or database (MySQL, default from the connection)
- `--json` — Output as JSON

**Usage:** `ppm db schema [options] <name> <table>`

### `ppm db data`

View table data (paginated)

**Options:**
- `-p, --page <page>` — Page number (default: `"1"`)
- `-l, --limit <limit>` — Rows per page (default: `"50"`)
- `--order <column>` — Order by column
- `--desc` — Descending order
- `-s, --schema <schema>` — Schema (PostgreSQL, default public) or database (MySQL, default from the connection)
- `--json` — Output as JSON

**Usage:** `ppm db data [options] <name> <table>`

### `ppm db query`

Execute a SQL query against a saved connection

**Options:**
- `--json` — Output as JSON

**Usage:** `ppm db query [options] <name> <sql>`

### `ppm db driver`

Install or remove the drivers some connections need (MySQL / MariaDB, SSH tunnels)

**Usage:** `ppm db driver [options] [command]`

#### `ppm db driver list`

List database drivers and whether each is installed

**Options:**
- `--json` — Output as JSON

#### `ppm db driver install`

Download and install a database driver (e.g. mysql)

**Usage:** `ppm db driver install [options] <id>`

#### `ppm db driver remove`

Remove an installed database driver

**Usage:** `ppm db driver remove [options] <id>`

### `ppm db run`

Execute a SQL file against a saved connection

**Usage:** `ppm db run [options] <name> <file>`

## `ppm design`

A project's designs: list, create, rename, delete, history, restore, export

**Usage:** `ppm design [options] [command]`

### `ppm design list`

List the project's designs, newest first

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON

### `ppm design create`

Create an empty design (the AI fills it from a design chat)

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON
- `--kind <kind>` — page or slides (default: `"page"`)
- `--system <id>` — The app it belongs to (default: the project's default app)

**Usage:** `ppm design create [options] <title>`

### `ppm design rename`

Change a design's title (its folder keeps its slug)

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON

**Usage:** `ppm design rename [options] <slug> <title>`

### `ppm design delete`

Delete a design's folder and its history; without --yes, only says what would go

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON
- `-y, --yes` — Delete it

**Usage:** `ppm design delete [options] <slug>`

### `ppm design history`

List a design's snapshots, newest first

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON

**Usage:** `ppm design history [options] <slug>`

### `ppm design restore`

Put a design back to a snapshot (the current state is kept as a snapshot first)

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON

**Usage:** `ppm design restore [options] <slug> <snapshotId>`

### `ppm design export`

Save a design as a zip of its folder, or as one self-contained HTML file

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print the route's answer as JSON
- `--zip` — The design's folder as a zip
- `--html` — One self-contained HTML file of its entry page
- `-o, --output <file>` — Where to save it

**Usage:** `ppm design export [options] <slug>`

## `ppm device-name`

Name this machine, as PPM's title and PPM Cloud show it ("" clears it)

**Usage:** `ppm device-name [options] <name>`

## `ppm down`

Fully shut down PPM (supervisor + server + tunnel)

## `ppm export`

Export PPM metadata for external tools (AI agents, editors)

**Usage:** `ppm export [options] [command]`

### `ppm export skill`

Export skill for controlling PPM from AI agents (Claude Code, Codex, Antigravity)

**Options:**
- `--install` — Install to target dir (default scope=user → ~/.claude/skills/ppm/, ~/.agents/skills/ppm/ or ~/.gemini/config/skills/ppm/)
- `--scope <scope>` — Install scope: user | project (default: `"user"`)
- `--output <dir>` — Custom output directory (overrides --scope)
- `--format <fmt>` — Output format: claude-code | codex | antigravity (default: `"claude-code"`)

## `ppm ext`

Manage PPM extensions

**Usage:** `ppm ext [options] [command]`

### `ppm ext install`

Install an extension from npm (in the running PPM; may take minutes)

**Usage:** `ppm ext install [options] <name>`

### `ppm ext remove`

Remove an installed extension

**Usage:** `ppm ext remove [options] <name>`

### `ppm ext list`

List installed extensions

**Options:**
- `--json` — Print JSON

### `ppm ext enable`

Enable an extension (its commands join every open palette)

**Usage:** `ppm ext enable [options] <name>`

### `ppm ext disable`

Disable an extension (its commands leave every open palette)

**Usage:** `ppm ext disable [options] <name>`

### `ppm ext dev`

Symlink a local extension for development

**Usage:** `ppm ext dev [options] <path>`

## `ppm forward`

Forward a localhost port, as the Port Forwarding panel does

**Usage:** `ppm forward [options] [command]`

### `ppm forward list`

List the forwards and the other cloudflared on this machine; `stop` takes only this PPM's

**Options:**
- `--json` — Print JSON

### `ppm forward start`

Forward a localhost port: a public quick tunnel, or --via tailscale for your tailnet only. Refused from an AI chat (use port_forward_start)

**Options:**
- `--via <transport>` — cloudflare or tailscale (default: `"cloudflare"`)

**Usage:** `ppm forward start [options] <port>`

### `ppm forward stop`

Stop a forward this PPM started (never PPM's public link or another program's tunnel)

**Usage:** `ppm forward stop [options] <pid>`

## `ppm git`

Git operations for a project, through the running PPM

**Usage:** `ppm git [options] [command]`

### `ppm git status`

Show the branch and every changed file, as Source Control does

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

### `ppm git log`

Show recent commits

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `-n, --count <n>` — Number of commits to show (default: `"20"`)

### `ppm git diff`

Show the diff between two refs, or of the working tree

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git diff [options] [ref1] [ref2]`

### `ppm git stage`

Stage files (use "." to stage all)

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git stage [options] <files...>`

### `ppm git unstage`

Unstage files

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git unstage [options] <files...>`

### `ppm git discard`

Throw away the files' unstaged changes; PPM keeps a copy to undo it

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git discard [options] <files...>`

### `ppm git commit`

Commit the staged changes

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `-m, --message <msg>` — Commit message (required unless --amend)
- `--amend` — Replace the last commit
- `--signoff` — Add a Signed-off-by line

### `ppm git undo`

Undo a discard or the last commit

**Usage:** `ppm git undo [options] [command]`

#### `ppm git undo discard`

Put back what a discard threw away (the id 'ppm git discard' printed)

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git undo discard [options] <id>`

#### `ppm git undo commit`

Undo the last commit, keeping its changes staged; refused if it was pushed

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git undo commit [options] <hash>`

### `ppm git fetch`

Fetch from every remote, or one

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--remote <name>` — Only this remote
- `--prune` — Drop remote-tracking branches the remote no longer has

### `ppm git pull`

Pull the current branch from its upstream

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--rebase` — Rebase instead of merging

### `ppm git push`

Push the current branch, or a branch to a named remote

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--remote <name>` — A remote the repository has (default: the branch's own)
- `--branch <name>` — The branch to push (needs --remote)

### `ppm git publish`

Push a branch with no upstream and make the remote branch its upstream

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

### `ppm git branch`

Branch operations

**Usage:** `ppm git branch [options] [command]`

#### `ppm git branch create`

Create a branch and check it out

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--from <ref>` — Base ref (commit/branch/tag)

**Usage:** `ppm git branch create [options] <name>`

#### `ppm git branch checkout`

Switch to a branch, tag or commit

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--detach` — Check out the commit itself, on no branch
- `--track` — For a remote branch: create the local branch that follows it

**Usage:** `ppm git branch checkout [options] <name>`

#### `ppm git branch delete`

Delete a branch

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `-f, --force` — Delete it even when it is not merged

**Usage:** `ppm git branch delete [options] <name>`

#### `ppm git branch merge`

Merge a branch into the current branch

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git branch merge [options] <source>`

### `ppm git cherry-pick`

Apply one commit's change on the current branch

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git cherry-pick [options] <hash>`

### `ppm git revert`

Make a commit that undoes another

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

**Usage:** `ppm git revert [options] <hash>`

### `ppm git tag`

Tag the current commit, or another

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--at <hash>` — The commit to tag (default: HEAD)

**Usage:** `ppm git tag [options] <name>`

### `ppm git abort`

Abandon the merge, rebase, cherry-pick or revert that stopped part way

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

### `ppm git continue`

Finish the merge, rebase, cherry-pick or revert that stopped part way

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

### `ppm git stash`

Save, list and restore stashes

**Usage:** `ppm git stash [options] [command]`

#### `ppm git stash save`

Stash the working tree's changes

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `-m, --message <msg>` — A message for the stash
- `-u, --include-untracked` — Stash untracked files too

#### `ppm git stash list`

List the stashes

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

#### `ppm git stash apply`

Restore stash@{index}

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--expect <hash>` — Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)

**Usage:** `ppm git stash apply [options] <index>`

#### `ppm git stash pop`

Restore and delete stash@{index}

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--expect <hash>` — Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)

**Usage:** `ppm git stash pop [options] <index>`

#### `ppm git stash drop`

Delete stash@{index}

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--expect <hash>` — Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)

**Usage:** `ppm git stash drop [options] <index>`

### `ppm git worktree`

Linked worktrees

**Usage:** `ppm git worktree [options] [command]`

#### `ppm git worktree list`

List the repository's worktrees

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

#### `ppm git worktree add`

Add a worktree beside the repository

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `--branch <ref>` — An existing branch to check out in it
- `-b, --new-branch <name>` — Create this branch for it

**Usage:** `ppm git worktree add [options] <path>`

#### `ppm git worktree remove`

Remove a linked worktree

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON
- `-f, --force` — Remove it even with uncommitted changes

**Usage:** `ppm git worktree remove [options] <path>`

#### `ppm git worktree prune`

Forget worktrees whose folders are gone

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--repo <path>` — A repository inside the project, when the project folder holds several
- `--json` — Print the route's answer as JSON

## `ppm group-chat`

Group chats: AI agents talking with each other in one thread

**Usage:** `ppm group-chat [options] [command]`

### `ppm group-chat list`

List a project's group chats

**Options:**
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print JSON

### `ppm group-chat show`

Show a group chat and its members (with the member ids `members edit` takes)

**Options:**
- `--json` — Print JSON

**Usage:** `ppm group-chat show [options] <id>`

### `ppm group-chat create`

Create a group chat with a leader and members. Refused from an AI chat

**Options:**
- `--leader <name>` — The leader's name
- `--member <name>` — A member's name (repeat for each) (default: `[]`)
- `--max-turns <n>` — Replies one message may set off (1-50)
- `-p, --project <name>` — Project name or path (default: the project the current folder is in)
- `--json` — Print JSON

**Usage:** `ppm group-chat create [options] <name>`

### `ppm group-chat set`

Change a group chat's settings

**Options:**
- `--max-turns <n>` — Replies one message may set off (1-50)

**Usage:** `ppm group-chat set [options] <id>`

### `ppm group-chat members`

Add, change or remove a group chat's members

**Usage:** `ppm group-chat members [options] [command]`

#### `ppm group-chat members add`

Add a member to a group chat. Refused from an AI chat

**Options:**
- `--persona <text>` — Who the member is, in a sentence or two
- `--model <model>` — The model it runs on (default: the provider's)
- `--color <hex>` — Its colour in the feed (#rrggbb)
- `--leader` — Make it the leader (the current leader becomes a member)

**Usage:** `ppm group-chat members add [options] <id> <name>`

#### `ppm group-chat members edit`

Change a member; what is not given is kept ("" clears persona, model or colour)

**Options:**
- `--persona <text>` — Who the member is, in a sentence or two
- `--model <model>` — The model it runs on (default: the provider's)
- `--color <hex>` — Its colour in the feed (#rrggbb)
- `--name <name>` — A new name
- `--leader` — Make it the leader (the current leader becomes a member)

**Usage:** `ppm group-chat members edit [options] <id> <memberId>`

#### `ppm group-chat members remove`

Remove a member (not the leader); its transcript is archived first

**Usage:** `ppm group-chat members remove [options] <id> <memberId>`

### `ppm group-chat message`

Post a message to a group chat; its agents reply in the running PPM. Refused from an AI chat

**Usage:** `ppm group-chat message [options] <id> <text>`

### `ppm group-chat stop`

Stop a group chat's running replies (it is paused)

**Usage:** `ppm group-chat stop [options] <id>`

### `ppm group-chat resume`

Answer the last unanswered message of a paused group chat. Refused from an AI chat

**Usage:** `ppm group-chat resume [options] <id>`

### `ppm group-chat delete`

Delete a group chat; its members' transcripts are archived first

**Usage:** `ppm group-chat delete [options] <id>`

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

Set a project's Jira site and email; a new site or email without a new token clears the saved token

**Options:**
- `--url <url>` — Jira base URL (https://...)
- `--email <email>` — Jira account email
- `--token-prompt` — Type the API token at the terminal (required for a new config)

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
- `--json` — Print JSON

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

## `ppm keybindings`

List or change PPM's keyboard shortcuts

**Usage:** `ppm keybindings [options] [command]`

### `ppm keybindings list`

List the shortcuts changed from their defaults

**Options:**
- `--json` — Print JSON

### `ppm keybindings set`

Bind a command to keys, e.g. open-chat Mod+Shift+L (Mod is Ctrl, or Cmd on a Mac)

**Usage:** `ppm keybindings set [options] <command> <keys>`

### `ppm keybindings reset`

Put one shortcut, or every one, back to its default

**Usage:** `ppm keybindings reset [options] [command]`

## `ppm logs`

View PPM daemon logs

**Options:**
- `-n, --tail <lines>` — Number of lines to show (default: `"50"`)
- `-f, --follow` — Follow log output
- `-l, --level <level>` — Only this level and above: debug, info, warn, error, fatal
- `--clear` — Clear log file

**Usage:** `ppm logs [options] [command]`

### `ppm logs issues`

The errors and warnings of the last 24 hours, sorted into issues by AI (as the Logs window shows them)

**Options:**
- `--dismissed` — Include dismissed issues
- `--json` — Print JSON

**Usage:** `ppm logs issues [options] [command]`

#### `ppm logs issues analyze`

Sort the errors and warnings no issue covers yet, and wait for the result

**Options:**
- `--full` — Sort every pattern in the window again from scratch

#### `ppm logs issues auto`

Turn automatic sorting on or off

**Usage:** `ppm logs issues auto [options] <state>`

#### `ppm logs issues dismiss`

Hide an issue; a later sort keeps it hidden

**Usage:** `ppm logs issues dismiss [options] <id>`

#### `ppm logs issues undismiss`

Bring a dismissed issue back, or every one with --all

**Options:**
- `--all` — Bring back every dismissed issue

**Usage:** `ppm logs issues undismiss [options] [id]`

### `ppm logs report`

Draft a bug report from issues

**Usage:** `ppm logs report [options] [command]`

#### `ppm logs report draft`

Draft a GitHub bug report from issues' lines with AI, and print it (nothing is posted)

**Options:**
- `--note <text>` — What you saw, for the draft to use
- `--json` — Print JSON

**Usage:** `ppm logs report draft [options] <ids...>`

## `ppm lsp`

Language servers for the editor: list, install, remove

**Usage:** `ppm lsp [options] [command]`

### `ppm lsp list`

List the language servers PPM knows, and whether this machine has each

**Options:**
- `--json` — Print JSON

### `ppm lsp install`

Install a language server by its id (may take minutes)

**Options:**
- `-p, --project <name>` — Install for this project (its toolchain), not machine-wide

**Usage:** `ppm lsp install [options] <id>`

### `ppm lsp remove`

Remove a language server PPM installed (one on PATH or in a project is left alone)

**Usage:** `ppm lsp remove [options] <id>`

## `ppm manager`

Each project's manager chat: the chat PPM Assistant messages without asking

**Usage:** `ppm manager [options] [command]`

### `ppm manager list`

List every project's manager chat

**Options:**
- `--json` — Print JSON

### `ppm manager assign`

Make an existing Claude chat its project's manager chat. Refused from an AI chat (use manager_assign)

**Options:**
- `-p, --project <name>` — Project name or path (default: the project PPM recorded for the chat)
- `--replace` — Take the role from the project's current manager chat

**Usage:** `ppm manager assign [options] <session>`

### `ppm manager unassign`

Stop a project's manager chat being the manager; the chat is kept. Refused from an AI chat (use manager_unassign)

**Options:**
- `-p, --project <name>` — Project name or path (default: the current folder's project)

## `ppm mcp`

The MCP servers every chat starts with

**Usage:** `ppm mcp [options] [command]`

### `ppm mcp list`

List the servers; env and header values are never shown

**Options:**
- `--json` — Print JSON (values redacted)

### `ppm mcp add`

Add a server: --command (with --arg) or --url

**Options:**
- `--command <cmd>` — A local server: the program to run
- `--arg <value>` — An argument for --command (repeat for each) (default: `[]`)
- `--url <url>` — A remote server's address
- `--type <type>` — http or sse, for --url (default http)
- `--env <name>` — Set an environment variable; its value is typed at the terminal (repeat) (default: `[]`)
- `--header <name>` — Set a header; its value is typed at the terminal (repeat) (default: `[]`)

**Usage:** `ppm mcp add [options] <name>`

### `ppm mcp edit`

Change a server; what is not given is kept

**Options:**
- `--command <cmd>` — A local server: the program to run
- `--arg <value>` — An argument for --command (repeat for each) (default: `[]`)
- `--url <url>` — A remote server's address
- `--type <type>` — http or sse, for --url (default http)
- `--env <name>` — Set an environment variable; its value is typed at the terminal (repeat) (default: `[]`)
- `--header <name>` — Set a header; its value is typed at the terminal (repeat) (default: `[]`)
- `--unset-env <name>` — Remove an environment variable (repeat) (default: `[]`)
- `--unset-header <name>` — Remove a header (repeat) (default: `[]`)

**Usage:** `ppm mcp edit [options] <name>`

### `ppm mcp remove`

Remove a server; chats started after this do not get it

**Usage:** `ppm mcp remove [options] <name>`

### `ppm mcp import`

Add the servers from ~/.claude.json, or from a JSON file (`{ mcpServers: {...} }`); existing names are kept

**Usage:** `ppm mcp import [options] [file]`

## `ppm notify`

What PPM notifies you about, and through which channels

**Usage:** `ppm notify [options] [command]`

### `ppm notify get`

Show the events, the delay and the channels

**Options:**
- `--json` — Print JSON

### `ppm notify set`

Switch an event (done, approval_request, question, collab_approval, schedule, jira, design_review) or a channel (telegram, ntfy) on or off

**Usage:** `ppm notify set [options] <event> <state>`

### `ppm notify delay`

Wait this long, and send only if nobody has looked by then (0 sends at once; at most 3600)

**Usage:** `ppm notify delay [options] <seconds>`

### `ppm notify ntfy`

The ntfy server and topic notifications are published to

**Usage:** `ppm notify ntfy [options] [command]`

#### `ppm notify ntfy set`

Set the server and topic; the server is checked first. A new server drops the old server's token

**Options:**
- `--server <url>` — e.g. https://ntfy.sh (default: the current one)
- `--topic <topic>` — 1 to 64 letters, digits, - or _ (default: the current one)
- `--token-prompt` — Type an access token at the terminal

#### `ppm notify ntfy remove`

Stop publishing to ntfy and forget the server, topic and token

#### `ppm notify ntfy test`

Publish a test notification

### `ppm notify telegram`

The Telegram chats notifications go to (the bot: `ppm telegram-bot`)

**Usage:** `ppm notify telegram [options] [command]`

#### `ppm notify telegram chats`

List the chats receiving notifications

**Options:**
- `--json` — Print JSON

#### `ppm notify telegram remove`

Stop sending notifications to a chat

**Usage:** `ppm notify telegram remove [options] <chatId>`

#### `ppm notify telegram connect`

Make a one-time link: the chat that opens it receives notifications

**Options:**
- `--cancel` — Withdraw the open link

### `ppm notify push`

Browser push (subscribing is done in each browser)

**Usage:** `ppm notify push [options] [command]`

#### `ppm notify push test`

Send a test push to every subscribed browser, or one

**Options:**
- `--device <id>` — Only this browser (see `ppm notify get --json`)

## `ppm open`

Open PPM in browser

## `ppm ppmbot`

PPM Assistant on Telegram: its switch, bot and connected chats

**Usage:** `ppm ppmbot [options] [command]`

### `ppm ppmbot get`

Show the switch, the bot and whether the bridge is running

**Options:**
- `--json` — Print JSON

### `ppm ppmbot set`

enabled true|false, show-tool-calls true|false, or debounce <0-30000 ms>

**Usage:** `ppm ppmbot set [options] <setting> <value>`

### `ppm ppmbot token`

Set the Assistant's bot token (typed at the terminal) or remove it

**Options:**
- `--token-prompt` — Type the token from @BotFather at the terminal
- `--remove` — Remove the bot; the bridge stops

### `ppm ppmbot chats`

List the chats that may talk to the Assistant

**Options:**
- `--json` — Print JSON

### `ppm ppmbot revoke`

Disconnect a chat: not one more message from it reaches the Assistant

**Usage:** `ppm ppmbot revoke [options] <chatId>`

### `ppm ppmbot connect`

Make a one-time link: the chat that opens it may talk to the Assistant

**Options:**
- `--cancel` — Withdraw the open link

## `ppm projects`

Manage registered projects

**Usage:** `ppm projects [options] [command]`

### `ppm projects list`

List all registered projects

**Options:**
- `--json` — Output as JSON

### `ppm projects add`

Add a project to the registry, through the running PPM when one holds the database

**Options:**
- `-n, --name <name>` — Project name (defaults to folder name)

**Usage:** `ppm projects add [options] <path>`

### `ppm projects remove`

Remove a project from the registry (by name or folder); its files stay on disk

**Usage:** `ppm projects remove [options] <name>`

### `ppm projects rename`

Rename a project; its chats and settings stay with it

**Usage:** `ppm projects rename [options] <name> <newName>`

### `ppm projects move`

Point a project at another folder; the old folder is left as it is

**Usage:** `ppm projects move [options] <name> <path>`

### `ppm projects color`

Set a project's colour (#rrggbb), or `none` to clear it

**Usage:** `ppm projects color [options] <name> <color>`

### `ppm projects icon`

Set a project's icon from a PNG, JPEG, GIF or WebP file (2 MB at most), or --clear it

**Options:**
- `--clear` — Remove the project's icon

**Usage:** `ppm projects icon [options] <name> [file]`

### `ppm projects reorder`

Put projects in this order; projects not named keep their order after them

**Usage:** `ppm projects reorder [options] <names...>`

### `ppm projects clone`

Clone a git repository into <dir>/<name> and register it as a project

**Options:**
- `-n, --name <name>` — Folder and project name (defaults to the repository's name)

**Usage:** `ppm projects clone [options] <url> <dir>`

### `ppm projects settings`

Per-project settings (file filters)

**Usage:** `ppm projects settings [options] [command]`

#### `ppm projects settings get`

Print a project's settings as JSON

**Options:**
- `--json` — Print the JSON alone, with no banner

**Usage:** `ppm projects settings get [options] <name>`

#### `ppm projects settings set`

Set one setting by its dotted key (e.g. files.useIgnoreFiles false, files.filesExclude '["dist"]')

**Usage:** `ppm projects settings set [options] <name> <key> <value>`

## `ppm proxy`

Show or change the API proxy that lends your accounts to other tools

**Usage:** `ppm proxy [options] [command]`

### `ppm proxy get`

Show the proxy's state and endpoints; the auth key only as its first characters

**Options:**
- `--reveal` — Print the whole auth key
- `--json` — Print JSON

### `ppm proxy set`

Switch the proxy on or off: set enabled true|false

**Usage:** `ppm proxy set [options] <setting> <value>`

### `ppm proxy key`

Manage the proxy's auth key

**Usage:** `ppm proxy key [options] [command]`

#### `ppm proxy key generate`

Replace the auth key with a new random one; the old key stops working

## `ppm report`

Report a bug on GitHub (pre-fills env info + logs)

## `ppm restart`

Restart the server (keeps tunnel alive)

**Options:**
- `--force` — Force resume from paused state

## `ppm restore`

Restore the PPM config database from a snapshot (refused from an AI chat; --list is not)

**Options:**
- `--list` — List available snapshots and exit
- `--force` — Restore even while PPM is running (stop it first when you can)
- `--json` — Output as JSON

**Usage:** `ppm restore [options] [backup]`

## `ppm schedule`

Scheduled Claude agents (cron) and script schedules

**Usage:** `ppm schedule [options] [command]`

### `ppm schedule add`

Add a scheduled agent (--prompt) or a script schedule (--script). Cron uses local timezone. Do not embed secrets in --prompt. Refused from an AI chat (use schedule_save).

**Options:**
- `--name <name>` — Schedule name
- `--cron <expr>` — Cron expression (local timezone, e.g. "0 7 * * *"; a script may add seconds first)
- `--project <nameOrPath>` — Project name or path
- `--prompt <text>` — Prompt sent to the agent each run
- `--script <file>` — JavaScript module run each tick, or kept running
- `--mode <mode>` — Script mode: tick (on the cron) or always-on (default: `"tick"`)
- `--permission-mode <mode>` — Permission mode (default: `"bypassPermissions"`)
- `--max-turns <n>` — Max turns per run (prompt only)
- `--timeout <ms>` — Timeout per run in ms (default 1800000 for a prompt, 300000 for a script tick)
- `--disabled` — Create disabled

### `ppm schedule edit`

Change a schedule: only the options given change. Refused from an AI chat (use schedule_save).

**Options:**
- `--name <name>` — Schedule name
- `--description <text>` — Description
- `--cron <expr>` — Cron expression (local timezone)
- `--project <nameOrPath>` — Project name or path
- `--prompt <text>` — Prompt sent to the agent each run (prompt schedules)
- `--script <file>` — The script to run from now on (script schedules)
- `--mode <mode>` — Script mode: tick or always-on
- `--permission-mode <mode>` — Permission mode
- `--max-turns <n>` — Max turns per run (prompt only)
- `--timeout <ms>` — Timeout per run in ms

**Usage:** `ppm schedule edit [options] <id>`

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

Enable a schedule. Refused from an AI chat (use schedule_save).

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

### `ppm schedule export`

Write a schedule as a shareable template — never its secrets, state or history

**Options:**
- `-o, --output <file>` — Write to this file instead of standard output

**Usage:** `ppm schedule export [options] <id>`

### `ppm schedule import`

Create a schedule from a template, turned off. Read its code before you trust it.

**Options:**
- `--project <name>` — Project it runs in
- `--set <key=value>` — Value of an input (repeatable) (default: `[]`)
- `--secret <key=value|key=@file>` — Value of a secret input; @file reads it from a file (repeatable) (default: `[]`)
- `--trust` — I have read this code and trust it to run on this machine

**Usage:** `ppm schedule import [options] <file>`

### `ppm schedule state`

Print a script schedule's state, secrets masked

**Usage:** `ppm schedule state [options] <id>`

### `ppm schedule set-state`

Replace a script schedule's state with a JSON file; the schedule must be off

**Usage:** `ppm schedule set-state [options] <id> <file>`

## `ppm settings`

PPM's file filters and how long it keeps its logs

**Usage:** `ppm settings [options] [command]`

### `ppm settings files`

The file filters every project uses unless it sets its own

**Usage:** `ppm settings files [options] [command]`

#### `ppm settings files get`

Show the global file filters

**Options:**
- `--json` — Print JSON

#### `ppm settings files set`

Replace the global file filters; a list option replaces that whole list ("" empties it)

**Options:**
- `--exclude <globs...>` — Globs hidden from the file tree
- `--search-exclude <globs...>` — Globs left out of search
- `--use-ignore-files <bool>` — Honour .gitignore: true or false

### `ppm settings query-audit`

The log of every database statement PPM ran

**Usage:** `ppm settings query-audit [options] [command]`

#### `ppm settings query-audit get`

Show how long the log is kept and what it holds

**Options:**
- `--json` — Print JSON

#### `ppm settings query-audit set`

Change how long the log is kept

**Options:**
- `--retention-days <n>` — Days to keep a statement (at least 1)
- `--max-size-mb <n>` — Size the log is cut back to (at least 10)

#### `ppm settings query-audit clear`

Delete every recorded statement (cannot be undone)

**Options:**
- `--yes` — Confirm the deletion

### `ppm settings trace`

The session trace: what every chat turn did

**Usage:** `ppm settings trace [options] [command]`

#### `ppm settings trace set`

Change how long the session trace is kept

**Options:**
- `--retention-days <n>` — Days to keep a session's trace
- `--max-size-mb <n>` — Size the trace is cut back to

## `ppm skills`

Manage and inspect discovered skills & commands

**Options:**
- `--project <path>` — Project path (default: current directory)

**Usage:** `ppm skills [options] [command]`

### `ppm skills list`

List all discovered skills and commands

**Options:**
- `--json` — JSON output
- `--project <path>` — Project path (default: current directory)

### `ppm skills search`

Fuzzy search skills and commands

**Options:**
- `--json` — JSON output
- `--project <path>` — Project path (default: current directory)

**Usage:** `ppm skills search [options] <query>`

### `ppm skills info`

Show detailed info for a specific skill

**Options:**
- `--json` — JSON output
- `--project <path>` — Project path (default: current directory)

**Usage:** `ppm skills info [options] <name>`

## `ppm speech`

Speech to text for the chat mic (Whisper on this machine)

**Usage:** `ppm speech [options] [command]`

### `ppm speech status`

Show whether Whisper is installed, which model, and any install in progress

**Options:**
- `--json` — Print JSON

### `ppm speech install`

Download Whisper and a model (may take minutes); waits until it is done

**Options:**
- `--model <id>` — Which model (see `ppm speech status`); PPM's default when left out

### `ppm speech remove`

Remove the Whisper build and models PPM installed

## `ppm start`

Start the PPM server (background by default)

**Options:**
- `--minimal` — Minimal workspace: chat, files, editor and settings
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

## `ppm system`

This machine's processes and services, through PPM's Task Manager

**Usage:** `ppm system [options] [command]`

### `ppm system processes`

List running processes (CPU is measured between two samples, so --sort cpu takes a few seconds)

**Options:**
- `--sort <key>` — cpu or mem (default: `"mem"`)
- `-n, --limit <count>` — How many rows (default: `"20"`)
- `--filter <text>` — Only processes whose pid, name or command line matches
- `--json` — Print JSON

### `ppm system process`

Show one process: command line, folder, user, state

**Options:**
- `--json` — Print JSON

**Usage:** `ppm system process [options] <pid>`

### `ppm system kill`

End a process: TERM, then KILL after a grace period (--force: KILL at once)

**Options:**
- `--force` — Send KILL straight away
- `--tree` — End its child processes too
- `--expect-name <name>` — Refuse unless the process has this name (required from an AI chat)

**Usage:** `ppm system kill [options] <pid>`

### `ppm system signal`

Send a signal to a process: TERM, KILL, STOP, CONT, HUP, INT, USR1, USR2 (Windows: TERM, KILL)

**Options:**
- `--tree` — Signal its child processes too
- `--expect-name <name>` — Refuse unless the process has this name (required from an AI chat)

**Usage:** `ppm system signal [options] <pid> <signal>`

### `ppm system resources`

CPU, memory and swap of this machine right now (takes a few seconds to measure CPU)

**Options:**
- `--json` — Print JSON

### `ppm system services`

List services (systemd units, launchd jobs, Windows services)

**Options:**
- `--user` — Only the user's own
- `--system` — Only the machine's
- `--filter <text>` — Only names or descriptions containing this
- `--json` — Print JSON

### `ppm system service`

Show a service, or run start|stop|restart|enable|disable on it: `service <name>`, `service stop <name>`

**Options:**
- `--user` — The user's own service rather than the machine's
- `--log` — Print its recent log lines too
- `--json` — Print JSON

**Usage:** `ppm system service [options] <nameOrAction> [name]`

## `ppm tags`

Manage a project's chat tags

**Usage:** `ppm tags [options] [command]`

### `ppm tags list`

List a project's tags and how many chats carry each

**Options:**
- `-p, --project <name>` — Project name or path (default: the current folder's project)
- `--json` — Print JSON

### `ppm tags add`

Create a tag

**Options:**
- `-p, --project <name>` — Project name or path (default: the current folder's project)
- `--color <hex>` — Colour as #rrggbb (default: `"#6b7280"`)

**Usage:** `ppm tags add [options] <name>`

### `ppm tags rename`

Rename a tag

**Options:**
- `-p, --project <name>` — Project name or path (default: the current folder's project)

**Usage:** `ppm tags rename [options] <tag> <newName>`

### `ppm tags remove`

Delete a tag; its chats keep existing, untagged

**Options:**
- `-p, --project <name>` — Project name or path (default: the current folder's project)

**Usage:** `ppm tags remove [options] <tag>`

## `ppm teams`

Claude agent teams: list or delete them

**Usage:** `ppm teams [options] [command]`

### `ppm teams list`

List the agent teams on this machine

**Options:**
- `--json` — Print JSON

### `ppm teams delete`

Delete an agent team's folder (its config and inboxes)

**Usage:** `ppm teams delete [options] <name>`

## `ppm telegram-bot`

The Telegram bot notifications are sent through

**Usage:** `ppm telegram-bot [options] [command]`

### `ppm telegram-bot get`

Show the bot (its token only as the first characters)

**Options:**
- `--json` — Print JSON

### `ppm telegram-bot set`

Replace the bot's token, typed at the terminal; Telegram is asked whether it is real first

**Options:**
- `--token-prompt` — Type the token from @BotFather at the terminal

### `ppm telegram-bot remove`

Forget the bot; no Telegram notification is sent until another is set

### `ppm telegram-bot test`

Send a test notification to every connected chat

## `ppm theme`

Show, pick, import or remove PPM's themes

**Usage:** `ppm theme [options] [command]`

### `ppm theme get`

Show the theme in use

**Options:**
- `--json` — Print JSON

### `ppm theme set`

Use a theme: aurora, slate, precision, or an imported theme's id or name

**Options:**
- `--mode <mode>` — light, dark or system (default: keep the current one)

**Usage:** `ppm theme set [options] <theme>`

### `ppm theme list`

List the built-in styles and the imported themes

**Options:**
- `--json` — Print JSON

### `ppm theme import`

Import a VS Code color theme from a JSON file, or from a URL (JSON or .vsix)

**Options:**
- `--name <name>` — Name to show it under

**Usage:** `ppm theme import [options] <fileOrUrl>`

### `ppm theme remove`

Delete an imported theme

**Usage:** `ppm theme remove [options] <id>`

### `ppm theme rename`

Rename an imported theme

**Usage:** `ppm theme rename [options] <id> <name>`

## `ppm upgrade`

Check for and install PPM updates

**Options:**
- `--check` — Only check for updates, don't install
