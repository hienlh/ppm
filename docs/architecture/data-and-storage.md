# Data & Storage

> Part of the [PPM system architecture](../system-architecture.md).

## Group-Chat Data Model (schema v35)

Three tables back the native group-chat engine; the message bus is a single
table keyed by `kind` + JSON `data` (spike-validated) with a monotonic `seq`
PK for stable ordering, and is the durable source of truth across Stop/Resume:

- `chat_groups(id, project_name, project_path, name, leader_session_id, status[active|paused|idle], max_turns=40, max_cost_usd=5.0, created_at)`
- `chat_group_members(id, group_id→chat_groups, role[leader|member], persona, agent_type, model, session_id, name, color, status, joined_at)`
- `chat_group_messages(seq PK, id, group_id→chat_groups, from_member, to_member, kind[task|chat|status|completion|final], summary, full_session_ref, data JSON, turn_index, created_at)`

Flow: user message → engine runs sequential @mention-driven turns over the bus →
converges to one `final` → member transcripts archived (Option A+). Stop aborts
mid-turn (cooperative) and pauses; Resume re-spawns fresh sessions and re-enters
the loop seeded from the bus (windowed + rolling summary).
| **TagService** | Session tagging CRUD, bulk operations, tag-session enrichment | seedDefaultTags, getTagsByProject, createTag, updateTag, deleteTag, setSessionTag, bulkSetSessionTag, getSessionTags, getTagSessionCounts |
| **DraftService** | Chat draft auto-save per session, 50KB cap | get, upsert, delete, deleteOrphaned |
| **FileFilterService** | Glob pattern matching + precedence-enforced filtering (hardcoded ⊂ global ⊂ project) | mergeFilters, isPathIgnored, matchesPattern |
| **SystemMetricsService** (`src/services/system-metrics/`) | Whole-machine Task Manager backend: CPU per core + RAM (`/proc` on Linux, `host_statistics64` on macOS, `node:os` elsewhere), disk/net/GPU + all processes via per-OS collectors (Linux `/proc`/`/sys`; macOS the kernel over `bun:ffi` — `host_statistics64`, `proc_pid_rusage`, SMC, IOReport, CoreWLAN — plus `ps` and one memoised `ioreg`/`netstat`/`ifconfig` read per tick; Windows one long-lived PowerShell REPL child, `Win32_Process` + `PerfRawData` per 2 s tick), delta-based CPU%, grouping by app root, aggregate-only 30-min history. Two SSE tiers on `/api/system/resources/stream`: `light` (status bar, no children spawned) and `full` (`?processes=1`, demand-gated collectors, 60 s teardown). Subscriber lease (sid + 10 s ping, 30 s expiry) because Cloudflare tunnel never propagates client disconnects. Guarded `POST /resources/kill`: protected set (PPM server/supervisor/edge/cloudflared, OS-critical names), ancestor/tree-intersection rule, `startedAt` identity re-query → 409, JSON + `X-PPM-Request` header. | subscribe, unsubscribe, ping, getLatest, kill, reapExpired |

**Key Files:** `src/services/*.service.ts`, `src/services/tag.service.ts`, `src/services/bash-output-spy.ts`, `src/services/system-metrics/system-metrics.service.ts`, `src/services/system-metrics/kill-guard.ts`, `src/services/system-metrics/powershell-session.ts`, `src/services/redact-secrets.ts`, `src/services/file-filter.service.ts`

---

## Database Management

PPM manages external databases — SQLite files, PostgreSQL, MySQL and MariaDB — with a DBGate-style UI: a connection tree, a data grid (filter row, multi-column sort, editing saved as one script), Form view / Cell data / References, a Structure editor, Import/Export jobs and a multi-statement Query tab.

### Layers

```
Browser — src/web/components/database/
  connections-section/, explorer/, object-tree/   CONNECTIONS + TABLES, VIEWS, FUNCTIONS sidebar
  table/, grid/                                   Glide data grid, filter row, Form view, Cell data, References
  structure/, table-editor/, sql-object/          Structure tab, table editor, CREATE script tab
  impexp/                                         Import/Export tab
  query/                                          Query tab (Monaco, Messages + Result N, History)
  connection-form/, db-login/                     connection tab, Database Log In dialog
        │  REST under /api/db (PPM auth); the Query tab's runs stream NDJSON
Routes — src/server/routes/database*.ts
        │
Services — src/services/database/
  adapter-registry → sqlite-adapter / postgres-adapter / mysql-adapter
  dialect-*.ts + grid-query-builder.ts            every grid SELECT is built on the server
  changeset.service.ts, structure-edit.service.ts, ddl/   writes and DDL, one transaction each
  impexp/                                         export and import jobs
  query-script-runner.ts                          Query tab runs
  drivers/                                        drivers installed from Settings
        │
postgres.service.ts (postgres.js) · mysql.service.ts (mysql2, installed on demand) · sqlite.service.ts (bun:sqlite)
```

