# Code Review: Database Management Sidebar

**Date:** 2026-03-19
**Files reviewed:** 15 files (new + modified)
**LOC:** ~800 new lines across backend + frontend

---

## Scope

- `src/services/db.service.ts` — migration v2+v3, connection/cache helpers
- `src/types/database.ts` — DatabaseAdapter interface
- `src/services/database/` — adapter-registry, sqlite/postgres adapters, init
- `src/services/table-cache.service.ts` — table cache service
- `src/server/routes/database.ts` — unified API with readonly enforcement
- `src/cli/commands/db-cmd.ts` — CLI commands + readonly enforcement
- `src/web/components/database/` — sidebar, connection list, form dialog, color picker, hook
- `src/web/lib/color-utils.ts` — WCAG contrast utility
- `src/web/components/layout/draggable-tab.tsx` — tab color styling
- `src/web/components/layout/command-palette.tsx` — DB table search
- `src/web/components/sqlite/use-sqlite.ts` — connectionId support
- `src/web/components/postgres/use-postgres.ts` — connectionId support

**Scout edge cases:** dual-path hooks (old vs. unified API), stale closure in `handleCreate`, WITH-CTE bypass on readonly filter, LIKE wildcard injection, plaintext credential exposure in API response.

---

## Overall Assessment

Solid, pragmatic implementation. The architecture (adapter pattern, unified `/api/db` routes, migration chain) is clean and well-structured. Backward compatibility with old project-scoped routes is maintained. The main areas needing attention are: one high-severity credential leak, one medium security issue with the readonly regex, two logic bugs, and a DRY violation.

---

## Critical Issues

### CRIT-1: Plaintext credentials returned in `GET /api/db/connections`

`getConnections()` returns the full `ConnectionRow` including `connection_config` which is a JSON blob containing `connectionString` (with embedded password) for PostgreSQL connections. This is returned directly to the frontend via `GET /api/db/connections`.

The frontend (`use-connections.ts:7`) stores the full `connection_config` and `connection-form-dialog.tsx:44` parses it to pre-populate the edit form — this is intentional. However the password is also rendered in the form as `type="password"` which is correct for editing, but **the raw credential string is sitting in browser memory and the API response**.

**Impact:** If PPM is exposed (e.g. with `--share` mode), any authenticated user hitting `GET /api/db/connections` gets all connection strings with plaintext passwords.

**Recommended fix:** Return a masked `connection_config` in list/get responses (replace password with `***`), and only use the real credentials server-side. Add a separate `GET /api/db/connections/:id/config` endpoint (auth-gated, returns real config) if the form needs to display the real value.

Alternatively, at minimum, strip `connectionString` / `path` from list responses and add a `configured: true` flag the UI can rely on.

---

## High Priority

### HIGH-1: `WITH` CTE bypass in `isReadOnlyQuery`

The regex `^\s*(SELECT|EXPLAIN|SHOW|PRAGMA|DESCRIBE|WITH\b)` allows any query starting with `WITH`, including:

```sql
WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x
```

This bypasses the readonly guard on the API query endpoint and the CLI `ppm db query` command.

**Fix:** Change the regex to specifically detect writable CTEs. The simplest approach is to detect `WITH...AS (...INSERT|UPDATE|DELETE`:

```ts
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  if (/^WITH\b/.test(trimmed)) {
    // Only allow CTEs that don't contain write statements
    return !/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/.test(trimmed);
  }
  return /^(SELECT|EXPLAIN|SHOW|PRAGMA|DESCRIBE)\b/.test(trimmed);
}
```

This is also a DRY issue — `isReadOnlyQuery` is duplicated identically in `database.ts:244` and `db-cmd.ts:62`. Extract to `src/services/database/query-utils.ts`.

### HIGH-2: `updateConnection` dynamic SQL with `as any` spread

