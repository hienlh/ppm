# Phase 06: Sidebar Cleanup

## Overview
- **Priority:** Low (cosmetic, after phases 3+5 done)
- **Status:** complete

Remove the project dropdown from the top of `sidebar.tsx` since `ProjectBar` (desktop) and `ProjectBottomSheet` (mobile) now handle project switching. Simplify the sidebar header.

## Context Links
- Sidebar: `src/web/components/layout/sidebar.tsx`
- Mobile drawer: `src/web/components/layout/mobile-drawer.tsx`

## Current Sidebar Header (to remove)
```tsx
<div className="flex items-center gap-2 px-3 h-[41px] border-b border-border shrink-0">
  <span>PPM</span>
  {deviceName && <span>...</span>}
  <DropdownMenu>  {/* ← REMOVE THIS */}
    ...project picker...
  </DropdownMenu>
</div>
```

## Target Sidebar Header (simplified)
```tsx
<div className="flex items-center gap-2 px-3 h-[41px] border-b border-border shrink-0">
  {/* Just show active project name as plain text label */}
  <span className="text-xs font-semibold text-text-secondary truncate flex-1">
    {activeProject?.name ?? "No project"}
  </span>
  <button onClick={toggleSidebar}>  {/* collapse button */}
    <PanelLeftClose />
  </button>
</div>
```

## Requirements

- [ ] Remove `DropdownMenu` import + project picker from `sidebar.tsx` header
- [ ] Remove `DropdownMenuContent`, `DropdownMenuSeparator`, `DropdownMenuTrigger` imports if unused
- [ ] Remove `query`, `filtered`, `showSearch`, `handleAddProject` state/logic no longer needed
- [ ] Keep: `deviceName` badge, collapse button, `PanelLeftClose`/`PanelLeftOpen` icons
- [ ] Show active project name as static text (breadcrumb-style)
- [ ] Mobile drawer: project picker already removed in Phase 05 — verify no leftover imports

## Related Code Files
- Modify: `src/web/components/layout/sidebar.tsx`
- Verify: `src/web/components/layout/mobile-drawer.tsx` (Phase 05 cleanup complete)

## Implementation Steps

1. Remove `DropdownMenu*` imports from `sidebar.tsx`
2. Remove `query`, `filtered`, `showSearch`, `sorted`, `handleAddProject` logic
3. Replace dropdown trigger with static project name label
4. Remove `FolderOpen`, `ChevronDown`, `Check`, `Search`, `Plus` icon imports if no longer used
5. Verify sidebar still shows correct active project name on switch
6. Verify collapsed state still works

## Todo

- [ ] Remove dropdown + related logic from sidebar
- [ ] Simplify header to static label
- [ ] Clean up unused imports
- [ ] Verify collapse still works

## Success Criteria
- Sidebar header is clean — just project name + collapse button
- No dead code or unused imports remain
- Sidebar still reflects active project when switched via ProjectBar
