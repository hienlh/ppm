# Phase 3: Frontend — Sidebar Database Tab + Connection Manager

## Priority: High | Effort: L | Status: Complete
## Depends on: Phase 2 ✓

## Overview
Add a "Database" tab to the sidebar for managing saved connections. Users can add/edit/delete connections, organize by group, open entire DB or single table in a viewer tab.

## Key Insights
- Sidebar tabs defined in `sidebar.tsx` TABS array + `settings-store.ts` SidebarActiveTab type
- Mobile drawer in `mobile-drawer.tsx` mirrors sidebar — must update both
- Tab metadata `Record<string, unknown>` carries connectionId, tableName, etc.
- Existing `"sqlite"` and `"postgres"` TabTypes can be replaced with single `"database"` TabType or kept and extended with connectionId metadata

## Architecture Decision: Tab Type Strategy
**Keep existing `"sqlite"` and `"postgres"` TabTypes** but add `connectionId` to metadata. This avoids breaking existing tab persistence. The viewer components detect `connectionId` in metadata and use the unified API instead of direct service calls.

## Component Structure
```
src/web/components/database/
├── database-sidebar.tsx         # Sidebar panel (connection list grouped)
├── connection-list.tsx          # Grouped connection tree
├── connection-form-dialog.tsx   # Add/edit connection modal
├── connection-color-picker.tsx  # Color selector (presets + custom)
└── use-connections.ts           # Hook: CRUD + cache for connections
```

## Related Code Files

### Modify
- `src/web/stores/settings-store.ts` — add `"database"` to `SidebarActiveTab`
- `src/web/components/layout/sidebar.tsx` — add database tab to TABS array
- `src/web/components/layout/mobile-drawer.tsx` — add database tab
- `src/web/components/layout/mobile-nav.tsx` — add database bottom nav item
- `src/web/components/sqlite/sqlite-viewer.tsx` — support `connectionId` metadata
- `src/web/components/postgres/postgres-viewer.tsx` — support `connectionId` metadata (skip connection form if connectionId present)

### Create
- `src/web/components/database/database-sidebar.tsx`
- `src/web/components/database/connection-list.tsx`
- `src/web/components/database/connection-form-dialog.tsx`
- `src/web/components/database/connection-color-picker.tsx`
- `src/web/components/database/use-connections.ts`

## UI Design

### Sidebar Panel
```
┌─ DATABASE ──────── [+] ─┐
│                          │
│ ▾ Production             │  ← group
│   🟢 nxsys-dev (PG)     │  ← connection with color dot
│     ├─ employees         │  ← cached table (click → open)
│     ├─ payroll           │
│     └─ 48 more...        │
│   🔵 analytics (PG)     │
│                          │
│ ▾ Local                  │
│   📄 ppm.db (SQLite)    │
│     ├─ config            │
│     └─ session_logs      │
│                          │
│ ▾ Ungrouped             │
│   🟣 test-db (SQLite)   │
└──────────────────────────┘
```

### Connection Form Dialog
<!-- Updated: Validation Session 1 - readonly toggle UI-only, cell edit disabled when readonly -->
- **Name**: text input (required)
- **Type**: select — SQLite | PostgreSQL
- **Connection config**:
  - SQLite: file path input
  - PostgreSQL: connection string input
- **Group**: text input with autocomplete from existing groups
- **Color**: preset palette (8-10 colors) + custom hex input
- **Readonly toggle**: switch (default ON) — only exposed in UI, not CLI
- **Test Connection** button before save

### Readonly in Viewer Tab
- When `connectionId` metadata points to a readonly connection → disable double-click cell editing
- Show lock icon / "Read-only" badge in viewer header

### Color Presets
```typescript
const COLOR_PRESETS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  "#6b7280", "#000000",
];
```

## use-connections Hook
```typescript
function useConnections() {
  connections: Connection[]
  loading: boolean
  createConnection(data): Promise<Connection>
  updateConnection(id, data): Promise<void>
  deleteConnection(id): Promise<void>
  testConnection(id): Promise<{ok, error?}>
  refreshTables(id): Promise<void>   // sync cache
  cachedTables: Map<number, CachedTable[]>
}
```

## Opening Tables
- **Click connection name** → open DB viewer tab (full database, shows table list)
- **Click table name** → open DB viewer tab pre-selecting that table
- Both use `openTab()` with metadata: `{ connectionId, tableName?, connectionColor? }`

## Implementation Steps

1. Add `"database"` to `SidebarActiveTab` in settings-store.ts
2. Create `use-connections.ts` hook (fetch connections, CRUD, cache)
3. Create `connection-color-picker.tsx` (preset grid + custom hex input)
4. Create `connection-form-dialog.tsx` (uses shadcn Dialog + form)
5. Create `connection-list.tsx` (grouped tree with expand/collapse, table items)
6. Create `database-sidebar.tsx` (container with header + add button + connection list)
7. Add database tab to `sidebar.tsx` TABS array with Database icon
8. Add database tab to `mobile-drawer.tsx`
9. Update `sqlite-viewer.tsx` — if `metadata.connectionId` exists, use `/api/db/connections/:id/...` endpoints
10. Update `postgres-viewer.tsx` — if `metadata.connectionId` exists, skip connection form, use unified API
11. Compile check

## Todo
- [x] Extend SidebarActiveTab type
- [x] Create use-connections hook
- [x] Create color picker component
- [x] Create connection form dialog
- [x] Create connection list component
- [x] Create database sidebar panel
- [x] Add to sidebar + mobile drawer
- [x] Update sqlite-viewer for connectionId support
- [x] Update postgres-viewer for connectionId support
- [x] Compile check

## Success Criteria
- Sidebar shows "Database" tab with grouped connections
- Users can add/edit/delete connections with name, type, group, color
- Clicking connection opens DB viewer; clicking table opens that specific table
- Connection form validates with "Test Connection" before save

## Completion Summary

**Delivered components:**
- `src/web/components/database/use-connections.ts` — Hook for CRUD + caching
- `src/web/components/database/connection-color-picker.tsx` — 10 presets + custom hex
- `src/web/components/database/connection-form-dialog.tsx` — Add/Edit modal with validation
- `src/web/components/database/connection-list.tsx` — Grouped tree with expand/collapse
- `src/web/components/database/database-sidebar.tsx` — Main sidebar panel

**Updated files:**
- `src/web/components/layout/sidebar.tsx` — Added Database tab
- `src/web/components/layout/mobile-drawer.tsx` — Added Database tab
- `src/web/components/sqlite/sqlite-viewer.tsx` — connectionId support
- `src/web/components/postgres/postgres-viewer.tsx` — connectionId support

**Features:**
- Grouped connections by group_name
- Add/edit/delete with readonly toggle (default ON)
- Connection testing before save
- Custom colors per connection
- Open DB or specific table in viewer tabs
- Readonly enforced in UI (disabled cell editing)

## Risk Assessment
- ✓ Component size: All files maintained under 200 lines
- ✓ State management: use-connections hook handles optimistic updates
