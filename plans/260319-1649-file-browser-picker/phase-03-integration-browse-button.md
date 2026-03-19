# Phase 3: Integration — BrowseButton + Wire into Consumers

## Context

- [Phase 1: Backend API](./phase-01-backend-fs-browse.md)
- [Phase 2: FileBrowserPicker](./phase-02-frontend-file-browser-picker.md)
- Consumers: `dir-suggest.tsx`, `connection-form-dialog.tsx`

## Overview

- **Priority**: P1
- **Status**: Pending
- **Effort**: 1.5h
- Create reusable `<BrowseButton>` trigger, integrate picker into existing path input components

## Requirements

### Functional
- Small icon button (FolderOpen) next to path inputs
- Opens FileBrowserPicker with appropriate mode/accept/root
- Returns selected path to the input's onChange handler
- Works alongside existing autocomplete (DirSuggest) — not replacing it

### Non-functional
- Button style consistent with existing UI (ghost/outline, matching input height)
- No layout shift when adding button

## Related Code Files

### Create
- `src/web/components/ui/browse-button.tsx` — reusable trigger button

### Modify
- `src/web/components/projects/dir-suggest.tsx` — add BrowseButton (folder mode)
- `src/web/components/database/connection-form-dialog.tsx` — add BrowseButton for SQLite path (file mode, accept .db/.sqlite/.sqlite3)

### Reference
- `src/web/components/layout/add-project-form.tsx` — uses DirSuggest (auto-inherits BrowseButton)

## Implementation Steps

### 1. Create `src/web/components/ui/browse-button.tsx`

```tsx
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileBrowserPicker, type FileBrowserPickerProps } from "./file-browser-picker";

interface BrowseButtonProps {
  mode: FileBrowserPickerProps["mode"];
  accept?: string[];
  root?: string;
  title?: string;
  onSelect: (path: string) => void;
  /** Additional className for the button */
  className?: string;
}

export function BrowseButton({ mode, accept, root, title, onSelect, className }: BrowseButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("size-8 shrink-0", className)}
        onClick={() => setOpen(true)}
        title={title ?? "Browse..."}
      >
        <FolderOpen className="size-4" />
      </Button>
      <FileBrowserPicker
        open={open}
        mode={mode}
        accept={accept}
        root={root}
        title={title}
        onSelect={(path) => { onSelect(path); setOpen(false); }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
```

### 2. Integrate into `dir-suggest.tsx`

**Current layout** (line 106-150):
```tsx
<div className="relative">
  <div className="relative">
    <Input ... />
    {loading && <Loader2 ... />}
  </div>
  {/* suggestions dropdown */}
</div>
```

**New layout**: Wrap input + button in flex container:
```tsx
<div className="relative">
  <div className="flex gap-1.5 items-center">
    <div className="relative flex-1">
      <Input ... />
      {loading && <Loader2 ... />}
    </div>
    <BrowseButton
      mode="folder"
      onSelect={(path) => {
        onChange(path);
        onSelect?.({ path, name: path.split("/").pop() ?? path });
      }}
    />
  </div>
  {/* suggestions dropdown unchanged */}
</div>
```

**Impact**: `AddProjectForm` uses `DirSuggest` — auto-inherits BrowseButton. No changes needed in `add-project-form.tsx`.

### 3. Integrate into `connection-form-dialog.tsx`

**Current SQLite path input** (lines 162-170):
```tsx
<div>
  <label className="text-xs font-medium text-text-secondary mb-1 block">File Path *</label>
  <input
    value={form.path}
    onChange={(e) => set("path", e.target.value)}
    placeholder="/path/to/database.db"
    className="w-full h-8 text-sm px-2.5 rounded-md border ..."
  />
</div>
```

**New layout**: Add BrowseButton next to input:
```tsx
<div>
  <label className="text-xs font-medium text-text-secondary mb-1 block">File Path *</label>
  <div className="flex gap-1.5 items-center">
    <input
      value={form.path}
      onChange={(e) => set("path", e.target.value)}
      placeholder="/path/to/database.db"
      className="flex-1 h-8 text-sm px-2.5 rounded-md border ..."
    />
    <BrowseButton
      mode="file"
      accept={[".db", ".sqlite", ".sqlite3"]}
      title="Browse for SQLite database"
      onSelect={(path) => set("path", path)}
    />
  </div>
</div>
```

## Todo List

- [ ] Create `src/web/components/ui/browse-button.tsx`
- [ ] Modify `src/web/components/projects/dir-suggest.tsx` — add BrowseButton (folder mode)
- [ ] Modify `src/web/components/database/connection-form-dialog.tsx` — add BrowseButton (file mode, .db/.sqlite/.sqlite3)
- [ ] Verify AddProjectForm auto-inherits via DirSuggest
- [ ] Test: open picker from DirSuggest, select folder, path populates
- [ ] Test: open picker from ConnectionFormDialog, select .db file, path populates
- [ ] Test: extension filter hides non-.db files in SQLite picker

## Success Criteria

- BrowseButton appears next to every path input
- Clicking opens FileBrowserPicker with correct mode and filters
- Selecting a path populates the input field
- No visual regression — button fits naturally alongside inputs
- AddProjectForm inherits BrowseButton through DirSuggest

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Layout shift from adding button | Visual regression | Use flex + gap, button is fixed 32px (size-8) |
| DirSuggest dropdown z-index conflict with picker | UI overlap | Picker is modal (Dialog/Sheet) — always on top |
| BrowseButton re-renders parent on open/close | Performance | Picker state is local to BrowseButton, no parent re-render |

## Next Steps

After this phase:
- Run `bun build` to verify no compile errors
- Manual testing of all 3 integration points
- Consider adding BrowseButton to SettingsTab path inputs (future)
