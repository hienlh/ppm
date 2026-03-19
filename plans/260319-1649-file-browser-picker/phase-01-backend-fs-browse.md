# Phase 1: Backend — Consolidate /api/fs/* + Add Browse

## Context

- [Brainstorm report](../reports/brainstorm-260319-1649-file-browser-picker.md)
- Existing `GET /api/fs/list` (src/server/index.ts:107) — inline, recursive flat list
- Existing `GET /api/fs/read` (src/server/index.ts:146) — inline, read file outside project
- Existing `PUT /api/fs/write` (src/server/index.ts:169) — inline, write file outside project
- All 3 duplicate `~` expansion, have no security whitelist, are inline in index.ts (~80 LOC)

## Overview

- **Priority**: P1
- **Status**: Pending
- **Effort**: 2h
- **Consolidation**: Extract 3 inline /api/fs/* endpoints from index.ts into proper service + route
- **New feature**: Add `GET /api/fs/browse` for 1-level structured directory listing
- **Security**: Add whitelist roots to ALL /api/fs/* endpoints

## Requirements

### Functional
- List entries of a single directory (non-recursive)
- Return structured entries: name, path, type (file/directory), size, modified
- Return breadcrumbs for current path
- Return parent path (null if at FS root)
- Support `~` expansion to home dir
- Support `showHidden` toggle for dotfiles

### Non-functional
- Response < 200ms for typical directories (< 500 entries)
- Block access to sensitive system directories
- Cross-platform (macOS, Linux, Windows)

## Architecture

```
Client                    Server
  |                         |
  |-- GET /api/fs/browse -->|
  |   ?path=/Users/me      |
  |   &showHidden=false     |
  |                         |-- fsBrowseService.browse(path, opts)
  |                         |   - resolve path (~, relative)
  |                         |   - validate against whitelist
  |                         |   - readdirSync (1 level)
  |                         |   - build entries + breadcrumbs
  |<-- { entries, current,  |
  |     parent, breadcrumbs}|
```

## Related Code Files

### Create
- `src/services/fs-browse.service.ts` — core browsing logic
- `src/server/routes/fs-browse.ts` — HTTP route

### Modify
- `src/server/index.ts` — mount route at `/api/fs` prefix

## Key Insights

- Existing `/api/fs/list` is inline in index.ts (not a service). New browse should be a proper service file.
- `GitDirsService` pattern: singleton export, `readdirSync` + `statSync`, skip symlinks, skip known dirs.
- `FileService.assertWithinProject()` pattern for path validation — adapt for whitelist roots.
- Use `node:path` `resolve`, `basename`, `dirname`, `sep` for cross-platform.

## Implementation Steps

### 1. Create `src/services/fs-browse.service.ts`

```typescript
// Types
interface BrowseEntry {
  name: string;
  path: string;            // absolute path
  type: "file" | "directory";
  size?: number;           // bytes, files only
  modified: string;        // ISO string
}

interface BrowseResult {
  entries: BrowseEntry[];
  current: string;         // resolved absolute path
  parent: string | null;   // null at FS root
  breadcrumbs: { name: string; path: string }[];
}

interface BrowseOptions {
  showHidden?: boolean;    // default false
}
```

**Whitelist logic:**
```typescript
// Allowed root prefixes (platform-aware)
// macOS/Linux: homedir, /Volumes, /mnt, /media, /tmp
// Windows: any drive letter (C:\, D:\, etc.), homedir
// Always allowed: homedir() and any descendant

function isAllowedPath(resolved: string): boolean {
  const home = homedir();
  if (resolved.startsWith(home)) return true;

  if (process.platform === "win32") {
    // Allow any drive root: C:\, D:\, etc.
    return /^[A-Z]:\\/i.test(resolved);
  }

  const ALLOWED_ROOTS = ["/Volumes", "/mnt", "/media", "/tmp", "/home"];
  return ALLOWED_ROOTS.some(r => resolved === r || resolved.startsWith(r + "/"));
}
```

**Blocked entries** (skip in listing):
- `.git` (contents, not the folder itself)
- `node_modules` (show but don't recurse — we're 1-level anyway)
- Files matching `.env*` pattern

**Breadcrumb builder:**
```typescript
function buildBreadcrumbs(absPath: string): { name: string; path: string }[] {
  const home = homedir();
  const parts: { name: string; path: string }[] = [];
  let current = absPath;

  while (current !== dirname(current)) {  // stop at root
    if (current === home) {
      parts.unshift({ name: "~", path: current });
      break;
    }
    parts.unshift({ name: basename(current), path: current });
    current = dirname(current);
  }

  // If we didn't hit home, add the FS root
  if (current === dirname(current) && parts[0]?.path !== current) {
    parts.unshift({ name: basename(current) || "/", path: current });
  }

  return parts;
}
```

**Main browse function:**
```typescript
export function browse(dirPath?: string, options?: BrowseOptions): BrowseResult {
  const home = homedir();
  let resolved = dirPath
    ? (dirPath.startsWith("~") ? resolve(home, dirPath.slice(2)) : resolve(dirPath))
    : home;

  // Validate
  if (!isAllowedPath(resolved)) throw new Error("Access denied");
  if (!existsSync(resolved)) throw new Error("Directory not found");
  if (!statSync(resolved).isDirectory()) throw new Error("Not a directory");

  // Read entries
  const raw = readdirSync(resolved, { withFileTypes: true });
  const entries: BrowseEntry[] = [];

  for (const entry of raw) {
    if (!options?.showHidden && entry.name.startsWith(".")) continue;
    if (entry.name.startsWith(".env")) continue;  // always hide .env*

    const fullPath = resolve(resolved, entry.name);
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;  // skip symlinks
      const stat = statSync(fullPath);
      entries.push({
        name: entry.name,
        path: fullPath,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.isFile() ? stat.size : undefined,
        modified: stat.mtime.toISOString(),
      });
    } catch { /* permission denied — skip */ }
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentDir = dirname(resolved);
  return {
    entries,
    current: resolved,
    parent: parentDir !== resolved ? parentDir : null,
    breadcrumbs: buildBreadcrumbs(resolved),
  };
}
```

### 2. Create `src/server/routes/fs-browse.ts`

```typescript
import { Hono } from "hono";
import { browse } from "../../services/fs-browse.service.ts";
import { ok, err } from "../../types/api.ts";

