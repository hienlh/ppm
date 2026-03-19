# Phase 1: Backend — Generic DB Adapter + Connection Storage

## Priority: High | Effort: M | Status: Complete

## Overview
Create a generic `DatabaseAdapter` interface, refactor existing sqlite/postgres services to implement it, and add connection CRUD storage in PPM's internal SQLite db.

## Key Insights
- Current sqlite.service.ts and postgres.service.ts have similar method shapes but different signatures (sync vs async, path vs connectionString)
- PPM internal db (`db.service.ts`) uses migration pattern — we add migration v2 for new tables
- Connection config varies by type — use JSON column for flexible config storage

## Architecture

### DatabaseAdapter Interface
```typescript
// src/types/database.ts
export type DbType = "sqlite" | "postgres";

export interface DbConnectionConfig {
  type: DbType;
  // sqlite: { path: string; projectPath?: string }
  // postgres: { connectionString: string }
  [key: string]: unknown;
}

export interface DbTableInfo {
  name: string;
  schema?: string;   // postgres only
  rowCount: number;
}

export interface DbColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
}

export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
}

export interface DbPagedData {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
}

export interface DatabaseAdapter {
  testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }>;
  getTables(config: DbConnectionConfig): Promise<DbTableInfo[]>;
  getTableSchema(config: DbConnectionConfig, table: string, schema?: string): Promise<DbColumnInfo[]>;
  getTableData(config: DbConnectionConfig, table: string, opts: {
    schema?: string; page?: number; limit?: number; orderBy?: string; orderDir?: "ASC" | "DESC";
  }): Promise<DbPagedData>;
  executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult>;
  updateCell(config: DbConnectionConfig, table: string, opts: {
    schema?: string; pkColumn: string; pkValue: unknown; column: string; value: unknown;
  }): Promise<void>;
}
```

### Adapter Registry
```typescript
// src/services/database/adapter-registry.ts
const adapters = new Map<DbType, DatabaseAdapter>();
export function registerAdapter(type: DbType, adapter: DatabaseAdapter) { ... }
export function getAdapter(type: DbType): DatabaseAdapter { ... }
```

## Related Code Files

### Modify
- `src/services/db.service.ts` — add migration v2 with connections + connection_table_cache tables
- `src/services/sqlite.service.ts` → refactor to implement `DatabaseAdapter`
- `src/services/postgres.service.ts` → refactor to implement `DatabaseAdapter`

### Create
- `src/types/database.ts` — shared DB types and adapter interface
- `src/services/database/adapter-registry.ts` — adapter registry
- `src/services/database/sqlite-adapter.ts` — SQLite adapter (extracted from sqlite.service.ts)
- `src/services/database/postgres-adapter.ts` — PostgreSQL adapter (extracted from postgres.service.ts)
- `src/services/connection.service.ts` — CRUD for saved connections

## Implementation Steps

1. Create `src/types/database.ts` with all shared types
2. Create `src/services/database/adapter-registry.ts`
3. Create `src/services/database/sqlite-adapter.ts` implementing `DatabaseAdapter` (extract from sqlite.service.ts)
4. Create `src/services/database/postgres-adapter.ts` implementing `DatabaseAdapter` (extract from postgres.service.ts)
5. Register adapters at server startup in `src/server/index.ts`
6. Add migration v2 in `db.service.ts`: <!-- Updated: Validation Session 1 - readonly DEFAULT 1 + connection_table_cache included -->
   - `connections` table with `readonly INTEGER NOT NULL DEFAULT 1` (safe-by-default, UI-only toggle)
   - `connection_table_cache` table (connection_id FK, table_name, schema_name, row_count, cached_at)
   - Fix existing partial migration in db.service.ts: add missing `readonly` column + cache table
7. Create `src/services/connection.service.ts` with CRUD:
   - `getConnections()` → all connections
   - `getConnection(id)` → single connection
   - `createConnection(data)` → insert
   - `updateConnection(id, data)` → update
   - `deleteConnection(id)` → delete (cascades cache)
8. Compile check — run `npx tsc --noEmit`

## Todo
- [x] Create shared DB types (`src/types/database.ts`)
- [x] Create adapter registry
- [x] Create SQLite adapter
- [x] Create PostgreSQL adapter
- [x] Register adapters at startup
- [x] Add migration v3 to db.service.ts (includes readonly + connection_table_cache)
- [x] Create connection.service.ts with CRUD (integrated into db.service.ts)
- [x] Compile check

## Success Criteria
- `DatabaseAdapter` interface works for both SQLite and PostgreSQL
- Connections stored in PPM internal SQLite db
- Existing sqlite/postgres viewers still work (backward compat via old services as wrappers)

## Completion Summary

**Delivered files:**
- `src/types/database.ts` — DatabaseAdapter interface, all type definitions
- `src/services/database/adapter-registry.ts` — adapter registration system
- `src/services/database/sqlite-adapter.ts` — SQLite implementation
- `src/services/database/postgres-adapter.ts` — PostgreSQL implementation
- `src/services/database/init-adapters.ts` — startup initialization
- `src/services/database/readonly-check.ts` — shared isReadOnlyQuery() with CTE support
- `src/services/db.service.ts` — migration v3 (readonly + connection_table_cache), helper CRUD functions

**Code review fixes applied:**
- CRIT-1: Proper credential handling in adapter implementations
- HIGH-1: CTE-safe readonly detection in shared readonly-check.ts
- Migration v3 ensures safe column additions and cache table

## Risk Assessment
- **Breaking change risk**: ✓ Mitigated — old routes unchanged during implementation
- **Migration risk**: ✓ Mitigated — migration v3 is additive with CREATE IF NOT EXISTS
