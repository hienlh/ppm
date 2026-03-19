# Phase 6: Refactor — Migrate Existing SQLite/PostgreSQL Viewers

## Priority: Medium | Effort: M | Status: Complete
## Depends on: Phase 1 ✓

## Overview
Refactor the existing SQLite and PostgreSQL viewer components to use the unified `DatabaseAdapter` API when opened via a saved connection. Old direct-access mode (file path / connection string) still works for backward compatibility.

## Key Insights
- Current viewers call service-specific APIs directly (`/api/project/:name/sqlite/...` and `/api/postgres/...`)
- When `metadata.connectionId` is present, viewers should use unified `/api/db/connections/:id/...` endpoints instead
- PostgreSQL viewer currently requires manual connection string input — skip this when connectionId is provided
- SQLite viewer currently requires project context — skip this when connectionId is provided

## Related Code Files

### Modify
- `src/web/components/sqlite/use-sqlite.ts` — add connectionId-aware API calls
- `src/web/components/sqlite/sqlite-viewer.tsx` — detect connectionId, skip file selection
- `src/web/components/postgres/use-postgres.ts` — add connectionId-aware API calls
- `src/web/components/postgres/postgres-viewer.tsx` — detect connectionId, skip connection form

## API Routing Logic

```typescript
// In use-sqlite.ts / use-postgres.ts hooks
const connectionId = tab.metadata?.connectionId as number | undefined;

// If connectionId exists, use unified API
const baseUrl = connectionId
  ? `/api/db/connections/${connectionId}`
  : `/api/project/${projectName}/sqlite`;  // or /api/postgres

// Unified API endpoints mirror old ones:
// GET /tables → GET /api/db/connections/:id/tables
// GET /schema → GET /api/db/connections/:id/schema?table=...
// GET /data   → GET /api/db/connections/:id/data?table=...&page=...
// POST /query → POST /api/db/connections/:id/query
// PUT /cell   → PUT /api/db/connections/:id/cell
```

## Implementation Steps

1. Update `use-sqlite.ts`:
   - Accept optional `connectionId` from tab metadata
   - When connectionId present: use `/api/db/connections/:id/...` endpoints
   - When absent: use existing `/api/project/:name/sqlite/...` endpoints (no change)
2. Update `sqlite-viewer.tsx`:
   - Read `connectionId` from metadata
   - If connectionId: skip file path display, show connection name instead
   - Pass connectionId to `useSqlite` hook
3. Update `use-postgres.ts`:
   - Accept optional `connectionId` from tab metadata
   - When connectionId present: use `/api/db/connections/:id/...` endpoints
   - When absent: use existing `/api/postgres/...` endpoints with connection string
4. Update `postgres-viewer.tsx`:
   - Read `connectionId` from metadata
   - If connectionId: skip connection form entirely, load tables immediately
   - Pass connectionId to `usePostgres` hook
5. Compile check

## Todo
- [x] Update use-sqlite.ts with dual-mode API
- [x] Update sqlite-viewer.tsx for connectionId support
- [x] Update use-postgres.ts with dual-mode API
- [x] Update postgres-viewer.tsx for connectionId support
- [x] Compile check

## Success Criteria
- Opening a table from sidebar uses unified API (connectionId path)
- Opening .db file from file tree still uses old project-scoped API (backward compat)
- Opening PostgreSQL from command palette without saved connection still shows connection form
- No breaking changes to existing functionality

## Completion Summary

**Updated files:**
- `src/web/components/sqlite/use-sqlite.ts` — Dual-mode API routing (connectionId vs project-scoped)
- `src/web/components/sqlite/sqlite-viewer.tsx` — connectionId support
- `src/web/components/postgres/use-postgres.ts` — Dual-mode API routing
- `src/web/components/postgres/postgres-viewer.tsx` — connectionId support + skips form when connectionId present

**Features:**
- Backward compatible: old direct-access paths still work
- When connectionId present: use `/api/db/connections/:id/...` endpoints
- When absent: use existing `/api/project/:name/sqlite` or `/api/postgres` endpoints
- PostgreSQL form skipped when connectionId provided
- SQLite file path hidden when connectionId provided

## Risk Assessment
- ✓ Dual-mode complexity: Conditional logic isolated in hooks
- ✓ Type safety: connectionId properly typed and validated
