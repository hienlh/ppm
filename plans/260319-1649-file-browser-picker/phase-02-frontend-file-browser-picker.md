# Phase 2: Frontend — FileBrowserPicker Component

## Context

- [Brainstorm report](../reports/brainstorm-260319-1649-file-browser-picker.md)
- [Phase 1: Backend API](./phase-01-backend-fs-browse.md) — `GET /api/fs/browse`
- Existing `project-bottom-sheet.tsx` — custom sheet pattern reference
- Existing `dir-suggest.tsx` — current path autocomplete UX
- Existing shadcn/ui: Dialog, Input, Button, ScrollArea, Separator

## Overview

- **Priority**: P1
- **Status**: Pending
- **Effort**: 3h
- Build a responsive file browser picker: Dialog (desktop) + Bottom Sheet (mobile)
- Features: breadcrumb nav, search, quick access sidebar, path input bar, extension filter, 3 modes

## Requirements

### Functional
- **3 modes**: `file` (only files selectable), `folder` (only folders), `both`
- **Extension filter**: `accept` prop dims/hides non-matching files (folders always visible for navigation)
- **Breadcrumb nav**: click any segment to jump to ancestor directory
- **Search**: filter entries in current folder by name (client-side)
- **Quick access sidebar**: Home, Desktop, Documents, Downloads + recent paths from localStorage
- **Path input bar**: type/paste absolute path, Enter to navigate
- **Responsive**: Dialog on desktop (>768px), Bottom Sheet on mobile
- **Double-click folder** to navigate into it, **single-click** to select (in folder/both mode)
- **Single-click file** to select (in file/both mode)
- **Back button** to navigate to parent directory

### Non-functional
- Smooth navigation (loading state while fetching)
- Keyboard accessible (Tab, Enter, Escape)
- Max height: 70vh (dialog), 85vh (sheet)

## Architecture

```
<FileBrowserPicker>
├── <ResponsiveContainer>  (Dialog or Sheet based on viewport)
│   ├── <PathInputBar>     (type/paste path + Enter to navigate)
│   ├── <Breadcrumbs>      (clickable path segments)
│   ├── <div class="flex">
│   │   ├── <QuickAccess>  (sidebar: favorites + recent, hidden on mobile)
│   │   └── <EntryList>    (file/folder listing with icons, search, filter)
│   └── <Footer>           (filter badge, search input, Cancel/Select buttons)
```

### State Management

```typescript
// Component-local state (no Zustand needed — picker is modal)
const [currentPath, setCurrentPath] = useState(root ?? "~");
const [entries, setEntries] = useState<BrowseEntry[]>([]);
const [loading, setLoading] = useState(false);
const [search, setSearch] = useState("");
const [selected, setSelected] = useState<string | null>(null);
const [pathInput, setPathInput] = useState("");
const [error, setError] = useState<string | null>(null);
const [recentPaths, setRecentPaths] = useLocalStorage<string[]>("ppm-recent-paths", []);
```

### Data Flow

```
User opens picker
  → fetchEntries(root ?? "~")
  → GET /api/fs/browse?path=~
  → setEntries(result.entries), setBreadcrumbs(result.breadcrumbs)

User clicks folder
  → fetchEntries(folder.path)
  → update breadcrumbs, currentPath

User clicks file/folder (selectable based on mode)
  → setSelected(entry.path)
  → highlight entry

User clicks "Select"
  → onSelect(selected)
  → save currentPath to recentPaths
  → close picker
```

## Related Code Files

### Create
- `src/web/components/ui/file-browser-picker.tsx` — main component (all sub-components in same file, extracted later if > 200 LOC)

### Reference (read only)
- `src/web/components/layout/project-bottom-sheet.tsx` — custom sheet pattern
- `src/web/components/ui/dialog.tsx` — shadcn dialog
- `src/web/components/ui/scroll-area.tsx` — for entry list scrolling
- `src/web/components/ui/input.tsx` — for search/path input
- `src/web/components/projects/dir-suggest.tsx` — keyboard navigation pattern

## Implementation Steps

### 1. API client helper

Add to existing `src/web/lib/api-client.ts` or inline in component:

```typescript
interface BrowseEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified: string;
}

interface BrowseResult {
  entries: BrowseEntry[];
  current: string;
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
}

async function fetchBrowse(path?: string, showHidden?: boolean): Promise<BrowseResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("showHidden", "true");
  return api.get<BrowseResult>(`/api/fs/browse?${params}`);
}
```

### 2. Create `file-browser-picker.tsx`

**Props interface:**

```typescript
export interface FileBrowserPickerProps {
  open: boolean;
  mode: "file" | "folder" | "both";
  accept?: string[];           // e.g. [".db", ".sqlite"]
  root?: string;               // starting directory (default "~")
  title?: string;              // dialog title (default "Select File" / "Select Folder")
  onSelect: (path: string) => void;
  onCancel: () => void;
}
```

**Component structure** (key sections):

#### a) Responsive container
```tsx
// Use window.innerWidth or matchMedia to decide
const isMobile = useMediaQuery("(max-width: 768px)");

// Desktop: shadcn Dialog
// Mobile: custom bottom sheet (similar to project-bottom-sheet.tsx)
// Share inner content, swap wrapper only
```

