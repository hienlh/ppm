# Phase 01: Store Extensions

## Overview
- **Priority:** High (blocks phases 2, 3, 4)
- **Status:** complete

Extend `ProjectConfig` type + backend to support `color` field persisted in YAML config. Add custom ordering (move up/down) + rename/delete API calls. Colors are server-side — consistent across devices.

## Context Links
- Config type: `src/types/config.ts`
- Config service: `src/services/config.service.ts`
- Projects route: `src/server/routes/projects.ts`
- Frontend store: `src/web/stores/project-store.ts`

## Key Insights
- `ProjectConfig` currently: `{ path, name }` — add `color?: string`
- Config has `save()` → writing color back is straightforward
- Current order = "recently used" from localStorage — layer "manual order" on top (can stay localStorage since order is per-device UX, color is shared identity)
- Colors come from API with project list → no localStorage for color
- Predefined palette used as fallback (by project index, cycling)

## Color Strategy

```
Priority:
1. project.color in config.yaml → use it
2. No color set → predefined_palette[project_index % palette.length]

Palette (12 colors, defined in shared lib):
['#4f86c6', '#e05d5d', '#56b87a', '#e0a03d',
 '#9b6be0', '#e06b9b', '#4ab8c1', '#b8914a',
 '#7b9e3e', '#c15f3e', '#5e7fc1', '#a05ec1']
```

## Requirements

### Backend changes
- [ ] Add `color?: string` to `ProjectConfig` interface in `src/types/config.ts`
- [ ] `PATCH /api/projects/:name/color` — update project color in config + save
- [ ] `PATCH /api/projects/:name` — rename project (update name in config + save)
- [ ] `DELETE /api/projects/:name` — remove project from config + save
- [ ] `PATCH /api/projects/reorder` — update project order in config + save
- [ ] `GET /api/projects` response includes `color?: string` (already flows through if added to type)

### Frontend store changes
- [ ] `ProjectInfo` extends with `color?: string`
- [ ] Remove any color localStorage logic (not needed — comes from API)
- [ ] `customOrder` stays in localStorage (per-device order is fine)
- [ ] Add `setProjectColor(name, color)` — calls `PATCH /api/projects/:name/color`, updates local store
- [ ] Add `moveProject(name, direction)` — calls `PATCH /api/projects/reorder`, updates local store
- [ ] Add `renameProject(name, newName)` — calls `PATCH /api/projects/:name`
- [ ] Add `deleteProject(name)` — calls `DELETE /api/projects/:name`
- [ ] Export `PROJECT_PALETTE` constant for use in ProjectBar color picker

## Architecture

### Config YAML (after change)
```yaml
projects:
  - path: /home/user/project-a
    name: project-a
    color: '#4f86c6'   # optional, user-set
  - path: /home/user/project-b
    name: project-b
    # no color → frontend uses palette[1]
```

### Palette util (new file)
```typescript
// src/web/lib/project-palette.ts
export const PROJECT_PALETTE = [
  '#4f86c6', '#e05d5d', '#56b87a', '#e0a03d',
  '#9b6be0', '#e06b9b', '#4ab8c1', '#b8914a',
  '#7b9e3e', '#c15f3e', '#5e7fc1', '#a05ec1',
]

export function resolveProjectColor(color: string | undefined, index: number): string {
  return color ?? PROJECT_PALETTE[index % PROJECT_PALETTE.length]!
}
```

### Frontend store additions
```typescript
setProjectColor: async (name, color) => {
  await api.patch(`/api/projects/${name}/color`, { color })
  set(s => ({ projects: s.projects.map(p => p.name === name ? { ...p, color } : p) }))
},

moveProject: async (name, direction) => {
  // compute new order locally, call reorder API, update store
},
```

### Order resolution (localStorage — per device OK)
```typescript
// customOrder in localStorage: string[] of project names
// If customOrder exists → sort projects by it
// Else → sortByRecent (existing behavior)
export function resolveOrder(projects: ProjectInfo[], customOrder: string[] | null): ProjectInfo[]
```

## Related Code Files
- Modify: `src/types/config.ts` — add `color?` to `ProjectConfig`
- Modify: `src/server/routes/projects.ts` — add color/rename/delete/reorder endpoints
- Modify: `src/web/stores/project-store.ts` — new actions
- Create: `src/web/lib/project-palette.ts` — palette + resolveProjectColor

## Implementation Steps

1. Add `color?: string` to `ProjectConfig` in `src/types/config.ts`
2. Add endpoints in `src/server/routes/projects.ts`:
   - `PATCH /:name/color` — set color, save config
   - `PATCH /:name` — rename, save config
   - `DELETE /:name` — remove, save config
   - `PATCH /reorder` — reorder projects array, save config
3. Create `src/web/lib/project-palette.ts`
4. Update `ProjectInfo` in frontend to include `color?: string`
5. Add `setProjectColor`, `moveProject`, `renameProject`, `deleteProject` to `project-store.ts`
6. Add `customOrder` (localStorage) + `resolveOrder` to store
7. Export `resolveOrder` for ProjectBar

## Todo

- [ ] Add `color?` to `ProjectConfig` type
- [ ] Backend: PATCH color endpoint
- [ ] Backend: PATCH rename endpoint
- [ ] Backend: DELETE project endpoint
- [ ] Backend: PATCH reorder endpoint
- [ ] Create `project-palette.ts`
- [ ] Frontend store: new actions
- [ ] Frontend store: customOrder + resolveOrder

## Success Criteria
- Color set on one device → appears on another device
- Config YAML reflects color changes after `save()`
- Palette fallback works for projects without explicit color
- All CRUD actions call backend, not just update frontend state

## Risk Assessment
- **`projects.ts` route may not support mutation** → check current route handlers first; may only have GET
- **Config write race condition** → `configService.save()` is sync, OK for single-server use
- **`moveProject` + `reorder`**: need to decide if order stored in YAML or localStorage. Decision: **localStorage** (order is per-device preference, color is identity)
