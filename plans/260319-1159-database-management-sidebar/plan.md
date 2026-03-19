# Database Management Sidebar

## Overview
Add a sidebar tab to manage saved database connections (SQLite + PostgreSQL), with cached table lists, custom tab colors, and a generic backend adapter for future DB types.

## Status: Complete

## Validation Log

### Session 1 — 2026-03-19
**Trigger:** User requested plan validation before implementation
**Questions asked:** 6

#### Questions & Answers

1. **[Assumptions]** Readonly default — khi thêm connection mới (cả qua CLI lẫn UI), giá trị mặc định là gì?
   - Options: readonly = ON | readonly = OFF
   - **Answer:** readonly = ON (DEFAULT 1)
   - **Rationale:** Safe-by-default. AI dùng CLI không thể write vào DB mới thêm cho đến khi user mở khóa qua UI.

2. **[Scope]** Readonly scope — block ở đâu ngoài `ppm db query` và API routes?
   - Options: Cell editing trong viewer tab | PUT /api/db/.../cell | Chỉ block ppm db query
   - **Answer:** Block tất cả — cả 3 điểm enforce
   - **Rationale:** Full enforcement: CLI query + `PUT /api/db/.../cell` API + inline cell edit UI đều bị disable khi readonly=1.

3. **[Architecture]** Generic DatabaseAdapter — cần refactor không?
   - Options: Cần build full adapter | Skip, gọi service trực tiếp
   - **Answer:** Cần — build full adapter
   - **Rationale:** Foundation cho extensibility (MySQL, v.v.). Phase 1 bắt buộc.

4. **[Scope]** connection_table_cache — thêm ngay vào migration v2 hay defer?
   - Options: Thêm ngay | Defer sang Phase 5
   - **Answer:** Thêm ngay vào migration v2
   - **Rationale:** Migration chỉ chạy một lần, tránh cần migration v3 sau.

5. **[Architecture]** Implementation order — bắt đầu từ phase nào?
   - Options: Phase 1 trước | Phase 7 CLI trước
   - **Answer:** Phase 1 trước
   - **Rationale:** Đúng dependency order. Phase 7 CLI dùng adapter, không gọi service trực tiếp.

6. **[Assumptions]** Credential display trong `ppm db list` — xử lý thế nào?
   - Options: Mask password | Chỉ hiện host+db | Truncate bình thường
   - **Answer:** Mask password trong URL — `postgresql://user:***@host:5432/db`
   - **Rationale:** Balance giữa readability và security.

#### Confirmed Decisions
- **readonly DEFAULT 1** — safe by default, UI-only toggle
- **Full readonly enforcement** — CLI + API endpoint + UI cell edit đều bị block
- **Full adapter pattern** — Phase 1 bắt buộc trước Phase 7
- **connection_table_cache in migration v2** — không tách sang migration v3
- **Phase order: 1 → 2 → 3/7 parallel → 4/5/6** — Phase 7 sau Phase 1
- **Mask password** — `postgresql://user:***@host:5432/db` trong `ppm db list`

#### Action Items
- [ ] Fix migration v2: thêm `readonly INTEGER NOT NULL DEFAULT 1` + `connection_table_cache` table
- [ ] Fix `ConnectionRow` interface: thêm `readonly` field
- [ ] Phase 7 CLI: `ppm db list` mask password, không có `--readonly` flag
- [ ] Phase 2 API: `PUT /api/db/connections/:id` cho phép toggle readonly (từ UI)
- [ ] Phase 3 UI: readonly toggle trong connection form + disable cell edit khi readonly=1

#### Impact on Phases
- Phase 1: Thêm `readonly + connection_table_cache` vào migration, fix `ConnectionRow` type
- Phase 2: `PUT /api/db/connections/:id` expose `readonly` field (UI-writable). `PUT /cell` enforce readonly.
- Phase 3: Connection form có readonly toggle (UI-only). Viewer tab disable cell edit khi readonly=1.
- Phase 7: Mask password trong `ppm db list`. Không có `--readonly` CLI flag.

## Phases

| # | Phase | Status | Priority | Effort |
|---|-------|--------|----------|--------|
| 1 | [Backend: Generic DB adapter + connection storage](phase-01-backend-generic-adapter.md) | Complete | High | M |
| 2 | [Backend: Table cache + API routes](phase-02-backend-cache-api.md) | Complete | High | M |
| 3 | [Frontend: Sidebar database tab + connection manager](phase-03-frontend-sidebar.md) | Complete | High | L |
| 4 | [Frontend: Tab styling (colors, contrast)](phase-04-frontend-tab-colors.md) | Complete | Medium | S |
| 5 | [Frontend: Command palette DB table search](phase-05-command-palette-integration.md) | Complete | Medium | S |
| 6 | [Refactor: Migrate existing sqlite/postgres viewers](phase-06-refactor-existing-viewers.md) | Complete | Medium | M |
| 7 | [CLI: Database connection management & SQL execution](phase-07-cli-commands.md) | Complete | High | M |

## Key Dependencies
- Phase 2 depends on Phase 1
- Phase 3 depends on Phase 2
- Phase 4 depends on Phase 3
- Phase 5 depends on Phase 2 + 3
- Phase 6 depends on Phase 1
- Phase 7 depends on Phase 1

## Completion Notes

**Completed**: All 7 phases delivered successfully. Feature includes:
- Unified DatabaseAdapter interface for multiple DB types (SQLite, PostgreSQL)
- Full CRUD APIs for managing connections (`/api/db/connections/*`)
- Database sidebar with connection grouping, colors, and table caching
- Tab colors with automatic contrast detection
- Command palette integration for cross-connection table search
- Existing viewers refactored to support unified API while maintaining backward compatibility
- Full CLI support with readonly enforcement and security protection
- All code reviews and fixes applied
- **Docs impact**: Major — new feature requires documentation updates in docs/

## Architecture Decision: Generic DB Adapter

```
┌──────────────────────────────────────────────┐
│              DatabaseAdapter (interface)       │
│  getTables / getSchema / getData / execQuery  │
├──────────────┬───────────────┬────────────────┤
│ SqliteAdapter│ PostgresAdapter│ Future: MySQL  │
└──────┬───────┴───────┬───────┴────────────────┘
       │               │
┌──────┴───────┐ ┌─────┴────────┐
│ bun:sqlite   │ │ postgres pkg │
└──────────────┘ └──────────────┘
```

## Data Model

```sql
-- connections table (in PPM internal db)
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'sqlite' | 'postgres'
  name TEXT NOT NULL UNIQUE,
  connection_config TEXT NOT NULL, -- JSON: {path, connectionString, ...}
  group_name TEXT,
  color TEXT,                    -- hex color or null
  readonly INTEGER NOT NULL DEFAULT 1, -- 1 = block non-SELECT queries (protects prod DBs from AI). UI-only toggle.
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- connection_table_cache (in PPM internal db)
CREATE TABLE connection_table_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  schema_name TEXT DEFAULT 'public',
  row_count INTEGER DEFAULT 0,
  cached_at TEXT DEFAULT (datetime('now')),
  UNIQUE(connection_id, schema_name, table_name)
);
```
