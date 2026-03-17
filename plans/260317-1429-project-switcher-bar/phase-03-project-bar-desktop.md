# Phase 03: ProjectBar Component (Desktop)

## Overview
- **Priority:** High
- **Status:** complete

Create `src/web/components/layout/project-bar.tsx` — narrow (~52px), non-collapsible vertical bar on the far left. Shows project avatars, context menu for CRUD, version + settings at bottom.

## Context Links
- Avatar utils: `src/web/lib/project-avatar.ts` (Phase 02)
- Store: `src/web/stores/project-store.ts` (Phase 01)
- App layout: `src/web/app.tsx`
- Settings store: `src/web/stores/settings-store.ts`

## Visual Design

```
┌────┐
│    │  ← 52px wide, full height, bg-surface border-r
│ PP │  ← active project avatar (ring indicator)
│    │
│ MP │  ← other project
│ A  │
│    │
│ +  │  ← add project button
│    │
│    │  ← flex-1 spacer
│    │
│v1.2│  ← version (rotated text or tiny)
│ ⚙️ │  ← settings button
└────┘
```

## Requirements

### Functional
- [ ] List all projects as circular avatars (40px diameter)
- [ ] Active project: primary color ring (`ring-2 ring-primary`)
- [ ] Tooltip on hover: full project name + path
- [ ] Click → `setActiveProject`
- [ ] Right-click → context menu: Rename, Delete, Change Color, Move Up, Move Down
- [ ] "+" button → opens projects tab (existing `openTab({ type: 'projects' })`)
- [ ] Bottom: version text (tiny, rotated 90° or just tiny font) + Settings gear
- [ ] Overflow: scroll when projects exceed height
- [ ] Only visible on `md:` and above (`hidden md:flex`)

### Context Menu
```
┌─────────────────┐
│ Rename          │
│ Change Color    │
│ ─────────────── │
│ Move Up         │
│ Move Down       │
│ ─────────────── │
│ Delete          │  ← red color
└─────────────────┘
```

### Color Picker (inline in context menu or popover)
- Show 8–10 preset swatches (generated via `hashProjectColor` variants)
- "Custom" option opens `<input type="color">`

## Related Code Files
- Create: `src/web/components/layout/project-bar.tsx`
- Modify: `src/web/app.tsx` — add `<ProjectBar />` before `<Sidebar />`

## Implementation Steps

1. Create `ProjectBar` component skeleton (`hidden md:flex flex-col w-13 ...`)
2. Render scrollable project avatar list using `resolveOrder` from store
3. Add `Tooltip` wrapper (shadcn) for project name on hover
4. Add active ring indicator
5. Implement right-click context menu using shadcn `ContextMenu`
6. Implement color picker popover (preset swatches + custom input)
7. Add "+" button at bottom of list
8. Add version + settings at very bottom
9. Wire up all store actions (setActiveProject, moveProject, renameProject, deleteProject, setProjectColor)
10. Add `<ProjectBar />` to `app.tsx` before `<Sidebar />`

## Todo

- [ ] Component skeleton + layout
- [ ] Avatar list with scroll
- [ ] Tooltip
- [ ] Active ring
- [ ] Context menu
- [ ] Color picker
- [ ] "+" button
- [ ] Version + Settings footer
- [ ] Wire store actions
- [ ] Add to app.tsx

## Success Criteria
- Bar renders on desktop, hidden on mobile
- All CRUD actions work via context menu
- Active project visually distinct
- Scroll works when many projects

## Risk Assessment
- **Rename UX**: inline edit vs dialog — use a small Dialog (shadcn) for rename to avoid complex inline state
- **Delete confirmation**: always show a confirm dialog before delete
