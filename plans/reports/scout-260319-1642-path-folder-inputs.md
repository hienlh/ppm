# Scout Report: Path & Folder Input Components

**Date**: 2026-03-19
**Time**: 16:42
**Scope**: Path/folder input fields (frontend) and file system operations (backend)

## Summary
Found **9 frontend components** with path/folder input fields and **8 backend services/routes** handling file/directory operations. Identified core patterns for path input with suggestions, file browsing, and database path configuration.

---

## FRONTEND: Path/Folder Input Fields

### 1. **DirSuggest Component** (Reusable)
**File**: `src/web/components/projects/dir-suggest.tsx`
**Lines**: 1-152

**Purpose**: Auto-complete input field for directory paths with live filtering
- Fetches all git directories once via `/api/projects/suggest-dirs`
- Client-side filtering by path/name
- Keyboard navigation (↑↓ arrows, Tab/Enter to select, Esc to close)
- Loads 50 results max

**Key Props**:
- `value: string` — current path input
- `onChange: (value: string) => void` — update handler
- `onSelect?: (item: DirSuggestItem) => void` — selection callback
- `placeholder?: string` — default: `/home/user/my-project`

---

### 2. **AddProjectForm Component**
**File**: `src/web/components/layout/add-project-form.tsx`
**Lines**: 1-151

**Purpose**: Form to add new project with directory path + optional name
- Path input (line 88-97) with FolderOpen icon
- Debounced suggestions via `/api/projects/suggest-dirs?q={path}` (line 38)
- Optional display name input
- Real-time error handling
- Debounce delay: 250ms

---

### 3. **FilePicker Component**
**File**: `src/web/components/chat/file-picker.tsx`
**Lines**: 1-126

**Purpose**: Dropdown picker for file/folder selection in chat
- Takes pre-loaded `FileNode[]` items
- Filters by `filter: string` parameter
- Keyboard navigation
- Max 50 results
- Shows File/Folder icons with path

---

### 4. **ConnectionFormDialog Component**
**File**: `src/web/components/database/connection-form-dialog.tsx`
**Lines**: 1-234

**Purpose**: Create/edit database connections
- **SQLite path input** (lines 162-171)
  - Label: "File Path *"
  - Placeholder: `/path/to/database.db`
  
- **PostgreSQL connection string** (lines 151-160)
  - Label: "Connection String *"
  - Type: password input
  
- Form includes name, type, group, color, readonly toggle

---

### 5. **ConnectionImportExport Component**
**File**: `src/web/components/database/connection-import-export.tsx`
**Lines**: 1-116

**Purpose**: Import/export database connections
- Export to JSON file
- Export to clipboard
- Import from file
- Import from clipboard
- File input: `accept=".json"`

---

### 6. **FileTree Component**
**File**: `src/web/components/explorer/file-tree.tsx`
**Lines**: 1-100+

**Purpose**: Hierarchical file/folder tree browser
- Displays `FileNode[]` tree structure
- Click to open files/folders
- Ctrl+Click for file comparison
- Auto-detects SQLite files (`.db`, `.sqlite`, `.sqlite3`)
- Context menu for file actions

---

### 7-9. **Additional Components**
- `src/web/components/chat/message-input.tsx` — File attachment input
- `src/web/components/settings/settings-tab.tsx` — Project settings
- `src/web/stores/file-store.ts` — File tree state management

---

## BACKEND: File System & Directory Operations

### 1. **File Routes** (API)
**File**: `src/server/routes/files.ts`
**Lines**: 1-169

**Endpoints**:
- `GET /files/tree?depth=3` — Get directory tree
- `GET /files/raw?path=...` — Serve file as binary
- `GET /files/read?path=...` — Read file content
- `PUT /files/write` — Write file content
- `POST /files/create` — Create file/directory
- `DELETE /files/delete` — Delete file/directory
- `GET /files/compare?file1=...&file2=...` — Compare files
- `POST /files/rename` — Rename file/directory
- `POST /files/move` — Move file/directory

All paths validated against projectPath (no path traversal).

---

### 2. **FileService** (Core Operations)
**File**: `src/services/file.service.ts`
**Lines**: 1-262

**Key Methods**:
- `getTree(projectPath, depth=3)` — Build recursive file tree (lines 49-105)
  - Excludes: `.git`, `node_modules`, `.env` files
  - Binary detection: checks first 8KB for null bytes
  - Sorts: directories first, then alphabetically

