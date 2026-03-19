# Phase 2: Backend — Table Cache + API Routes

## Priority: High | Effort: M | Status: Complete
## Depends on: Phase 1 ✓

## Overview
Create unified DB API routes that use the adapter registry, and implement table list caching in PPM's internal SQLite for fast command palette search.

## Key Insights
- Current routes are split: `/api/project/:name/sqlite/...` (GET, project-scoped) vs `/api/postgres/...` (POST, global)
- New unified routes: `/api/db/:connectionId/...` — connection ID-based, no project scope needed
- Table cache lives in PPM internal db — synced on user refresh, read by command palette

## Related Code Files

### Create
- `src/server/routes/database.ts` — unified DB routes using adapter registry
- `src/services/table-cache.service.ts` — cache read/write/sync logic

### Modify
- `src/server/index.ts` — mount new `/api/db` routes
- `src/services/connection.service.ts` — add `getConnectionWithAdapter()` helper

## API Design

```
POST /api/db/connections              — create connection
GET  /api/db/connections              — list all connections
GET  /api/db/connections/:id          — get single connection
PUT  /api/db/connections/:id          — update connection
DELETE /api/db/connections/:id        — delete connection

POST /api/db/connections/:id/test     — test connection
GET  /api/db/connections/:id/tables   — list tables (+ sync cache)
GET  /api/db/connections/:id/schema?table=...&schema=...   — table schema
GET  /api/db/connections/:id/data?table=...&page=1&limit=100  — paginated rows
POST /api/db/connections/:id/query    — execute SQL
PUT  /api/db/connections/:id/cell     — update cell

GET  /api/db/search?q=...            — search cached tables across all connections
```

## Table Cache Service

```typescript
// src/services/table-cache.service.ts
class TableCacheService {
  /** Get cached tables for a connection */
  getCachedTables(connectionId: number): CachedTable[]

  /** Sync: fetch live tables via adapter, update cache */
  async syncTables(connectionId: number): Promise<CachedTable[]>

  /** Search across all connections (for command palette) */
  searchTables(query: string): SearchResult[]
  // SearchResult = { connectionId, connectionName, connectionColor, tableName, schemaName }
}
```

## Implementation Steps

1. Create `src/services/table-cache.service.ts`:
   - `getCachedTables(connectionId)` — read from `connection_table_cache`
   - `syncTables(connectionId)` — call adapter.getTables(), upsert cache, delete stale
   - `searchTables(query)` — `SELECT ... FROM connection_table_cache JOIN connections WHERE table_name LIKE ?`
2. Create `src/server/routes/database.ts`:
   - Connection CRUD endpoints
   - `/connections/:id/test` — resolve adapter by connection type, call testConnection
   - `/connections/:id/tables` — call syncTables (refreshes cache), return result
   - `/connections/:id/schema`, `/data`, `/query`, `/cell` — delegate to adapter
   - `/search?q=` — call searchTables
3. Mount in `src/server/index.ts`: `app.route("/api/db", databaseRoutes)`
4. Compile check

<!-- Updated: Validation Session 1 - readonly enforcement in PUT /cell + readonly in PUT /connections/:id -->
## Readonly Enforcement in API
- `PUT /api/db/connections/:id/cell` → check `conn.readonly`, return 403 if true
- `PUT /api/db/connections/:id` → expose `readonly` field (writable from UI, not CLI)
- `POST /api/db/connections/:id/query` → check `readonly` + `isReadOnlyQuery()`, block writes

## Todo
- [x] Create table-cache.service.ts
- [x] Create unified database routes
- [x] Add readonly enforcement in `/cell` and `/query` endpoints
- [x] Mount routes in server index
- [x] Compile check

## Completion Summary

**Delivered files:**
- `src/server/routes/database.ts` — Complete CRUD + table/schema/data/query/cell/search endpoints with readonly enforcement
- `src/services/table-cache.service.ts` — Cache sync, read, and cross-connection search
- `src/services/db.service.ts` — Extended with connection CRUD helpers

**Endpoints implemented:**
- POST/GET/PUT/DELETE `/api/db/connections` — Full CRUD
- POST `/api/db/connections/:id/test` — Connection testing
- GET `/api/db/connections/:id/tables` — List + sync cache
- GET `/api/db/connections/:id/schema` — Table schema
- GET `/api/db/connections/:id/data` — Paginated data
- POST `/api/db/connections/:id/query` — SQL execution (readonly enforced)
- PUT `/api/db/connections/:id/cell` — Cell updates (readonly enforced)
- GET `/api/db/search` — Cross-connection table search

**Code review fixes applied:**
- CRIT-1: sanitizeConn helper strips connection_config from all responses
- HIGH-1: Shared readonly-check.ts with CTE support
- HIGH-2: SQLQueryBindings[] cast instead of `as any`
- MED-4: Hex color validation in POST/PUT routes
- MED-5: LIKE wildcards escaped in search

## Success Criteria
- ✓ All CRUD operations work via `/api/db/connections/...`
- ✓ Table cache populated on first load, refreshed on demand
- ✓ Search endpoint returns results across all saved connections
- ✓ Old sqlite/postgres routes still work (no breaking change)
