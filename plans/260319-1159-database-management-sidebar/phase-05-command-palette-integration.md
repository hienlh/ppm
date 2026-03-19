# Phase 5: Frontend — Command Palette DB Table Search

## Priority: Medium | Effort: S | Status: Complete
## Depends on: Phase 2 + Phase 3 ✓

## Overview
Add database table search to the command palette. Users type a table name and see matching results across all saved connections, with connection name/color context. Clicking opens the table in a viewer tab.

## Key Insights
- Command palette in `command-palette.tsx` already has action groups and search filtering
- Table cache search endpoint (`GET /api/db/search?q=...`) provides cross-connection results
- Results need connection context (name, color, type) for disambiguation

## Related Code Files

### Modify
- `src/web/components/layout/command-palette.tsx` — add DB table search group with async fetch

## Search Result UI

```
┌─ Search: "emp" ──────────────────────┐
│                                       │
│ DATABASE TABLES                       │
│   employees      🟢 nxsys-dev (PG)  │
│   employment_history  🟢 nxsys-dev  │
│   emp_backup     📄 local.db (SQLite)│
│                                       │
│ ACTIONS                               │
│   PostgreSQL — Open connection        │
│   ...                                 │
└───────────────────────────────────────┘
```

## Implementation Steps

1. Add async search function in `command-palette.tsx`:
   - Debounce search input (300ms)
   - Call `GET /api/db/search?q={query}` when query length >= 2
   - Map results to command palette action format
2. Add "Database Tables" group to results:
   - Show table name, connection name, connection color dot, DB type badge
   - On select: `openTab()` with type matching connection type, metadata `{ connectionId, tableName, connectionColor }`
3. Handle empty/loading states gracefully

## Todo
- [x] Add debounced table search to command palette
- [x] Render search results with connection context
- [x] Wire up tab opening on result click

## Completion Summary

**Updated files:**
- `src/web/components/layout/command-palette.tsx` — Added debounced DB table search

**Features:**
- 300ms debounce on search input
- Fetches from `/api/db/search?q=...` for queries >= 2 chars
- Shows connection context (name, color, DB type)
- Clicking result opens viewer tab with table pre-selected
- Clean UX: no results group shown if no matches

## Success Criteria
- ✓ Typing 2+ chars shows matching tables from all saved connections
- ✓ Each result shows which connection it belongs to (with color)
- ✓ Clicking result opens correct DB viewer tab with table pre-selected
- ✓ No results = no "Database Tables" group shown (clean UX)