### Routes (`/api/db`)

| Area | Routes |
|---|---|
| Connections | `GET`/`POST /connections`, `GET`/`PUT`/`DELETE /connections/:id`, `GET /connections/:id/config`, `POST /connections/:id/duplicate`, `POST /connections/folder`, `GET /connections/export`, `POST /connections/import`, `POST /test`, `POST /connections/:id/test` |
| Login | `POST /connections/:id/login`, `POST /connections/:id/disconnect` |
| Tree | `GET /connections/:id/databases`, `/objects`, `/columns`, `/structure`, `/object-sql`, `/tables` (`?cached=1` reads PPM's own cache) |
| Grid | `POST /connections/:id/grid`, `/grid/count`, `/grid/values`, `/grid/export`, `/grid/cell`; the export's file is `GET /grid-export/:ticket` |
| Writes | `POST /connections/:id/changeset/preview`, `/changeset/apply` |
| Structure | `POST /connections/:id/structure/preview`, `/structure/apply` |
| Import/Export | `POST /connections/:id/impexp/export`, `/impexp/import`; `PUT /impexp/uploads`, `POST /impexp/uploads/:id/preview`, `DELETE /impexp/uploads/:id`, `GET /impexp/jobs/:id`, `POST /impexp/jobs/:id/stop`, `POST /impexp/jobs/:id/download` |
| Query tab | `POST /connections/:id/query/script` (NDJSON), `POST /connections/:id/query/cancel`, `GET /connections/:id/history` |
| AI chat | `POST /ai-approvals/:requestId` — the user's answer to a `db_execute`, with PPM's password |
| Kept for the CLI, agents and SQL completion | `POST /connections/:id/query`, `GET /connections/:id/schema`, `/data`, `/export`, `PUT /connections/:id/cell`, the `/row` routes, `GET /search` |
| Drivers | `GET /drivers`, `POST /drivers/:id/install`, `DELETE /drivers/:id`, `GET /ssh/agent` |

- `?database=` targets another database on the same server (the tree's database nodes). It is refused with 400 for a connection that uses only its own database, and for a database not in the connection's **Allowed databases** list (ignoring case; the connection's own database is always allowed). The allowed-databases regular expression only filters the tree: the server never runs a pattern the user typed. None of this is a permission: SQL typed in a Query tab, or a MySQL table named with its database, reaches whatever the login can.
- A database **file** that is not a saved connection is served at `/connections/file/…?path=&project=`: the data routes only, with the path checked again on every request. Typed SQL on such a file returns at most 1,000 rows.
- Before a route runs, a middleware answers **424** when the engine's driver is not installed and **428** when the connection asks for its password and no login is held.

### Dialects and the grid

- `dialect-*.ts` quote identifiers, page, cast and compare per engine. `grid-query-builder.ts` turns the grid's request — columns, DBGate filter syntax per column, multi-column sort, page — into one parameterised `SELECT`. The browser never sends SQL for the grid.
- Rows come 100 at a time and **Fetch all** asks for the rest. `/grid/count` shows the engine's own estimate first and an exact `COUNT(*)` only if it finishes within 10 s (5 minutes when the user asks for an exact count), so a large table opens without waiting on a count.
- Dates and times travel as text, as the database prints them — no conversion to ISO / UTC on the way.
- Columns come from the driver's result metadata, never from `Object.keys` of a row, so `SELECT 1 a, 2 a` shows both columns.

### Writes: one changeset, one transaction

- The grid collects edited cells, new rows and deleted rows into one changeset (with undo/redo). **Save** shows the script (`/changeset/preview`) and `/changeset/apply` runs every statement in **one transaction**. Rows are addressed by the table's whole primary key, multi-column keys included.
- Deleting a row that other rows still reference offers **Delete references CASCADE**: the server walks the foreign keys (`listForeignKeys`) and deletes the referencing rows first, in the same transaction.

### Readonly, enforced by the database

A connection is readonly by default (`connections.readonly = 1`). Two layers:

1. `isReadOnlyQuery()` refuses an obvious write before it is sent, and the audit log records it as `blocked`.
2. The database refuses whatever gets past that check. PostgreSQL runs each statement inside `BEGIN READ ONLY`, always rolled back. MySQL / MariaDB sessions start with `SET SESSION TRANSACTION READ ONLY` and run statements inside `START TRANSACTION READ ONLY`. SQLite opens a `readonly` handle.

The second layer is what stops writes hidden in a function call — `nextval`, `setval`, a function that writes — on every path, `ppm db query` included.

### Structure editing

The Structure tab edits a table model. `ddl/table-diff.ts` compares it with the catalog, and `ddl/ddl-<engine>.ts` turns the difference into a plan that is previewed (`/structure/preview`) and applied (`/structure/apply`). SQLite can `ALTER` very little, so `ddl/sqlite-recreate.ts` follows SQLite's documented 12-step rebuild (new table, copy, drop, rename, indexes and triggers again, `foreign_key_check`) inside one transaction. New tables go through the same path. The SQL object tab shows an object's `CREATE` script (`/object-sql`).

### Import and Export

- The grid's **Export ▾** streams the current view, filters and sort applied, as CSV, TSV, JSON, NDJSON, SQL `INSERT`s, XML or XLSX. A browser can only save a download it navigated to, and such a request carries no auth header, so the authenticated `POST /grid/export` answers with a ticket and the browser fetches `GET /grid-export/:ticket` — once, within 30 s.
- The Import/Export tab runs **jobs** (`impexp/`): several tables at a time, per-format options, column mapping, then one file per table or, with **Create single file**, one XLSX workbook with a sheet per table — optionally zipped. Import reads uploaded CSV, JSON or JSON-lines files into new or existing tables. An export reads inside a READ ONLY transaction. A job is polled by id, can be stopped, and its file is fetched once.

### Query tab

- `POST /query/script` splits the script with `splitSqlScript` (it understands MySQL's `DELIMITER`) and runs it one statement at a time in a session of its own, so `SET`, temporary tables and `BEGIN` carry from one statement to the next. Each statement's result is sent as soon as it ends, as one NDJSON line (`start`, `running`, `statement`, `message`, `done`).
- **Stop** (`/query/cancel` with the `runId` the browser chose) cancels only the running statement: postgres.js `cancel()` on PostgreSQL, `KILL QUERY` from another connection on MySQL / MariaDB. `bun:sqlite` cannot be interrupted mid-statement, so the runner yields between statements and Stop keeps the next one from starting.
- A transaction the script leaves open is rolled back and reported. Results are cut at the tab's row limit on the server (closing the cursor, `sql_select_limit`, or `LIMIT N+1`), so the rest are never read.
- History is read from the query audit log (`source` `editor` or `ai`, the AI chat's database tools); there is no separate store.
- **Run with write access (once)**: on a readonly connection, a run refused as a write can be sent again with `writeOnce: { password }` — PPM's password, typed in the tab — and runs on a writable session that one time. A wrong password is a 403; the run is audited with `writeOnce: true` in its params.

### Connections and secrets

```sql
-- ~/.ppm/ppm.db (schema v56)
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('sqlite', 'postgres', 'mysql', 'mariadb')),
  name TEXT NOT NULL UNIQUE,
  connection_config TEXT NOT NULL,       -- encrypted StoredConnectionConfig
  group_name TEXT,                       -- folder in the CONNECTIONS tree
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  readonly INTEGER NOT NULL DEFAULT 1,
  ai_access INTEGER NOT NULL DEFAULT 1   -- 0: the AI chat's database tools, and `ppm db` run from an AI chat, do not see it
);

CREATE TABLE connection_table_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT 'public',
  row_count INTEGER NOT NULL DEFAULT 0,
  cached_at TEXT,
  UNIQUE(connection_id, schema_name, table_name)
);
```

- `connection_config` is encrypted at rest and never sent to the browser, with one deliberate exception: **Export** (`GET /connections/export`) hands out every connection's config in plain text — database, SSH and SSL key passwords included — because Import recreates the connections from that file, and its menu says so. `GET /connections/:id/config` returns the form's fields with each secret replaced by a `has…` flag.
- `StoredConnectionConfig` (`src/shared/db-connection-config.ts`) holds the URL or the host / port / user fields, `passwordMode` (`saved` or `ask`), `singleDatabase`, `allowedDatabases` (+ regex), `isolationLevel`, `queryTimeoutSec`, `ssh` and `ssl`.
- **Ask for password**: the password is never stored. Database Log In holds the login in memory until **Disconnect**, which also closes the connection's pools.
- **SSH tunnel**: password, key file or SSH agent. A host key is pinned on first use in PPM's own `known_hosts`. **SSL**: CA, client certificate and key files; `verify-full` checks the host name, an IP address included.
- **SQLite files PPM refuses**: PPM's own folder, its database snapshots and `~/.cloudflared`, judged by the file's real path (a symlink to `ppm.db` is refused) at save, at import and again at every open (`src/services/database/sqlite-path-guard.ts`, called by the routes, `sqlite.service.ts` and the SQLite adapter's probe), for every caller.
- **A moved endpoint drops its secrets**: an edit (or the form's Test of one) that points a connection at another host, port, socket, login, SSH host, SSH port, bastion or SSH login, and types no new secret, drops the saved password, SSH password and passphrase and SSL key password (`connection-endpoint-reset.ts`). `PUT` answers `secretsCleared` naming them. Another database on the same server keeps them.
- Every connection write (create, edit, delete, import, folder, duplicate) announces `db:connections_changed` on `/ws/global` (`database-connections-broadcast.ts`); the browser re-reads its connection list.
- Migration 55 rebuilt `connections` to accept `mysql` / `mariadb`. Dropping the old table would have cascade-deleted `connection_table_cache`, so it runs with `PRAGMA foreign_keys = OFF` — set outside the transaction, where that pragma takes effect.

### Drivers installed on demand

MySQL / MariaDB (`mysql2`) and SSH tunnels (`ssh2`) are not bundled. **Settings → Database Drivers** (or `ppm db driver install <id>`) installs the pinned version with its pinned lockfile (`db-driver-locks.generated.json`) into `<ppm dir>/db-drivers/<id>`, and `db-driver-loader.ts` imports it from there.

### Query audit

Every statement PPM runs on a user database is logged in `<ppm dir>/query-audit.db`, with its source (`editor`, `grid`, `cli`, `filter`, `structure`, `export`, `import`, `ai`), actor (human or agent), operation and status (`ok`, `error`, `blocked`). How long it is kept follows Settings (`query_audit.retention_days`, `max_size_mb`).

### AI chat tools

An AI chat reaches the saved connections with *Available to the AI chat* on through three tools PPM serves itself — `db_query` (read-only), `open_query` (a Query tab with a script the user runs) and `db_execute` (a change, run once in one transaction after the user approves it with PPM's password) — without ever holding their credentials. See `docs/architecture/ai-chat-and-providers.md` → AI database tools.

### CLI (`ppm db`)

```bash
ppm db list                           # connections (hides ai_access = 0 inside an AI chat)
ppm db add -n <name> -t <type> -c <url> | -f <file> [--password-mode save|ask|ask-user] [--ai on|off]
ppm db edit <name> [--name] [-c <url>] [-f <file>] [-g <folder>] [--color] [--password-mode] [--ai]
ppm db remove | test | duplicate <name>
ppm db import <file>                  # an Export file; keeps its read-only and AI flags
ppm db tables <name>
ppm db schema <name> <table>
ppm db data <name> <table>
ppm db query <name> <sql>             # readonly enforced by the database
ppm db run <name> <file>              # a multi-statement file
ppm db driver list | install <id> | remove <id>
```

`add`, `edit`, `remove`, `test`, `duplicate` and `import` go through the running PPM's connection routes (in-process with a notice when no PPM holds the database), so the server's checks apply and the Database sidebar updates at once. Neither `add` nor `edit` sends `readonly`: a connection made from the CLI is read-only until the user switches that off in PPM. From an AI chat (advisory; the shell card is the control) a URL holding a password, `--ai on` and `import` are refused before any request. The data commands go through the same adapters as the web UI, so readonly, the audit log and "ask for password" (a hidden prompt on the terminal) behave the same.

---

## PPM Tasks store

A per-project task list kept in `ppm.db`. AI chats read and write it only through the
`ppm_task_*` tools ([AI chat → PPM task tools](ai-chat-and-providers.md#ppm-task-tools)); people
use the Tasks sidebar section and task tabs ([Workspace & UI → PPM Tasks](workspace-and-ui.md#ppm-tasks))
and Telegram `/tasks` ([PPM Assistant → Commands, links and settings](ppm-assistant.md#commands-links-and-settings)).
Everything is named `ppm-tasks` / `ppm_task_*` because `TaskItem`, `use-tasks.ts`,
`task-status-aggregator.ts` and the model's built-in `TaskCreate`/`TaskList` already mean Claude's
own to-do list, which is something else.

**Where things are.** Tables: migration 74, `src/services/ppm-tasks/ppm-tasks-schema.ts` (it only
adds tables, so an older binary ignores them). Shapes: `src/shared/ppm-tasks.ts` (with
`ppm-tasks-config.ts` and `ppm-tasks-history.ts`); REST shapes and `/ws/global` events:
`src/shared/ppm-tasks-api.ts`. Service: `src/services/ppm-tasks/`. Routes: `/api/tasks`
(`src/server/routes/ppm-tasks.ts` for lists and plain writes, `ppm-tasks-actions.ts` for decide,
start chat, notify manager, links, history and undo, link states, `ppm-tasks-projects.ts` for the
per-project switch and settings). Background work (daily compaction, link states, handed-off work
checks) starts in `ppm-tasks-startup.ts`.

**One write, one transaction.** Every change goes through `ppm-tasks.service.ts`: the revision
check, the row change (`ppm-tasks-write.ts`, the one place a task row is changed) and its history
row commit together. A write names the revision it read; a stale one changes nothing and fails as
`conflict` naming the current revision (REST 409 `stale` with `revision`; the AI tools tell the model
to read the task again). A write that changes nothing writes no history and keeps the revision.
Events go out only after the commit. Deleting is soft (`deleted_at`); the row and its history stay.
Derived columns are kept in step by the write itself: `closed_at` from the status's group,
`waiting_since` from "waiting on", and `handed_off_at`, set while the working session is a chat
other than the project's manager chat. A working session must be a chat of the task's own project
that is neither a PPM Assistant nor a design chat (`ppm-tasks-session-check.ts`), checked on write
and again when a decision is sent to it.

**Statuses and fields.** Each project edits its own status list, seeded with To do / In progress /
Waiting / Done / Dropped on first use, but every status belongs to one of four base groups
(`not_started`, `active`, `waiting`, `closed`), so all-projects views can merge projects; a closed
status says whether it closes the task as `done` or `dropped`. Members are per project (`me` is the
user and never a row); custom fields have a declared type the UI renders and filters on, and a key
nobody declared is kept as free key–value and shown raw.

**Urgency is derived, never written by a timer.** A task stores its own urgency (Now / Today /
This week / Later) and importance (Must / Should / Nice to have); the due date raises the urgency
when a list is read (`src/shared/ppm-tasks-urgency.ts`): overdue or due today → Now, due tomorrow →
Today, due within six days → This week. It only raises, never lowers, and nothing is stored, so
history carries no "raised by date" noise. "What to do first" (`src/shared/ppm-tasks-order.ts`)
sorts by effective urgency, then importance, then a manual `rank` inside the cell (project + stored
urgency + importance), set by drag or by the AI; changing urgency or importance moves the task to
the end of its new cell.

**History and undo.** Each history row records the actor (`user` "You", `manager` "Manager
<project>", `assistant`, `chat` with the chat's title, `ppm`), the channel (`ppm`, `telegram`,
`tool`, `api`), the changes field by field, an optional reason, and `unattended` for a write made in
a PPM Assistant turn nobody was watching ([PPM Assistant → Tasks](ppm-assistant.md#tasks)). A row
with no task is a project-settings event (statuses, members, fields, the switch) and is never
undoable. Undo (`ppm-tasks-history.ts`) takes only AI changes (manager, Assistant, chat), within 90
days, and only while every field the change touched still holds what it wrote — a field changed
since means someone acted on it, and undo would silently discard that. Undoing an AI creation
soft-deletes the task, only while nothing else has changed it. References an undo would put back
(status, parent, members, working session) are checked again.

**Compaction.** One minute after start and then daily (`ppm-tasks-compaction.ts`), history older
than 90 days is deleted except the key events: created, status moves, closed and reopened. A key
event that was undone goes as well once its undo is past the window, so no half pair is left showing
a status move that did not stick.

**The per-project switch** (`ppm-tasks-projects.service.ts`, table `task_projects`). Off by default.
It turns on by itself when a project gets a manager chat (`enableOnManagerAssigned`, called from
`manager-chats.service.ts`), and the migration turned it on for every project that already had one
(`enabled_by = migration`). Off hides the project's tasks from lists, tools and Telegram and deletes
nothing; the settings routes still answer for it, which is where it is switched back on. The same
row holds the project's check interval for handed-off work (`check_interval_min`, 30 by default,
5–240) and how far its manager chat has been told about changes.

**Live link states** (`link-state/`, cache table `task_link_state`). Jira keys are read with the
task's own project's Jira config only, PRs through the `gh` CLI (without it, or signed out, every PR
reads "gh not available"), chats live from the chat layer and never cached. A read never waits on
the network: it answers from the cache and queues anything missing or older than two minutes; open
tasks' Jira and PR links in switched-on projects are refreshed every 15 minutes. Nothing here changes a task: what
changed outside is news for the manager chat to act on.

**Where a link opens** (`src/shared/ppm-task-link-href.ts`, used by the Links card and the Telegram
`/tasks` card alike). A Jira key opens at `<site>/browse/<KEY>`, the site being the project's Jira
config base URL (`jiraSiteFor`, sent as `jiraSite` with a task's detail; no credentials are read),
a PR on GitHub, a URL as stored; only `http:`/`https:` ever reaches an `href`. A Jira key whose
project has no Jira config cannot open and its chip says "no Jira site". A web chip is an
`<a target=_blank rel="noopener noreferrer">`, never `window.open`, so no popup blocker stands in
the way; a chat chip opens inside PPM. On Telegram a line becomes a link only for a public https
address (`isPublicHttpsUrl`), so a self-hosted Jira on an intranet name stays plain text.

**Events.** `src/server/ws/ppm-tasks-broadcast.ts` sends `tasks:changed` (task ids),
`tasks:project_changed` and `tasks:link_states` on `/ws/global`, ids only, gathered per project for
100 ms so an AI editing twenty tasks sends one push; each view re-reads what it shows.

---

## Browser cache layer

The chat startup path (see [New chat preparation](ai-chat-and-providers.md#new-chat-preparation))
is backed by two browser-side stores, both wiped together and both project-scoped by a
`projectCacheId` — an FNV-1a hash of a project's name **and** path
(`src/web/lib/browser-cache/cache-keys.ts`), so a rename orphans the old key instead of
colliding and a reused name does not inherit a predecessor's cache.

**localStorage**: a global `ppm-chat-pref` key (`chat-preference-local-cache.ts`) holds
only the default provider, the new-chat provider mode, and each provider's permission
mode — never account ids, labels or credentials. A per-project `ppm-chat-providers:<projectCacheId>`
key holds that project's cached provider list. Both are shape-validated on read, so a
stale or hand-edited value is dropped rather than trusted.

**IndexedDB**: one database (`ppm-cache`), one store (`kv`), a fixed schema version
(`src/web/lib/browser-cache/idb-keyval-cache.ts`). Every value is wrapped in an envelope
`{v, at, data}`; a version mismatch reads as a miss rather than a mis-parse, so the
database itself never needs a migration. Falls back to an in-memory `Map` whenever
IndexedDB is unavailable (module scope under `bun:test`, private browsing, a blocked
open) or a call to it fails — every export is async and never throws. It holds, per
project: cached slash-command items per provider, the session list's first page (50
sessions) and tags.

**Hydration**: a registry of per-project hydrators
(`src/web/lib/browser-cache/project-cache-hydration.ts`) runs once per `projectCacheId`,
deduped so switching back to an already-warm project is a no-op read. App boot hydrates
the last-active project (`ppm-last-project-ref`, a small pointer written on every real
hydration) before `fetchProjects()` even resolves, so the UI can paint from cache before
the network answers; `switchProject` hydrates every project it activates.

**Wipe**: every token drop — a 401 response or a failed login — wipes the whole layer
(`wipe-browser-caches.ts`): the localStorage keys above, every registered in-memory
cache, then IndexedDB, in that order so synchronous parts are gone before the async
`idbClearAll()` finishes. A password change does not wipe anything, since the current
session's token stays valid. A project rename or delete evicts only that project's
entries (`evictProjectCache` in `project-store.ts`): its IndexedDB prefix, its
localStorage provider list, and its hydration dedupe entry — nothing else addresses that
`name + path` combination again.

## MCP Server Management

### Overview
MCP (Model Context Protocol) servers extend Claude with custom tools and resources. PPM manages MCP server configurations via Settings UI, storing them in SQLite and passing them to the Claude Agent SDK.

**Features:**
- **Add/Edit/Delete** MCP servers via Settings UI
- **Auto-import** from `~/.claude.json` on first access (convenience, no forced import)
- **Three transport types:** stdio, HTTP, SSE
- **Validation** on name and config before storage
- **SDK integration:** Servers passed to `query()` as `mcpServers` object, tools auto-allowed via `mcp__*` wildcard

### Storage Schema

```sql
CREATE TABLE mcp_servers (
  name TEXT PRIMARY KEY,
  transport TEXT NOT NULL DEFAULT 'stdio',  -- 'stdio' | 'http' | 'sse'
  config TEXT NOT NULL,                     -- JSON: McpServerConfig
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Config Format (JSON):**
```json
{
  "type": "stdio",
  "command": "path/to/server",
  "args": ["--flag"],
  "env": { "VAR": "value" }
}
```

Or HTTP/SSE:
```json
{
  "type": "http",
  "url": "http://localhost:3000",
  "headers": { "Authorization": "Bearer token" }
}
```

### REST API

**Endpoints** (`src/server/routes/mcp.ts`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| **GET** | `/api/settings/mcp` | List all servers; auto-import on first access |
| **GET** | `/api/settings/mcp/:name` | Get single server config |
| **POST** | `/api/settings/mcp` | Add new server (validates name + config) |
| **PUT** | `/api/settings/mcp/:name` | Update existing server |
| **DELETE** | `/api/settings/mcp/:name` | Remove server |
| **GET** | `/api/settings/mcp/import/preview` | Preview servers in `~/.claude.json` |
| **POST** | `/api/settings/mcp/import` | Bulk import from `~/.claude.json` |

**Add Server Example:**
```bash
POST /api/settings/mcp
Content-Type: application/json

{
  "name": "file-server",
  "config": {
    "type": "stdio",
    "command": "/usr/local/bin/file-server",
    "args": ["--port", "8000"]
  }
}
```

### Service Layer

**McpConfigService** (`src/services/mcp-config.service.ts`):
- `list()` — Record<name, McpServerConfig> (SDK-compatible format)
- `listWithMeta()` — Array with metadata (for UI)
- `get(name)` — Single server config
- `set(name, config)` — Add or update (upsert)
- `remove(name)` — Delete server
- `exists(name)` — Check if name exists
- `bulkImport(servers)` — Transactional import from `~/.claude.json`, skips existing/invalid

**Validation:**
- `validateMcpName(name)` — alphanumeric + hyphens/underscores, max 50 chars
- `validateMcpConfig(config)` — type-specific checks (command for stdio, url for http/sse)

### Frontend Integration

**UI Components:**
- `MCP Settings Section` (`src/web/components/settings/mcp-settings-section.tsx`) — Tab in Settings UI
- `MCP Server Dialog` (`src/web/components/settings/mcp-server-dialog.tsx`) — Add/Edit modal
- `API client` (`src/web/lib/api-mcp.ts`) — Fetch/mutate operations

**Workflow:**
1. User opens Settings → MCP tab
2. **GET** `/api/settings/mcp` (auto-imports on first access)
3. Display list with transport badge + actions (edit, delete)
4. Click "Add" → Dialog with name + transport selector + config fields
5. **POST** to `/api/settings/mcp` or **PUT** to update
6. On success, list refreshes

### SDK Integration

**Claude Agent SDK Provider** (`src/providers/claude-agent-sdk.ts`):
```typescript
// Line ~574
const mcpServers = mcpConfigService.list();
const hasMcp = Object.keys(mcpServers).length > 0;

// Line ~589: Pass to query() if servers exist
const mcpTools = ["mcp__*"];
const queryConfig = {
  // ... other options
  ...(hasMcp && { mcpServers }),
  allowedTools: [...otherTools, ...mcpTools],
};

const query = new Query(messages, queryConfig);
```
