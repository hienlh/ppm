# Phase 04: Keep-Alive Workspace Switching

## Overview
- **Priority:** High
- **Status:** complete

Change project switching from full re-render to CSS hide/show. Each workspace is lazily mounted on first visit and never unmounted.

## Context Links
- App layout: `src/web/app.tsx`
- Store: `src/web/stores/project-store.ts`
- Panel layout: `src/web/components/layout/panel-layout.tsx`

## Current Behavior

```
activeProject changes → React re-renders PanelLayout + Sidebar
→ terminal buffer lost, chat scroll lost, editor state lost
```

## Target Behavior

```
First visit to project → mount WorkspaceContainer for that project
Subsequent visits     → CSS show (remove `hidden`)
Leave project         → CSS hide (add `hidden`), DOM kept alive
```

## Architecture

### WorkspaceContainer pattern
```tsx
// app.tsx
const [mountedProjects, setMountedProjects] = useState<Set<string>>(new Set())

// When activeProject changes, add to mounted set (never remove)
useEffect(() => {
  if (activeProject) {
    setMountedProjects(prev => new Set([...prev, activeProject.name]))
  }
}, [activeProject?.name])

// Render all mounted workspaces, hide inactive
{[...mountedProjects].map(projectName => (
  <div
    key={projectName}
    className={cn(
      "flex-1 overflow-hidden pb-12 md:pb-0",
      activeProject?.name !== projectName && "hidden"
    )}
  >
    <PanelLayout projectName={projectName} />
  </div>
))}
```

### __global__ workspace
- When no project is selected, a `__global__` workspace is shown (existing behavior)
- Add `__global__` to initial mounted set

## Requirements

- [ ] `mountedProjects` state in `app.tsx` — Set of project names
- [ ] Mount on first activation, never unmount
- [ ] `PanelLayout` receives `projectName` prop (already scoped per project via panel-store)
- [ ] `__global__` workspace always pre-mounted
- [ ] `Sidebar` shows file tree for active project (unchanged — already reads from `activeProject`)

## Related Code Files
- Modify: `src/web/app.tsx`
- Minor check: `src/web/components/layout/panel-layout.tsx` (verify no issues with multiple instances)

## Implementation Steps

1. Add `mountedProjects` state (Set) to `App` component, init with `__global__`
2. `useEffect` on `activeProject` → add to `mountedProjects`
3. Replace single `<main>` with mapped workspace divs, `hidden` when not active
4. Verify `PanelLayout` works correctly when rendered multiple times (check panel-store scoping)
5. Test: switch projects → switch back → confirm tab state preserved

## Todo

- [ ] Add `mountedProjects` state
- [ ] Mount-on-first-visit effect
- [ ] Replace `<main>` with keep-alive map
- [ ] Verify panel-store isolation per project
- [ ] Manual smoke test: state preservation

## Success Criteria
- Switch away and back to a project → tabs, scroll position, chat messages preserved
- No memory leak (Set only grows, bounded by number of projects user visits)

## Risk Assessment
- **Panel-store scoping**: `panel-store` already has `switchProject(projectName)` — verify it doesn't conflict when multiple `PanelLayout` instances exist simultaneously. May need to pass `projectName` as a prop context.
- **Sidebar**: currently reads `activeProject` from store — unaffected, keep as-is.