export const fsBrowseRoutes = new Hono();

/** GET /api/fs/browse?path=/some/dir&showHidden=false */
fsBrowseRoutes.get("/browse", (c) => {
  try {
    const path = c.req.query("path") || undefined;
    const showHidden = c.req.query("showHidden") === "true";
    const result = browse(path, { showHidden });
    return c.json(ok(result));
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg.includes("Access denied") ? 403
      : msg.includes("not found") ? 404 : 400;
    return c.json(err(msg), status);
  }
});
```

### 3. Mount in `src/server/index.ts`

After line ~193 (where other routes are mounted):
```typescript
import { fsBrowseRoutes } from "./routes/fs-browse.ts";
// ...
app.route("/api/fs", fsBrowseRoutes);
```

Note: existing `/api/fs/list`, `/api/fs/read`, `/api/fs/write` are inline in index.ts. The new browse route is mounted under same prefix but as a separate route file. No conflict since paths don't overlap.

## Todo List

- [ ] Create `src/services/fs-browse.service.ts` with browse(), isAllowedPath(), buildBreadcrumbs()
- [ ] Create `src/server/routes/fs-browse.ts` with GET /browse endpoint
- [ ] Mount route in `src/server/index.ts` under `/api/fs`
- [ ] Test: browse home dir, navigate into subdirectory, blocked path returns 403
- [ ] Test: Windows drive path handling (if applicable)

## Success Criteria

- `GET /api/fs/browse` returns structured entries for any allowed directory
- Breadcrumbs correctly collapse home dir to `~`
- Blocked paths return 403
- Non-existent paths return 404
- Hidden files excluded by default, shown when `showHidden=true`
- `.env*` files always hidden
- Symlinks skipped

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Large dir (1000+ entries) | Slow response | Entries are flat (1 level), statSync is fast. Cap at 1000 if needed. |
| Sensitive file exposure | Security | Whitelist roots, always hide `.env*`, block `.git` contents |
| Symlink loops | Hang | Skip all symlinks via lstatSync check |

## Security Considerations

- Whitelist approach: only home dir, /Volumes, /mnt, /media, /tmp, /home
- `.env*` files always hidden regardless of `showHidden`
- No file content exposed — only metadata (name, size, modified)
- Symlinks skipped to prevent traversal
