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
| **SystemMetricsService** (`src/services/system-metrics/`) | Whole-machine Task Manager backend: CPU per core + RAM via `node:os`, disk/net/GPU + all processes via per-OS collectors (Linux `/proc`, macOS `ps`, Windows one long-lived PowerShell REPL child, `Win32_Process` + `PerfRawData` per 2 s tick), delta-based CPU%, grouping by app root, aggregate-only 30-min history. Two SSE tiers on `/api/system/resources/stream`: `light` (status bar, no children spawned) and `full` (`?processes=1`, demand-gated collectors, 60 s teardown). Subscriber lease (sid + 10 s ping, 30 s expiry) because Cloudflare tunnel never propagates client disconnects. Guarded `POST /resources/kill`: protected set (PPM server/supervisor/edge/cloudflared, OS-critical names), ancestor/tree-intersection rule, `startedAt` identity re-query → 409, JSON + `X-PPM-Request` header. | subscribe, unsubscribe, ping, getLatest, kill, reapExpired |

**Key Files:** `src/services/*.service.ts`, `src/services/tag.service.ts`, `src/services/ppmbot/*.ts`, `src/services/bash-output-spy.ts`, `src/services/system-metrics/system-metrics.service.ts`, `src/services/system-metrics/kill-guard.ts`, `src/services/system-metrics/powershell-session.ts`, `src/services/redact-secrets.ts`, `src/services/file-filter.service.ts`, `src/cli/commands/bot-cmd.ts`

---

## Database Management (v2.0+)

### Architecture Overview

PPM now supports managing external databases (SQLite & PostgreSQL) through a unified adapter pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Web UI (React)                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Database Sidebar                                         │   │
│  │ • Connection List (with color badges)                    │   │
│  │ • Create/Edit Connection Form                            │   │
│  │ • Color Picker (WCAG contrast-aware)                     │   │
│  │ • Query Execution UI                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────┬───────────────────────────────────────────────┘
                  │ HTTP REST / WebSocket
┌─────────────────┴───────────────────────────────────────────────┐
│                    PPM Server (Hono)                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ /api/db Routes                                           │   │
│  │ • GET  /connections        → List all connections        │   │
│  │ • POST /connections        → Create connection           │   │
│  │ • GET  /connections/:id    → Get connection (sanitized)  │   │
│  │ • PUT  /connections/:id    → Update (readonly toggle)    │   │
│  │ • DELETE /connections/:id  → Remove connection           │   │
│  │ • GET  /connections/:id/tables      → List + sync tables │   │
│  │ • GET  /connections/:id/tables/:tbl → Schema + data      │   │
│  │ • POST /connections/:id/query       → Execute query      │   │
│  │ • PATCH /connections/:id/cell       → Update cell        │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Service Layer                                            │   │
│  │ • DbService (connection CRUD, caching)                   │   │
│  │ • TableCacheService (metadata cache, search)             │   │
│  │ • DatabaseAdapterRegistry (extensible)                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Adapters (Pluggable Pattern)                             │   │
│  │ • SQLiteAdapter → Uses `bun:sqlite` for local files      │   │
│  │ • PostgresAdapter → Uses postgres driver for servers     │   │
│  │ • isReadOnlyQuery() → Safety check (CTE-safe regex)      │   │
│  │ • readonly=1 by default (safe-by-default)               │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
        ↓↑
   ┌────────────────────────────────────────────┐
   │  External Databases                         │
   │  • SQLite files (path: /path/to/db.db)      │
   │  • PostgreSQL servers (connStr: postgres://)│
   └────────────────────────────────────────────┘
```

### DatabaseAdapter Pattern (Extensible)

**Interface** (`src/types/database.ts`):
```typescript
interface DatabaseAdapter {
  testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }>;
  getTables(config: DbConnectionConfig): Promise<DbTableInfo[]>;
  getTableSchema(config: DbConnectionConfig, table: string, schema?: string): Promise<DbColumnInfo[]>;
  getTableData(config: DbConnectionConfig, table: string, opts: {...}): Promise<DbPagedData>;
  executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult>;
  updateCell(config: DbConnectionConfig, table: string, opts: {...}): Promise<void>;
}
```

**Implementations:**
1. **SQLiteAdapter** — Local file-based SQLite via `bun:sqlite`
   - testConnection: Opens file, runs pragma check
   - Supports: SELECT, INSERT, UPDATE, DELETE (if writable), CREATE TABLE

2. **PostgresAdapter** — Remote PostgreSQL servers via postgres driver
   - testConnection: Attempts connection with credentials
   - Supports: Full SQL except DDL on readonly connections

**Registry Pattern** (`src/services/database/adapter-registry.ts`):
```typescript
registerAdapter("sqlite", new SQLiteAdapter());
registerAdapter("postgres", new PostgresAdapter());
// Can be extended: registerAdapter("mysql", new MysqlAdapter());
```

### Security Design

**Readonly by Default:**
- All connections created with `readonly = true` in database
- Default: read-only query execution (safe-by-default)
- Web UI toggle: Switch to writable (admin decision only)
- CLI: Cannot disable readonly via command-line (browser only)

**Readonly Query Detection:**
```typescript
// isReadOnlyQuery() in src/services/database/readonly-check.ts
// Checks for: SELECT, PRAGMA, EXPLAIN, WITH (CTE)
// Rejects: INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, etc.
// CTE-safe: Handles "WITH AS SELECT" (wraps CTE result check)
```

**Credential Handling:**
- Connection credentials stored in SQLite `connections` table as `connection_config` JSON
- **NEVER** returned in API responses (stripped by `sanitizeConn()` in routes)
- Only used internally by adapters when executing queries
- Frontend never sees passwords/connection strings

**API Security:**
- All `/api/db` requests require valid auth token (middleware checked)
- Connection IDs are numeric (no enumeration risk)
- Connection color is user-specific (cosmetic only, not sensitive)

### Data Flow: Query Execution

```
User opens Database tab
    ↓
