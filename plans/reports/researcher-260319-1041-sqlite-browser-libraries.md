# Research Report: SQLite Browser Libraries for React

**Date:** 2026-03-19 | **Sources:** 3 Gemini research queries | **Context:** PPM project (React + Vite + Tailwind + shadcn/ui + Bun)

## Executive Summary

For embedding a SQLite viewer/editor in PPM's browser tab, the recommended stack is:
- **Engine:** `sql.js` (WASM SQLite, 13.6k stars, ~480k weekly downloads) — best for "open .db file → view/edit" use case
- **Table UI:** TanStack Table v8 + shadcn/ui data-table — already aligned with project stack
- **SQL Editor:** CodeMirror 6 (`@uiw/react-codemirror` + `@codemirror/lang-sql`) — lightweight, modular
- **Alternative engine:** `@sqlite.org/sqlite-wasm` (official build) — better for OPFS persistence but heavier

No single npm package provides a complete "SQLite browser component." Must be assembled from parts.

---

## Core SQLite WASM Engines

| Feature | **sql.js** | **@sqlite.org/sqlite-wasm** | **wa-sqlite** |
|---|---|---|---|
| Version | 1.12.0 | 3.48.0 | 0.9.x |
| GitHub Stars | 13.6k | 950+ | 1.3k |
| Weekly Downloads | ~480,000 | ~2,500 | ~5,000 |
| Bundle Size | ~1MB (WASM) + 15kB (JS) | ~2.8MB | ~2.2MB |
| Persistence | Manual (export Uint8Array) | OPFS (native speed) | Flexible VFS |
| Best For | Load/view/edit .db files | Full app with persistence | Custom VFS |

### Recommendation: `sql.js`

PPM use case = user opens .db file → view tables → edit data → run queries → save back. `sql.js` is perfect:
- Lightweight, most documented, largest community
- Load file: `new SQL.Database(new Uint8Array(arrayBuffer))`
- Export: `db.export()` → `Uint8Array` → save to disk
- No OPFS headers required (OPFS needs `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy`)

```typescript
import initSqlJs from 'sql.js';

const SQL = await initSqlJs({ locateFile: f => `/sql-wasm/${f}` });
const buf = await file.arrayBuffer();
const db = new SQL.Database(new Uint8Array(buf));

// Schema introspection
const tables = db.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
// Table info
const columns = db.exec("PRAGMA table_info('users')");
// Run query
const results = db.exec("SELECT * FROM users LIMIT 100");
// Export modified db
const data = db.export(); // Uint8Array
```

---

## UI Components

### Data Grid: TanStack Table v8 + shadcn/ui

| Library | Style | Bundle | Inline Edit | Virtualization |
|---|---|---|---|---|
| **TanStack Table v8** | Headless (shadcn compatible) | ~15kB | Custom impl | Via @tanstack/react-virtual |
| **Glide Data Grid** | Canvas-based (Excel-like) | ~45kB | Built-in | Native (1M+ rows) |
| **AG Grid** | Full-featured | ~300kB | Built-in | Built-in |

**Recommendation:** TanStack Table — headless, works with existing shadcn/ui components, lightweight. Use `@tanstack/react-virtual` for large datasets (10k+ rows).

**Inline editing pattern:**
```tsx
const onCellEdit = (rowId: string, columnId: string, value: unknown) => {
  db.run(`UPDATE ${table} SET ${columnId} = ? WHERE rowid = ?`, [value, rowId]);
  // Optimistic update
  setData(old => old.map(row => row.rowid === rowId ? { ...row, [columnId]: value } : row));
};
```

### SQL Editor: CodeMirror 6

| Library | Bundle | SQL Support | Autocomplete |
|---|---|---|---|
| **@uiw/react-codemirror** | ~40kB | `@codemirror/lang-sql` (SQLite dialect) | Schema-aware |
| **Monaco Editor** | ~2MB | Full SQL support | VS Code-level |

**Recommendation:** CodeMirror 6 — much lighter than Monaco, supports SQLite dialect, schema-aware autocomplete possible.

```tsx
import CodeMirror from '@uiw/react-codemirror';
import { sql, SQLite } from '@codemirror/lang-sql';

<CodeMirror
  value={query}
  extensions={[sql({ dialect: SQLite, schema: tableSchema })]}
  onChange={setQuery}
/>
```

---

## Architecture for PPM

### Component Structure
```
SqliteViewer/
├── sqlite-viewer.tsx          # Main container
├── table-sidebar.tsx          # Table list + schema tree
├── query-editor.tsx           # CodeMirror SQL editor
├── results-table.tsx          # TanStack Table data grid
├── use-sqlite.ts              # Hook: load/query/export db
└── sqlite-worker.ts           # Optional: Web Worker for large DBs
```

### Schema Introspection Queries
```sql
-- List tables
SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';
-- Table columns
PRAGMA table_info('table_name');
-- Indexes
PRAGMA index_list('table_name');
-- Row count
SELECT COUNT(*) FROM table_name;
```

### Key Patterns
1. **File Loading:** FileReader API → ArrayBuffer → sql.js Database
2. **Save/Export:** `db.export()` → Uint8Array → Blob → download or write back
3. **Web Worker (optional):** Use Comlink to proxy sql.js in Worker for non-blocking queries on large DBs
4. **Undo/Redo:** Command pattern — store `{ execute: "UPDATE...", undo: "UPDATE... old_value" }` in stack
5. **Pagination:** `SELECT * FROM table LIMIT ? OFFSET ?` with TanStack Table pagination

---

## Reference Projects

| Project | Stars | Stack | Notes |
|---|---|---|---|
| **sqliteviz** | 2.3k | React + sql.js + Tabulator | Query → table flow, CSV export |
| **sql-viewer** (amoscardino) | - | React + sql.js + Monaco | Modern editor + results UI |
| **shadcn-table** (Kiranism) | - | Next.js + shadcn + TanStack | Advanced filtering/selection patterns |

---

## Implementation Recommendation for PPM

### Minimal MVP (Phase 1)
1. Install `sql.js` + `@uiw/react-codemirror` + `@codemirror/lang-sql`
2. Create `useSqlite` hook: load .db file, execute queries, export
3. Table sidebar: list tables from `sqlite_schema`
4. Results table: shadcn data-table (TanStack Table already in project deps?)
5. Query editor: CodeMirror with SQLite dialect

### Enhanced (Phase 2)
1. Inline cell editing with UPDATE queries
2. Schema-aware autocomplete in editor
3. Virtual scrolling for large tables
4. Web Worker for non-blocking execution
5. Undo/redo command stack

### Dependencies to Add
```bash
bun add sql.js @uiw/react-codemirror @codemirror/lang-sql
```

---

## Unresolved Questions
1. Does PPM already have TanStack Table / shadcn data-table set up?
2. Should the SQLite viewer work with backend .db files (server-side) or purely client-side (browser WASM)?
3. For PPM's use case — is this for viewing project databases, or the PPM internal SQLite db?
4. Large file threshold — at what DB size should we switch to Web Worker / lazy loading?
