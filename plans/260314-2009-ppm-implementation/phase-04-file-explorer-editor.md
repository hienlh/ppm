# Phase 4: File Explorer + Code Editor

**Owner:** backend-dev (API) + frontend-dev (UI) — parallel
**Priority:** High
**Depends on:** Phase 2, Phase 3
**Effort:** Medium

## Overview

File tree API, CRUD operations, CodeMirror 6 editor tab, file compare/diff view.

## Backend (backend-dev)

### Files
```
src/services/file.service.ts
src/server/routes/files.ts
```

### File Service
```typescript
class FileService {
  getTree(projectPath: string, depth?: number): FileNode[]
  readFile(filePath: string): { content: string; encoding: string }
  writeFile(filePath: string, content: string): void
  createFile(filePath: string, type: 'file' | 'directory'): void
  deleteFile(filePath: string): void
  renameFile(oldPath: string, newPath: string): void
  moveFile(source: string, destination: string): void
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  modified?: string;
}
```

### API Routes

**[V2 FIX]** `:project` param is project NAME (e.g. "ppm"), not path. Use `resolveProjectPath()` from `src/server/helpers/resolve-project.ts`.

```
GET    /api/files/tree/:project?depth=3     → FileNode[]
GET    /api/files/read?path=...              → { content, encoding }
PUT    /api/files/write                      → { path, content }
POST   /api/files/create                     → { path, type }
DELETE /api/files/delete                     → { path }
POST   /api/files/rename                     → { oldPath, newPath }
POST   /api/files/move                       → { source, destination }
```

`getTree(projectName)` accepts project name, looks it up via resolveProjectPath internally.

### Security
- Validate all paths are within registered project directories
- Block access to `.git/`, `node_modules/`, `.env` files
- Path traversal prevention (no `../`)

## Frontend (frontend-dev)

### Files
```
src/web/components/explorer/file-tree.tsx
src/web/components/explorer/file-actions.tsx
src/web/components/editor/code-editor.tsx
src/web/components/editor/diff-viewer.tsx
```

### File Tree Component
- Recursive tree rendering with expand/collapse
- Icons per file type (folder, ts, js, json, md, etc.)
- Context menu: New File, New Folder, Rename, Delete, Copy Path
- Click file → open in editor tab
- Select 2 files → "Compare Selected" option in context menu
- Search/filter files (nice-to-have)

### Code Editor (CodeMirror 6)
```typescript
// code-editor.tsx
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion } from '@codemirror/autocomplete';

// Auto-detect language from file extension
const getLanguageExtension = (filename: string) => {
  const ext = filename.split('.').pop();
  // Map ext → @codemirror/lang-* import
};
```

- Auto-save on change (debounced 1s) via `PUT /api/files/write`
- Unsaved indicator in tab title (dot or italic)
- Mobile: CM6 handles touch natively

### Diff Viewer
- Uses `@codemirror/merge` for side-by-side or unified diff
- Opened when comparing 2 files from explorer
- Also used for git diff viewing (Phase 6)

## Success Criteria

- [ ] File tree loads and displays project structure
- [ ] Can create, rename, delete files/folders via context menu
- [ ] Click file opens CodeMirror editor in new tab
- [ ] Editor has syntax highlighting for common languages
- [ ] Auto-save works (debounced)
- [ ] Compare 2 files opens diff view
- [ ] Path traversal blocked (security)
