# Brainstorm: File Browser Picker for Path Inputs

**Date**: 2026-03-19
**Status**: Agreed

## Problem Statement

PPM has 4+ path input fields (DirSuggest, AddProjectForm, ConnectionFormDialog SQLite, SettingsTab) where users must type paths manually. No visual browsing. Need Finder/Explorer-like picker that works desktop + mobile.

**Constraint**: PPM is web app — no native OS file picker API. Must build custom in-browser file browser backed by server API.

## Agreed Solution

### Backend: `GET /api/fs/browse`

New system-level endpoint (NOT project-scoped).

**Params:**
- `path: string` — directory to list (default: `~`)
- `showHidden: boolean` — show dotfiles (default: false)

**Response:**
```ts
{
  entries: { name: string; path: string; type: "file"|"directory"; size?: number; modified: string }[];
  current: string;          // resolved absolute path
  parent: string | null;    // null if at filesystem root
  breadcrumbs: { name: string; path: string }[];
}
```

**Security — Whitelist Roots:**
- Allowed: `~`, `/Volumes`, `/mnt`, `/media`, drive roots on Windows
- Blocked: `/etc`, `/sys`, `/proc`, sensitive files (`.env*`, `.git` contents)
- All paths resolved & validated server-side
- Flat listing only (1 level per request) — no recursive tree

### Frontend: `<FileBrowserPicker>`

Responsive container:
- Desktop (>768px): `<Dialog>` centered modal
- Mobile (<768px): `<Sheet>` bottom sheet, swipe-up expandable

**Layout:**
```
┌──────────────────────────────────────────┐
│ [← ] ~/Projects/my-app    [📁 path bar ]│
│ ─────────────────────────────────────────│
│ ⭐ Quick │  Name           Size   Modified│
│ ~ Home   │  📁 src/        —      2h ago │
│ 📁 Desk  │  📁 docs/       —      1d ago │
│ 📁 Down  │  📄 index.ts    2.1KB  3h ago │
│ 📁 Docs  │  📄 data.db     50KB   1h ago │
│ 🕐Recent │                               │
│ ─────────────────────────────────────────│
│ Filter: *.db, *.sqlite   [🔍 search...] │
│                    [ Cancel ] [ Select ] │
└──────────────────────────────────────────┘
```

**Props:**
```ts
interface FileBrowserPickerProps {
  mode: "file" | "folder" | "both";
  accept?: string[];          // e.g. [".db", ".sqlite", ".sqlite3"]
  root?: string;              // starting directory (default: "~")
  onSelect: (path: string) => void;
  onCancel: () => void;
  open: boolean;
}
```

**Features:**
1. **Breadcrumb navigation** — click segment to jump to ancestor
2. **Search/filter** — filter entries in current folder by name
3. **Quick access sidebar** — Home, Desktop, Documents, Downloads + recent paths (localStorage)
4. **Path input bar** — type/paste absolute path, Enter to navigate
5. **Extension filter** — dims non-matching files based on `accept` prop
6. **3 modes** — `file` (only files selectable), `folder` (only folders), `both`

### Trigger: `<BrowseButton>`

Small icon button (FolderOpen) placed next to path inputs. Opens picker, returns selected path.

### Integration Map

| Component | Mode | Accept | Root |
|-----------|------|--------|------|
| `DirSuggest` | `folder` | — | `~` |
| `AddProjectForm` | `folder` (via DirSuggest) | — | `~` |
| `ConnectionFormDialog` (SQLite) | `file` | `.db,.sqlite,.sqlite3` | `~` |
| Future path inputs | configurable | configurable | configurable |

## Alternatives Evaluated

| Approach | Verdict | Reason |
|----------|---------|--------|
| **Custom Browser** | ✅ Chosen | Full control, works everywhere, native-like UX |
| **Browser File System Access API** | ❌ Rejected | Chrome-only, returns File blob not path, security sandbox |
| **`<input type="file">`** | ❌ Rejected | Returns File blob, not filesystem path |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Large dirs (node_modules) | Flat listing, skip known heavy dirs, lazy load |
| Security — arbitrary FS access | Whitelist roots, block sensitive paths server-side |
| Performance | 1-level-per-request, no recursive tree |
| Cross-platform | `node:path` on server, handle Windows `C:\` drives |

## File Impact

**New files:**
- `src/services/fs-browse.service.ts` — system-level directory listing service
- `src/server/routes/fs-browse.ts` — API route
- `src/web/components/ui/file-browser-picker.tsx` — main picker component
- `src/web/components/ui/browse-button.tsx` — trigger button

**Modified files:**
- `src/web/components/projects/dir-suggest.tsx` — add BrowseButton
- `src/web/components/database/connection-form-dialog.tsx` — add BrowseButton for SQLite path
- `src/server/index.ts` or route registration — mount new route

## Success Criteria

- All path inputs have a browse button
- Picker opens, navigates folders, selects file/folder, returns path
- Extension filtering works for SQLite use case
- Responsive: Dialog on desktop, Sheet on mobile
- Quick access sidebar with recent paths
- Path input bar for direct navigation
- Security: cannot browse outside whitelisted roots