`db.service.ts:425-426`:
```ts
(getDb().query(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`) as any).run(...vals);
```

The `as any` cast + spread is needed because Bun's `Statement.run()` accepts individual positional args. This works but is fragile — if `vals` ever contains an array element itself it will break silently.

**Better pattern** (Bun supports this natively):
```ts
getDb().query(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`).run(vals);
// run() accepts a single array parameter in Bun's SQLite
```

The dynamic column building in `sets[]` also has no risk of injection since column names come exclusively from code (hardcoded string literals), so this is safe as-is. But replace the `as any` cast to avoid future maintenance issues.

---

## Medium Priority

### MED-1: Stale closure bug in `DatabaseSidebar.handleCreate`

```tsx
// database-sidebar.tsx:39-44
const handleCreate = async (data: CreateConnectionData) => {
  await createConnection(data);
  // connections is stale here — state update from createConnection hasn't propagated
  const created = connections.find((c) => c.name === data.name);
  if (created) refreshTables(created.id).catch(() => {});
};
```

`createConnection` returns the newly created `Connection` object but `handleCreate` ignores it and searches the stale `connections` state instead. The `find` will always return `undefined` immediately after creation.

**Fix:**
```tsx
const handleCreate = async (data: CreateConnectionData) => {
  const created = await createConnection(data);
  refreshTables(created.id).catch(() => {});
};
```

### MED-2: Edit dialog incorrectly passed `onSave={handleCreate}` instead of no-op

`database-sidebar.tsx:95` passes `onSave={handleCreate}` to the edit dialog. In edit mode, `ConnectionFormDialog` calls `onUpdate` when `isEdit && onUpdate` — so `onSave` is only called if `onUpdate` is undefined. Since `onUpdate={handleUpdate}` is provided, this is harmless in practice, but it's confusing and could cause a double-create if `onUpdate` were ever removed.

**Fix:** Pass `onSave={async () => {}}` (no-op) or restructure the dialog to not require `onSave` in edit mode.

### MED-3: `useEffect` stale closure with `eslint-disable` in `use-postgres.ts`

```ts
useEffect(() => {
  if (unifiedBase) {
    setConnected(true);
    fetchTables();
  }
}, [unifiedBase]); // eslint-disable-line react-hooks/exhaustive-deps
```

`fetchTables` is excluded from deps intentionally (to run only on mount/connectionId change). This is acceptable given `fetchTables` is stable via `useCallback`, but the eslint suppression hides the real issue: `fetchTables` itself depends on `selectedTable` (to avoid resetting selection on re-fetch). If `selectedTable` is unstable this could loop. Consider a `useRef` flag for "initial load done" instead.

### MED-4: Color value not validated server-side

The `color` field is stored as-is from the API body into SQLite and then rendered as `backgroundColor` in React's `style` prop:

```tsx
// draggable-tab.tsx:48
backgroundColor: isActive ? tabColor : `${tabColor}33`,
```

Since this goes into `style={}` (not `innerHTML`), XSS is not possible via React. However, a malformed color string (e.g. `red; background: url(evil)`) could break the CSS parsing in some edge cases.

**Fix:** Add server-side validation:
```ts
if (body.color && !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
  return c.json(err("color must be a 6-digit hex color"), 400);
}
```

### MED-5: LIKE wildcard injection in `searchTableCache`

```ts
).all(`%${query}%`)
```

`%` and `_` in user input are treated as LIKE wildcards. A query of `%` returns all tables. This is a minor info-disclosure since it only exposes table names already in PPM's metadata store (not actual DB content), but it's still unexpected behavior.

**Fix:** Escape LIKE special chars: `query.replace(/[%_]/g, "\\$&")` and add `ESCAPE '\\'` to the SQL.

---

## Low Priority

### LOW-1: DRY — `isReadOnlyQuery` duplicated

Same function in `database.ts` and `db-cmd.ts`. Extract to `src/services/database/query-utils.ts` and import in both.

### LOW-2: `useConnections` silently ignores fetch errors

```ts
} catch {
  // ignore — server may not be ready
}
```

This is fine for initial load, but there's no retry or user-visible error state. If the server is up but returns a 500, the sidebar shows empty with no indication. Low priority since PPM is local-first.

### LOW-3: `isDarkColor` luminance threshold

`color-utils.ts` uses `< 0.4` as the threshold for dark color (switch to white text). The WCAG standard contrast ratio for normal text (4.5:1) maps to luminance ~0.18 for a white background. The threshold of 0.4 is higher than standard, meaning more colors will use white text than necessary. This is a minor visual nit, not a bug.

### LOW-4: `printTable` ANSI codes inflate column widths

In `db-cmd.ts`, ANSI escape codes (like `${C.yellow}RO${C.reset}`) are embedded in cell values but `colWidths` is computed from `.length` of the ANSI-decorated string. This makes the RO/RW column wider than needed visually.

**Fix:** Strip ANSI codes before measuring: `cell.replace(/\x1b\[[0-9;]*m/g, "").length`.

---

## Edge Cases Found by Scout

1. **Migration v2 shipped uncommitted in HEAD~1** — prior commit `HEAD~1` still had `CURRENT_SCHEMA_VERSION = 1`. If users are running a live dev instance, the migrations from 1→2→3 will run sequentially on next start. The `try/catch` around `ALTER TABLE ADD COLUMN readonly` is the right pattern for idempotency. Correct.

2. **Dual-path hook behavior** (`use-sqlite.ts`, `use-postgres.ts`) — old project-scoped paths (`/api/projects/:name/sqlite/...`) and new unified paths (`/api/db/connections/:id/...`) coexist cleanly. The ternary logic in both hooks is correct. No race condition observed.

3. **`handleCreate` stale state** (already filed as MED-1) — tables will not auto-refresh after add because `connections.find` returns `undefined` on stale state.

4. **`fetchTables` in `use-postgres` has `selectedTable` in deps** — if a table is already selected (from a previous tab) and the user opens a new tab for the same connectionId, `fetchTables` won't reset `selectedTable` to the first table because of the `&& !selectedTable` guard. This is actually correct behavior.

5. **Search minimum length = 2 chars** in `table-cache.service.ts:66` and command palette both enforce this. Consistent.

6. **`dbCommands` not in `allCommands` memo** — `allCommands` only includes `actionCommands + fileCommands`. `dbCommands` is added separately in `filtered`:
   ```ts
   return query.trim().length >= 2 ? [...dbCommands, ...matched] : matched;
   ```
   This is correct — DB commands are dynamically fetched and merged at filter time. Not a bug.

---

## Positive Observations

- Migration chain (v1→v2→v3) uses sequential `if (current < N)` guards — correct, handles users upgrading from any prior version.
- `readonly` defaults to `1` (safe-by-default) — good security posture.
- Password masking in `ppm db list` is implemented correctly with the regex `(:\/\/[^:]+:)[^@]+(@)`.
- Adapter pattern (`DatabaseAdapter` interface + registry) is clean and extensible.
- Connection string field uses `type="password"` in the form dialog — credential is not shown in plaintext.
- `syncTables` does delete-then-upsert (not partial update) — prevents stale table names staying in cache after schema changes.
- Cascade delete `ON DELETE CASCADE` on `connection_table_cache.connection_id` is correct.
- `isReadOnlyQuery` check runs before the database call (fail-fast, no unnecessary network call).
- `Math.min(limit, 1000)` cap on `/data` endpoint prevents OOM from huge page requests.
- `WCAG 2.0` luminance formula in `color-utils.ts` is correctly implemented.
- `dbCommands` in command palette correctly passes `connectionId` + `tableName` to `metadata`, enabling tab to use unified API.

---

## Recommended Actions (Prioritized)

1. **(CRIT-1)** Mask `connection_config` in list/get API responses — return `hasPassword: true` or a redacted version. Do not return raw credentials to the frontend.
2. **(HIGH-1)** Fix `isReadOnlyQuery` to reject CTE-wrapped write statements.
3. **(HIGH-1/LOW-1)** Extract `isReadOnlyQuery` to a shared util module (also fixes DRY).
4. **(MED-1)** Fix `handleCreate` in `DatabaseSidebar` to use the return value of `createConnection(data)` instead of searching stale state.
5. **(MED-4)** Add server-side hex color validation in POST/PUT `/api/db/connections`.
6. **(MED-5)** Escape LIKE wildcards in `searchTableCache`.
7. **(HIGH-2)** Remove `as any` from `updateConnection` — use `getDb().query(...).run(vals)` with array.
8. **(LOW-4)** Strip ANSI codes when computing column widths in `printTable`.

---

## Metrics

- Type errors in new files: 0 (pre-existing errors only in unrelated files)
- `as any` usages in new code: 1 (`updateConnection` spread)
- `eslint-disable` suppressions: 1 (use-postgres.ts — intentional, documented)
- DRY violations: 1 (`isReadOnlyQuery` x2)
- Security issues: 3 (CRIT credential leak, HIGH WITH-CTE bypass, MED LIKE injection)
- Logic bugs: 2 (stale closure in handleCreate, misleading onSave on edit dialog)

---

## Unresolved Questions

1. Is PPM intended to support multi-user scenarios? If yes, the credential storage model (plaintext in SQLite) needs a stronger answer beyond local-only use.
2. Should `readonly` be toggleable via the API at all? Currently `PUT /connections/:id` allows setting `readonly=0` via API — CLI cannot do this but any HTTP client can. Is this intentional?
3. Is the `connection_config` JSON blob schema versioned? If PostgreSQL connection format changes (e.g., adding SSL params), old stored configs would break silently.