DatabaseSidebar fetches: GET /api/db/connections
    ↓
ConnectionList displays (sanitized, no credentials)
    ↓
User clicks connection → GET /api/db/connections/:id/tables
    ↓
DbService.getConnections() reads from SQLite
    ↓
TableCacheService.syncTables() calls adapter.getTables()
    ↓
SQLiteAdapter/PostgresAdapter queries database
    ↓
Results cached in table_metadata table
    ↓
UI displays table list + schema
    ↓
User selects table → GET /api/db/connections/:id/tables/:table
    ↓
Adapter.getTableData() executes paginated query
    ↓
Results returned: { columns, rows, total, page, limit }
    ↓
UI renders table grid with pagination
    ↓
User executes custom query → POST /api/db/connections/:id/query
    ↓
isReadOnlyQuery() checks SQL (rejects writes if readonly=true)
    ↓
Adapter.executeQuery() runs SQL
    ↓
Results returned: { columns, rows, rowsAffected, changeType }
    ↓
UI displays results (read-only highlight if mutation was blocked)
```

### Connection Storage

**SQLite Schema** (in `~/.ppm/ppm.db`):
```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 0, -- 1 = active, 0 = inactive
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- 'sqlite' | 'postgres'
  name TEXT NOT NULL,
  connection_config TEXT NOT NULL, -- JSON: { path, connectionString, ... }
  readonly INTEGER DEFAULT 1, -- 1 = readonly, 0 = writable (UI-only toggle)
  group_name TEXT,
  color TEXT, -- Optional hex color (#3b82f6)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE table_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  schema_name TEXT DEFAULT 'public',
  row_count INTEGER,
  last_synced TEXT,
  UNIQUE(connection_id, table_name, schema_name)
);
```

### CLI Support (ppm db)

**Commands** (`src/cli/commands/db-cmd.ts`):
```bash
ppm db connections           # List all connections
ppm db connect               # Add new connection (interactive)
ppm db remove <name>         # Delete connection
ppm db query <name> <sql>    # Execute query (respects readonly)
ppm db run <name> <file>     # Execute SQL file (multi-statement, transactions)
ppm db tables <name>         # List tables
ppm db schema <name> <table> # Show table schema
ppm db data <name> <table>   # Show table data (paginated)
```

**CLI Safety:**
- Always respects readonly flag (cannot override via CLI)
- Uses same adapter/validation as web UI
- Table formatting for terminal output

---

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
