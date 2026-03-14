---
phase: 3
title: "Per-project tab storage"
status: pending
effort: 1.5h
depends_on: []
---

# Phase 3: Per-Project Tab Storage

## Context
- [plan.md](./plan.md)
- `src/web/stores/tab-store.ts` -- current global tab store
- `src/web/stores/project-store.ts` -- project selection
- `src/web/app.tsx` -- default tab opening logic

## Overview
Make tabs project-scoped: each project gets its own tab set persisted under `ppm-tabs-{projectName}`. When user switches project, the tab bar swaps to that project's tabs.

## Key Design Decision
**Approach: Dynamic storage key** -- Zustand `persist` middleware does not natively support dynamic keys. Two options:

**Option A (chosen): Manual localStorage swap.** On project change, serialize current tabs to `ppm-tabs-{oldProject}`, load from `ppm-tabs-{newProject}`, hydrate store. Simple, no lib changes.

**Option B (rejected): Multiple store instances.** One store per project. Over-engineered for this use case.

## Related Code Files

### Files to modify
- `src/web/stores/tab-store.ts` -- add project-aware persist, swap logic
- `src/web/app.tsx` -- pass project context on default tab, react to project switch

## Implementation Steps

### 1. Refactor tab-store.ts

Remove Zustand `persist` middleware. Replace with manual localStorage read/write:

```ts
const STORAGE_PREFIX = "ppm-tabs-";

function storageKey(projectName: string): string {
  return `${STORAGE_PREFIX}${projectName}`;
}

function loadTabs(projectName: string): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const raw = localStorage.getItem(storageKey(projectName));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { tabs: [], activeTabId: null };
}

function saveTabs(projectName: string, state: { tabs: Tab[]; activeTabId: string | null }) {
  localStorage.setItem(storageKey(projectName), JSON.stringify(state));
}
```

Add to store:
```ts
interface TabStore {
  // existing...
  currentProject: string | null;
  switchProject: (projectName: string) => void;
}
```

`switchProject(newProject)`:
1. If `currentProject` exists, save current tabs to localStorage under old key
2. Load tabs from new key
3. Set `currentProject = newProject`, hydrate tabs
4. If no tabs loaded, open default "Projects" tab

### 2. Auto-save on tab mutations
After every `openTab`, `closeTab`, `setActiveTab`, `updateTab` -- call `saveTabs(currentProject, { tabs, activeTabId })`. Use Zustand `subscribe` to batch this.

### 3. Update app.tsx
- On project change (when `activeProject` changes), call `useTabStore.getState().switchProject(activeProject.name)`
- Remove the "open default tab if none" effect -- let `switchProject` handle defaults

### 4. Clean up old storage
- Remove old `ppm-tabs` key migration: not needed on v2-fresh-start branch

### 5. Fix nextId collision
Current `nextId` is a module-level counter. On project switch, tabs from different projects may have overlapping IDs. Fix: derive nextId from loaded tabs on every switch.

## Todo List
- [ ] Remove `persist` middleware from tab-store
- [ ] Add manual localStorage read/write functions
- [ ] Add `currentProject` and `switchProject` to store
- [ ] Add `subscribe` auto-save
- [ ] Update `app.tsx` to call `switchProject` on project change
- [ ] Fix nextId derivation on hydration
- [ ] Test: switch project -> tabs change, switch back -> original tabs restored

## Success Criteria
- Each project has independent tab state in localStorage
- Switching project instantly swaps visible tabs
- Closing all tabs in project A does not affect project B
- Default "Projects" tab opens if project has no saved tabs
