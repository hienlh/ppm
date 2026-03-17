# Phase 08: Panel Tab Types Reduction

## Overview
- **Priority:** Medium
- **Status:** complete
- **Blocked by:** Phase 07 (sidebar tab system must be complete first)

Remove `projects` and `git-status` from panel tab types. `settings` stays as panel tab (user didn't request moving it). Update all places that open these tabs to use the new sidebar or ProjectBar instead.

## Context Links
- Tab store: `src/web/stores/tab-store.ts`
- Panel store: `src/web/stores/panel-store.ts`
- Mobile nav: `src/web/components/layout/mobile-nav.tsx`
- Mobile drawer: `src/web/components/layout/mobile-drawer.tsx`
- Tab content router: `src/web/components/layout/tab-content.tsx`

## Tab Type Changes

### Before
```typescript
export type TabType =
  | "projects"    // ← REMOVE (replaced by ProjectBar)
  | "terminal"    // keep
  | "chat"        // keep
  | "editor"      // keep
  | "git-graph"   // keep
  | "git-status"  // ← REMOVE (moved to sidebar Git tab)
  | "git-diff"    // keep
  | "settings";   // keep
```

### After
```typescript
export type TabType =
  | "terminal"
  | "chat"
  | "editor"
  | "git-graph"
  | "git-diff"
  | "settings";
```

## Impact Analysis

### Files that reference `"projects"` tab type
- `sidebar.tsx` — `openTab({ type: "projects" })` for "Add Project" button → replace with ProjectBar "+" button (already handled in Phase 03/06)
- `mobile-drawer.tsx` — same → already replaced in Phase 05/07
- `tab-content.tsx` — renders `<ProjectList />` for `projects` type → remove case
- `mobile-nav.tsx` — `TAB_ICONS["projects"]` → remove entry

### Files that reference `"git-status"` tab type
- `mobile-drawer.tsx` — `NEW_TAB_OPTIONS` includes `git-status` → remove
- `tab-content.tsx` — renders `<GitStatusPanel />` for `git-status` type → remove case
- `mobile-nav.tsx` — `TAB_ICONS["git-status"]` → remove entry
- Any `openTab({ type: "git-status" })` calls → redirect to sidebar Git tab instead

### Existing open tabs migration
- On app load: if any persisted tab has type `projects` or `git-status` → close it silently
- Add migration in `panel-store.ts` `switchProject` or on store init

## Related Code Files
- Modify: `src/web/stores/tab-store.ts` — update `TabType`
- Modify: `src/web/stores/panel-store.ts` — tab type references + migration
- Modify: `src/web/components/layout/tab-content.tsx` — remove cases
- Modify: `src/web/components/layout/mobile-nav.tsx` — remove from `TAB_ICONS`
- Modify: `src/web/components/layout/mobile-drawer.tsx` — remove from `NEW_TAB_OPTIONS`
- Check & update: any other `openTab({ type: "git-status" | "projects" })` calls

## Implementation Steps

1. Grep codebase for all `"git-status"` and `"projects"` tab type references
2. Update `TabType` in `tab-store.ts` — remove `"projects"` and `"git-status"`
3. Update `tab-content.tsx` — remove the two render cases
4. Update `mobile-nav.tsx` — remove from `TAB_ICONS` record
5. Update `mobile-drawer.tsx` — remove from `NEW_TAB_OPTIONS`
6. Add migration in panel-store init: filter out obsolete tab types from persisted state
7. Find all `openTab({ type: "git-status" })` calls → replace with logic to focus sidebar Git tab (call `setSidebarActiveTab('git')` from settings-store)
8. Run TypeScript compiler to catch any remaining type errors

## Todo

- [ ] Grep all references to `"git-status"` and `"projects"` tab types
- [ ] Update `TabType` union
- [ ] Update `tab-content.tsx`
- [ ] Update `mobile-nav.tsx` TAB_ICONS
- [ ] Update `mobile-drawer.tsx` NEW_TAB_OPTIONS
- [ ] Add persisted tab migration
- [ ] Replace `openTab("git-status")` calls with sidebar focus
- [ ] TypeScript compile check — no type errors

## Success Criteria
- `TabType` has 6 types only: terminal, chat, editor, git-graph, git-diff, settings
- No TypeScript errors
- No UI breakage — removed tab types don't appear anywhere
- Existing sessions with old tab types load cleanly (migration closes them)

## Risk Assessment
- **Persisted panel state**: `panel-store` likely persists tab state in localStorage. Old tabs with type `projects`/`git-status` will cause type errors on load → migration step is critical.
- **`openTab("git-status")` from GitStatusPanel itself**: The panel opens `git-diff` tabs (not git-status), so no self-reference issue. Check `git-status-panel.tsx` — it calls `openTab({ type: "git-diff" })` and `openTab({ type: "editor" })` — both kept, no issue.
