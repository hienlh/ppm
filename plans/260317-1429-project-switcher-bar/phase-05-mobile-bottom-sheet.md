# Phase 05: Mobile Projects Bottom Sheet

## Overview
- **Priority:** Medium
- **Status:** complete

Add a "Projects" button to `MobileNav` that opens a bottom sheet with project avatars. Thumb-friendly, standard iOS/Android pattern.

## Context Links
- Mobile nav: `src/web/components/layout/mobile-nav.tsx`
- Mobile drawer: `src/web/components/layout/mobile-drawer.tsx`
- Avatar utils: `src/web/lib/project-avatar.ts` (Phase 02)
- Store: `src/web/stores/project-store.ts` (Phase 01)

## Visual Design

```
MobileNav (bottom bar):
┌──────────────────────────────────────┐
│ ☰  │ Chat │ Terminal │ Git │ [Tabs→] │
│    │      │          │     │  ⊞ PJ  │  ← new Projects button (rightmost or after menu)
└──────────────────────────────────────┘

Bottom sheet (slides up):
┌──────────────────────────────────────┐
│              ────                    │  ← drag handle
│  Projects                      ✕    │
│                                      │
│  ● PP   my-project  (active ✓)       │
│  ● MP   mobile-app                   │
│  ● A    api-server                   │
│                                      │
│  + Add Project                       │
│  ─────────────────────────────────── │
│  ⚙️  Settings          v1.2.3        │
└──────────────────────────────────────┘
```

## Requirements

### MobileNav changes
- [ ] Add "Projects" icon button (e.g. `Layers` or `FolderOpen` from lucide) to nav bar
- [ ] Tapping opens bottom sheet (does NOT open the left drawer)
- [ ] Show active project name or avatar as indicator on the button

### ProjectBottomSheet component (`project-bottom-sheet.tsx`)
- [ ] Slides up from bottom (`translate-y` transition)
- [ ] Backdrop click → close
- [ ] Drag handle at top (visual only)
- [ ] Scrollable project list with circular avatars (reuse avatar logic from Phase 02)
- [ ] Each row: avatar + project name + active checkmark
- [ ] Tap project → `setActiveProject` + close sheet
- [ ] Long-press project row → context menu (rename, delete, change color, move up/down) — same actions as desktop
- [ ] "Add Project" button at bottom of list
- [ ] Settings link + version at footer

### Mobile drawer changes
- [ ] Remove the project picker from `MobileDrawer` bottom section (replaced by bottom sheet)
- [ ] Keep file tree, new tab buttons, bug report

## Related Code Files
- Create: `src/web/components/layout/project-bottom-sheet.tsx`
- Modify: `src/web/components/layout/mobile-nav.tsx`
- Modify: `src/web/components/layout/mobile-drawer.tsx`
- Modify: `src/web/app.tsx` — pass `projectSheetOpen` state + handler to `MobileNav`

## Implementation Steps

1. Create `ProjectBottomSheet` component
   - Overlay + slide-up sheet with `translate-y` transition
   - Render project list with avatars (reuse `getProjectAvatar`)
   - Active indicator + tap to switch
   - Long-press → action sheet (similar to existing tab long-press pattern in `mobile-nav.tsx`)
   - Footer: Add Project + Settings + version
2. Add `projectSheetOpen` state to `App` component
3. Pass `onProjectsPress` callback to `MobileNav`
4. Add Projects button to `MobileNav` (show active project initial as badge)
5. Remove project picker from `MobileDrawer` bottom section

## Todo

- [ ] `ProjectBottomSheet` component
- [ ] Slide-up animation
- [ ] Project list with avatars
- [ ] Long-press context menu
- [ ] Footer actions
- [ ] Add Projects button to `MobileNav`
- [ ] Wire state in `app.tsx`
- [ ] Remove project picker from `MobileDrawer`

## Success Criteria
- Bottom sheet opens/closes smoothly from `MobileNav`
- Project switch works and closes sheet
- All CRUD actions accessible via long-press
- Thumb-friendly: all interactive elements in bottom 60% of sheet

## Risk Assessment
- **`MobileNav` already has many buttons** — may need to shrink or reorganize. Consider replacing the `☰` menu button label to just icon, or grouping.
- **Animation**: use `translate-y-full` → `translate-y-0` with `transition-transform duration-300` (same pattern as `MobileDrawer`)
