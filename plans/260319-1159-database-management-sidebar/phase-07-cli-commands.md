# Phase 7: CLI — Database Connection Management & SQL Execution

## Priority: High | Effort: M | Status: Complete
## Depends on: Phase 1 ✓ (connections table + CRUD helpers)

## Overview
Full CLI command set under `ppm db` for managing saved database connections and executing SQL queries directly from the terminal. Includes **readonly protection** per connection — critical because AI agents can use CLI to execute arbitrary SQL.

## Key Insights
- PPM CLI uses Commander.js with grouped command pattern (`registerXxxCommands(program)`)
- Existing patterns: `projects.ts`, `config-cmd.ts`, `git-cmd.ts`, `chat-cmd.ts`
- Commands should use lazy imports and ANSI-colored table output (matching existing style)
- Connections resolved by name OR numeric ID for convenience
- Phase 1 provides `connections` table (migration v2) + CRUD helpers in `db.service.ts`
- **Security**: AI agents (Claude Agent SDK) can invoke `ppm db query` — readonly flag prevents accidental writes to production databases

## Readonly Protection

### Design
- `readonly` column in `connections` table (INTEGER 0/1, default 1 = readonly by default for safety)
- **UI-only toggle**: readonly can ONLY be changed via web UI (Phase 3 sidebar), NOT via CLI
- CLI has NO flags to set/change readonly — AI cannot bypass this protection
- New connections default to `readonly=1` — user must explicitly unlock via UI
- Enforced at **service dispatch level** in CLI and API routes — before SQL reaches the DB engine
- Detection: block any SQL statement that is NOT `SELECT`, `EXPLAIN`, `SHOW`, `PRAGMA`, `DESCRIBE`, `WITH ... SELECT`
- Applies to: `ppm db query` command + `ppm db data` (updateCell) + unified API routes (Phase 2)
- Does NOT apply to: `ppm db tables`, `ppm db schema`, `ppm db data` read operations (inherently read-only)

### Enforcement Logic
```typescript
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return /^(SELECT|EXPLAIN|SHOW|PRAGMA|DESCRIBE|WITH\b)/i.test(trimmed);
}

// In db query command:
if (conn.readonly && !isReadOnlyQuery(sql)) {
  console.error("Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.");
  process.exit(1);
}
```

### Where readonly is toggled
- **Web UI only**: Phase 3 sidebar connection manager → toggle switch per connection
- **API route**: `PUT /api/db/connections/:id` (called by web UI, not exposed in CLI)
- **CLI cannot change readonly** — no `--readonly` / `--no-readonly` flags anywhere

## CLI Commands

### Connection Management
| Command | Description | Key Flags |
|---------|-------------|-----------|
| `ppm db list` | List all saved connections | — |
| `ppm db add` | Add a new connection | `--name`, `--type`, `--connection-string` / `--file`, `--group`, `--color` |
| `ppm db remove <name>` | Remove connection by name/ID | — |
| `ppm db test <name>` | Test connectivity | — |

### Data Operations
| Command | Description | Key Flags |
|---------|-------------|-----------|
| `ppm db tables <name>` | List tables | — |
| `ppm db schema <name> <table>` | Show table columns/types | `--schema` (PG) |
| `ppm db data <name> <table>` | View table data (paginated) | `--page`, `--limit`, `--order`, `--desc`, `--schema` |
| `ppm db query <name> <sql>` | Execute raw SQL (respects readonly) | — |

## Related Code Files

### Create
- `src/cli/commands/db-cmd.ts` — all `ppm db` subcommands

### Modify
- `src/index.ts` — register `registerDbCommands(program)`
- `src/services/db.service.ts` — migration v2 + connection CRUD helpers + `readonly` column

## Implementation Steps