- `readFile(projectPath, filePath)` — Read with encoding detection (lines 108-132)
  - Returns: `{ content: string; encoding: string }`
  - Auto-detects binary (base64) vs text (UTF-8)

- `writeFile(projectPath, filePath, content)` — Write to file
- `createFile(projectPath, filePath, type)` — Create file or directory
- `deleteFile(projectPath, filePath)` — Delete recursively
- `renameFile(oldPath, newPath)` — Rename with parent dir creation
- `moveFile(source, destination)` — Alias to renameFile

**Security** (lines 26-46):
- `assertWithinProject()` — Path traversal check
- `resolveSafe()` — Safe resolution
- `isExcluded()` — Checks exclusion set
- `blockSensitive()` — Blocks .git, node_modules, .env*

---

### 3. **Project Routes** (API)
**File**: `src/server/routes/projects.ts`
**Lines**: 1-113

**Endpoints**:
- `GET /api/projects` — List all projects
- `POST /api/projects` — Add project by path
- `GET /api/projects/suggest-dirs?path=/some/dir&q=search` — Deep-scan for git (line 38-47)
- `PATCH /api/projects/reorder` — Reorder projects
- `PATCH /api/projects/:name/color` — Set project color
- `PATCH /api/projects/:name` — Update project name/path
- `DELETE /api/projects/:name` — Remove project

---

### 4. **ProjectService** (Business Logic)
**File**: `src/services/project.service.ts`
**Lines**: 1-152

**Key Methods**:
- `list()` — Get all registered projects
- `add(projectPath, name?)` — Add & validate new project
  - Auto-derives name from basename
  - Checks for duplicates

- `update(currentName, updates)` — Update name/path
- `remove(nameOrPath)` — Remove by name or path
- `resolve(nameOrPath)` — Resolve by name or path
- `scanForGitRepos(dir, depth=0)` — Scan for .git (max depth 3)

---

### 5. **GitDirs Service** (Directory Discovery)
**File**: `src/services/git-dirs.service.ts`
**Lines**: 1-113

**Key Functions**:
- `scanGitDirs(root, maxDepth)` — Find all `.git` directories (lines 30-69)
  - Skips symlinks, hidden dirs, vendor, dist, build, `.cache`, etc.
  - Returns: `{ path: string; name: string }[]`

- `getGitDirs(root?, maxDepth=4)` — Get with 5-minute cache (lines 76-91)
- `searchGitDirs(query, root?, maxDepth=4)` — Filter cached results
- `invalidateGitDirCache(root?)` — Clear cache

**Cache**: 5-minute TTL per root directory

**Skip Dirs**: node_modules, .git, .hg, .svn, vendor, dist, build, .cache, .npm, .pnpm, .yarn, __pycache__, .venv, venv, .Trash, Library, Applications, .local, .config

---

### 6. **Database Routes** (API)
**File**: `src/server/routes/database.ts`
**Lines**: 1-100+

**Connection Endpoints**:
- `GET /api/db/connections` — List connections
- `GET /api/db/connections/export` — Export all
- `POST /api/db/connections/import` — Bulk import
  - Validates type ("sqlite" | "postgres")
  - Auto-deduplicates names

**Connection Config**:
- SQLite: `{ type: "sqlite"; path: string }`
- PostgreSQL: `{ type: "postgres"; connectionString: string }`

---

### 7. **ConfigService** (Persistent Config)
**File**: `src/services/config.service.ts`
**Lines**: 1-100+

**Key Methods**:
- `load(explicitPath?)` — Load config from DB/YAML
- `save()` — Persist to DB
- `get<K>(key)` — Get config value
- `set<K>(key, value)` — Set & persist immediately
- `getConfigPath()` — Get DB file path

**Storage**: SQLite DB (auto-migrates from YAML)

---

### 8. **SlashItems Service** (Command/Skill Discovery)
**File**: `src/services/slash-items.service.ts`
**Lines**: 1-185

**Key Functions**:
- `listSlashItems(projectPath)` — Scan for commands & skills (lines 164-184)
  - User-global: `~/.claude/commands/` and `~/.claude/skills/` (strict: SKILL.md only)
  - Project-local: `<projectPath>/.claude/commands/` and `.claude/skills/` (relaxed: also loose .md)

