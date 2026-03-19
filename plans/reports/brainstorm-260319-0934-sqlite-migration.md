# Brainstorm: Migrate PPM Data Storage to SQLite

## Problem Statement

PPM uses scattered file-based storage (JSON, YAML, text logs) across `~/.ppm/`. This causes:
- **Data integrity risk**: concurrent JSON writes can corrupt files (e.g., session-map.json)
- **No query capability**: can't search/filter/aggregate session logs or usage data
- **Config reload requires restart**: YAML loaded once at startup
- **Code fragmentation**: each service has its own file I/O logic
- **No usage persistence**: cost/token data lost on restart

## Current Data Stores

| Store | File | Format | Issues |
|---|---|---|---|
| Config | `config.yaml` | YAML | Requires restart on change |
| Session mapping | `session-map.json` | JSON | Concurrent write risk |
| Push subscriptions | `push-subscriptions.json` | JSON | No query, cleanup hard |
| Session logs | `sessions/*.log` | Text | No search/filter/aggregate |
| Usage cache | In-memory only | — | Lost on restart |

## Recommendation: All-in SQLite

**Decision**: Migrate ALL persistent data into a single SQLite database at `~/.ppm/ppm.db`

**Why Bun SQLite (`bun:sqlite`)**:
- Built into Bun runtime — zero new dependencies
- Synchronous API — simpler code than file I/O with error handling
- WAL mode — concurrent reads, no corruption on crash
- ACID transactions — atomic multi-table updates

## Proposed Schema

```sql
-- Key-value config (replaces config.yaml)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,  -- JSON-encoded value
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Session ID mapping (replaces session-map.json)
CREATE TABLE session_map (
  ppm_id TEXT PRIMARY KEY,
  sdk_id TEXT NOT NULL,
  project_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Push subscriptions (replaces push-subscriptions.json)
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Session logs (replaces sessions/*.log)
CREATE TABLE session_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_session_logs_session ON session_logs(session_id);
CREATE INDEX idx_session_logs_created ON session_logs(created_at);

-- Usage tracking (replaces in-memory cache)
CREATE TABLE usage_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  session_id TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_session ON usage_cache(session_id);
CREATE INDEX idx_usage_recorded ON usage_cache(recorded_at);
```

## Config Strategy

- **First run**: `ppm init` seeds DB from `ppm.example.yaml` or interactive prompts
- **Runtime**: all reads/writes go to `config` table — no restart needed
- **Export/Import**: `ppm config export > config.yaml` / `ppm config import config.yaml`
- **Migration**: on startup, if `config.yaml` exists but DB doesn't, auto-import and rename YAML to `.bak`
- Config stored as flat key-value with JSON values: `{ "port": "8081", "ai.default_provider": "claude", "auth.enabled": "true" }`
  - Alternative: nested JSON in fewer keys (e.g., `ai` → full JSON object). Simpler migration from YAML structure.

## Implementation Approach

### New Service: `db.service.ts`
- Singleton that opens/creates `~/.ppm/ppm.db`
- Runs migrations on startup (schema versioning via `PRAGMA user_version`)
- Exports typed helper methods per domain
- WAL mode enabled for concurrent access

### Migration Order (by risk/impact)
1. **Usage cache** — new table, no migration needed, immediate value
2. **Session mapping** — small data, simple migration from JSON
3. **Push subscriptions** — small data, simple migration
4. **Session logs** — replace file append with DB insert, enable search
5. **Config** — largest change, migrate from YAML, update all services

### Backward Compatibility
- On first startup with new version: auto-detect existing files → migrate to DB → rename originals to `.bak`
- If DB is missing but YAML exists: treat as fresh migration
- `ppm config export` for users who want portable config

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| DB corruption | WAL mode + regular VACUUM; backup on `ppm config export` |
| Migration bugs | Auto-backup `.bak` files before migration |
| Breaking change for users | Auto-migration on startup, no manual steps |
| Larger disk footprint | Negligible — current data is tiny (<1MB total) |
| Debug harder than text files | Add `ppm db dump` CLI command; session logs still queryable |

## What NOT to Move
- **Cloudflared binary** (`~/.ppm/bin/`) — keep as-is, it's an executable not data
- **Claude SDK sessions** (`~/.claude/projects/`) — owned by SDK, don't touch

## Success Criteria
- Zero file-based data stores (except cloudflared binary)
- Config changes take effect without restart
- Usage data persists across restarts
- Session logs searchable via CLI/API
- Auto-migration from existing file-based stores
- No data loss during migration

## Next Steps
1. Create `db.service.ts` with schema + migrations
2. Migrate services one-by-one (usage → session map → push → logs → config)
3. Add `ppm config export/import` CLI commands
4. Add auto-migration logic on startup
5. Update tests