1. **Migration v2** in `db.service.ts`: add `connections` table with `readonly INTEGER NOT NULL DEFAULT 1`
2. **Connection CRUD helpers** in `db.service.ts`: `getConnections`, `resolveConnection`, `insertConnection`, `deleteConnection` — NO `updateConnection` for readonly in CLI
3. **Create `db-cmd.ts`**:
   - `printTable` + `formatRows` helpers (ANSI colored output)
   - `parseConfig` — parse `connection_config` JSON from DB row
   - `isReadOnlyQuery()` — SQL statement classification for readonly enforcement
   - `db list` — fetch all connections, show readonly status with lock icon
   - `db add` — validate flags, insert into DB (always readonly=1 by default)
   - `db remove` — resolve + delete
   - `db test` — PG: `testConnection()`, SQLite: `existsSync` + open
   - `db tables` — dispatch to sqlite/postgres service
   - `db schema` — dispatch to sqlite/postgres service
   - `db data` — paginated table data with sorting
   - `db query` — **enforce readonly** before dispatch, then execute SQL
4. **Register** in `index.ts`: `registerDbCommands(program)`
5. **Compile check**

<!-- Updated: Validation Session 1 - mask password in list, readonly DEFAULT 1, no --readonly flag -->
## Usage Examples

```bash
# Add connections (all default to readonly=1, unlock via web UI)
ppm db add -n nxsys-prod -t postgres -c "postgresql://postgres:***@172.30.0.11:5432/prod"
ppm db add -n nxsys-dev -t postgres -c "postgresql://..."
ppm db add -n local-ppm -t sqlite -f ~/.ppm/ppm.db -g internal

# List — password masked in output
ppm db list
#  ID | Name       | Type     | Group    | RO | Connection
#   1 | nxsys-prod | postgres | -        | RO | postgresql://postgres:***@172.30.0.11:5432/prod
#   2 | nxsys-dev  | postgres | -        | RO | postgresql://postgres:***@host:5432/dev
#   3 | local-ppm  | sqlite   | internal | RO | ~/.ppm/ppm.db
# → User unlocks nxsys-dev via web UI toggle (RO disappears from list)

# Query (readonly blocks writes, no CLI way to disable)
ppm db query nxsys-prod "SELECT count(*) FROM users"           # OK
ppm db query nxsys-prod "DELETE FROM users WHERE id = 1"       # Blocked: readonly
ppm db query nxsys-dev "DELETE FROM temp_data WHERE expired=1" # OK (user unlocked via UI)
```

## Todo
- [x] Add `readonly` column (default 1) to connections migration in db.service.ts
- [x] Connection CRUD helpers (no readonly toggle in CLI)
- [x] Create db-cmd.ts with all subcommands + readonly enforcement
- [x] Register in index.ts
- [x] Compile check

## Success Criteria
- All 8 commands work end-to-end for both SQLite and PostgreSQL
- **Readonly enforcement blocks non-SELECT queries** on protected connections
- **No CLI flag exists to change readonly** — only web UI can toggle
- New connections default to readonly=1 (safe by default)
- Resolve by name or numeric ID
- Pretty ANSI table output in terminal with readonly indicator
- Proper error messages: readonly violation tells user to change via web UI

## Completion Summary

**Delivered files:**
- `src/cli/commands/db-cmd.ts` — All 8 subcommands with full functionality

**Implemented commands:**
- `ppm db list` — Shows all connections with readonly status (password masked)
- `ppm db add` — Create connection (always defaults readonly=1)
- `ppm db remove` — Delete connection by name/ID
- `ppm db test` — Test connectivity
- `ppm db tables` — List tables with row counts
- `ppm db schema` — Show column definitions
- `ppm db data` — Paginated table view with sorting
- `ppm db query` — Execute SQL with readonly enforcement

**Security features:**
- Readonly enforcement blocks non-SELECT queries on protected connections
- No CLI flag to change readonly (only web UI)
- Default readonly=1 on new connections (safe by default)
- Password masking in list output
- Error messages direct users to web UI for readonly toggle

**Code review fixes applied:**
- Password masking in `ppm db list`
- CTE-safe readonly detection in isReadOnlyQuery()
- Full ANSI table output with proper formatting

## Security Considerations
- ✓ Readonly is a **UI-only toggle** — CLI/AI cannot disable it
- ✓ Default `readonly=1` ensures new connections are safe until user explicitly unlocks
- ✓ Enforced both in CLI (`ppm db query`) and API routes (Phase 2)
- ✓ Connection strings may contain credentials — `ppm db list` truncates display
- ✓ Error message on readonly violation directs user to web UI, not CLI workaround