- `walkDir(dir, visitor)` — Recursive directory traversal (lines 42-60)
- `collectCommands(commandsDir, scope)` — Find markdown commands (lines 66-86)
- `collectSkills(skillsDir, scope, strictMode)` — Find skills (lines 98-155)

---

## KEY CODE PATTERNS

### Path Input with Suggestions
```tsx
const [path, setPath] = useState("");
const [suggestions, setSuggestions] = useState<SuggestedDir[]>([]);

useEffect(() => {
  const results = await api.get(`/api/projects/suggest-dirs?q=${encodeURIComponent(path)}`);
  setSuggestions(results ?? []);
}, [path]);
```

### Safe Path Resolution (Backend)
```typescript
private assertWithinProject(targetPath: string, projectPath: string): void {
  const normalizedTarget = normalize(resolve(projectPath, targetPath));
  const normalizedProject = normalize(projectPath);
  if (!normalizedTarget.startsWith(normalizedProject + "/") && 
      normalizedTarget !== normalizedProject) {
    throw new SecurityError("Path traversal not allowed");
  }
}
```

### Directory Traversal
```typescript
function walkDir(dir: string, visitor: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkDir(full, visitor);  // Recurse
      } else if (stat.isFile()) {
        visitor(full);
      }
    } catch { /* skip */ }
  }
}
```

### Caching Git Directories
```typescript
const cache = new Map<string, { dirs: GitDir[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
  return cached.dirs;
}
```

---

## DATA FLOW: Adding a Project

1. User types path in **AddProjectForm** input
2. Debounced (250ms) request to `GET /api/projects/suggest-dirs?q={path}`
3. Backend scans home dir for `.git` folders (or uses cached results)
4. Results (max 50) displayed with name + path
5. User selects or types full path + optional name
6. Submit: `POST /api/projects { path, name? }`
7. Backend validates path exists, no duplicates
8. Project added to config DB
9. Frontend updates project list

---

## DATA FLOW: Opening a File

1. User clicks file in **FileTree**
2. Component detects file type (extension check)
3. Auto-detect SQLite: `.db`, `.sqlite`, `.sqlite3`
4. Opens tab with `filePath` metadata
5. On click: calls `GET /files/read?path={filePath}`
6. Backend loads file safely (path checked, binary detected)
7. Returns: `{ content: string; encoding: "utf-8" | "base64" }`
8. Frontend displays in editor or renders as image/PDF

---

## SECURITY CONSIDERATIONS

- **Path Traversal**: All paths resolved relative to projectPath via `resolveSafe()`
- **Sensitive Files**: `.env*`, `.git`, `node_modules` blocked by `blockSensitive()`
- **Database Paths**: Stored encrypted in connection_config
- **Symlinks**: Skipped in directory scans to avoid cycles
- **Permission Errors**: Silently ignored during directory traversal

---

## PERFORMANCE CONSIDERATIONS

- **Git Scan Cache**: 5-minute TTL reduces repeated home dir scans
- **File Tree Depth**: Limited to 3 levels by default (configurable)
- **Autocomplete Results**: Max 50 items to avoid rendering large lists
- **Binary Detection**: First 8KB only (doesn't scan entire file)
- **Debounce**: 250ms on path input prevents request spam

---

## CROSS-PLATFORM CONSIDERATIONS

- Uses `node:path` for proper separator handling
- Windows: backslash paths, C:\ drives supported
- POSIX: forward slashes, ~ home expansion
- `resolve()` normalizes paths appropriately
- `sep` import for path component splitting

---

## Files to Modify/Extend

**Frontend Components**:
- `src/web/components/projects/dir-suggest.tsx` — Add new path input
- `src/web/components/layout/add-project-form.tsx` — Extend form fields
- `src/web/components/database/connection-form-dialog.tsx` — SQLite path input
- `src/web/components/explorer/file-tree.tsx` — File browsing UI

**Backend Services**:
- `src/server/routes/files.ts` — File endpoints
- `src/server/routes/projects.ts` — Project endpoints
- `src/services/file.service.ts` — File operations
- `src/services/project.service.ts` — Project management
- `src/services/git-dirs.service.ts` — Directory discovery

---

## Unresolved Questions

1. Are there native file pickers (Tauri/Electron modal)?
2. Bulk file operations (select multiple + action)?
3. Windows UNC path support (`\\server\share`)?
4. Gitignore-aware filtering for file tree?
5. Environment variable expansion in database paths?
6. Symlink handling (skip vs. follow)?