Use existing `useMediaQuery` pattern from `panel-utils.ts` or similar. If none exists, simple inline hook:
```typescript
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return mobile;
}
```

#### b) Path input bar (top)
- Input field showing current path, editable
- On Enter: navigate to typed path (call fetchBrowse)
- On error: show inline error message, don't navigate

#### c) Breadcrumbs
- Map `breadcrumbs` from API response to clickable buttons
- `~` shows as home icon + "~"
- Click any segment → fetchBrowse(segment.path)
- Overflow: horizontal scroll on mobile

#### d) Quick access sidebar (desktop only)
```typescript
const QUICK_ACCESS = [
  { name: "Home", path: "~", icon: Home },
  { name: "Desktop", path: "~/Desktop", icon: Monitor },
  { name: "Documents", path: "~/Documents", icon: FileText },
  { name: "Downloads", path: "~/Downloads", icon: Download },
];
// + recentPaths from localStorage (last 5)
```
- Click → navigate to that path
- Recent: stored as `string[]` in localStorage key `ppm-recent-paths`
- Hidden on mobile to save space (or collapsible)

#### e) Entry list (main area)
- ScrollArea with virtual scrolling if > 100 entries (optional, optimize later)
- Each entry row:
  - Icon: `Folder` or file type icon (use lucide `File`, `Database` for .db/.sqlite)
  - Name (bold for directories)
  - Size (formatted: KB/MB) — files only
  - Modified (relative: "2h ago", "3d ago")
  - Click behavior:
    - **Directory**: single-click navigates into it (in `file` mode), or selects it (in `folder`/`both` mode) — double-click always navigates
    - **File**: single-click selects (in `file`/`both` mode), disabled/dimmed in `folder` mode
- Selected entry highlighted with `bg-primary/10 border-primary`

**Extension filtering logic:**
```typescript
const visibleEntries = entries.filter(entry => {
  // Search filter
  if (search && !entry.name.toLowerCase().includes(search.toLowerCase())) return false;
  // Extension filter: only applies to files
  if (accept?.length && entry.type === "file") {
    const ext = "." + entry.name.split(".").pop()?.toLowerCase();
    return accept.includes(ext);
  }
  return true;
});
```

Directories always visible (user needs to navigate). Non-matching files hidden (not just dimmed — cleaner UX for targeted selection like .db files).

#### f) Footer
- Left: extension filter badge showing active filter (e.g. "*.db, *.sqlite")
- Center: search input (compact, icon + text)
- Right: Cancel button + Select button (disabled if nothing selected)

### 3. localStorage for recent paths

```typescript
// On successful select:
const saveRecent = (path: string) => {
  const dir = isFile ? dirname(path) : path;  // save the directory, not the file
  const updated = [dir, ...recentPaths.filter(p => p !== dir)].slice(0, 5);
  setRecentPaths(updated);
  localStorage.setItem("ppm-recent-paths", JSON.stringify(updated));
};
```

### 4. Mobile bottom sheet wrapper

Reference `project-bottom-sheet.tsx` pattern:
- Fixed overlay with backdrop blur
- Slide-up animation
- Drag handle at top (optional)
- Max height 85vh
- Content same as dialog inner

### 5. Keyboard navigation

- `Escape` → close picker
- `Enter` → select highlighted entry (or navigate if folder)
- `ArrowUp/Down` → move selection in entry list
- `Backspace` (when path input not focused) → go to parent dir
- `Tab` → cycle between path input, search, entry list, buttons

## Todo List

- [ ] Create types: `BrowseEntry`, `BrowseResult`, `FileBrowserPickerProps`
- [ ] Implement `useIsMobile()` hook (or reuse existing)
- [ ] Build path input bar with Enter-to-navigate
- [ ] Build breadcrumb navigation
- [ ] Build quick access sidebar with recent paths (localStorage)
- [ ] Build entry list with icons, size, modified, selection
- [ ] Implement extension filtering logic
- [ ] Build search input for current folder
- [ ] Build footer with Cancel/Select buttons
- [ ] Responsive wrapper: Dialog (desktop) vs Sheet (mobile)
- [ ] Keyboard navigation (Escape, Enter, ArrowUp/Down)
- [ ] Loading state + error handling

## Success Criteria

- Picker opens and displays entries from home dir
- Click folder to navigate into it
- Click file/folder to select, click Select to confirm
- Breadcrumbs work for jumping to ancestors
- Search filters entries in current folder
- Extension filter hides non-matching files
- Quick access shows Home/Desktop/Documents/Downloads + recent
- Path input bar allows typing absolute path to navigate
- Responsive: Dialog on desktop, Sheet on mobile
- Keyboard accessible

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Component > 200 LOC | Maintainability | Extract sub-components (Breadcrumbs, EntryList, QuickAccess) into same file initially, split if needed |
| Slow for large dirs | UX | Loading spinner, entries already server-sorted, client filter is fast |
| No Sheet in shadcn/ui | Extra work | Reference project-bottom-sheet.tsx custom pattern, minimal CSS |

## Security Considerations

- No direct file content access — picker only shows metadata
- Paths come from trusted server API (already whitelist-validated)
- localStorage only stores directory paths (no secrets)
