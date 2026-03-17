# Brainstorm: Always-Alive Tabs via Reverse Portal

## Problem Statement
PPM tabs remount (lose state) when:
1. **Switch project** — `switchProject()` replaces entire panels/grid state
2. **Move tab between panels** — different React parent trees
3. **Split panel** — tab extracted to new panel component

Impact: Terminal loses session, chat loses scroll/history, editor loses undo stack, git state resets.

**Requirement:** All tab types must stay alive across project switches, panel moves, splits, and reorder. Cache up to 5 projects.

## Evaluated Approaches

### A: Reverse Portal (DOM Reparenting) — CHOSEN
- Separate React ownership (InPortal in persistent pool) from display (OutPortal in panels)
- Tab React instance never unmounts; DOM node physically moves between panels
- Library: `react-reverse-portal` (1.2KB) or DIY ~50 LOC
- **Pros:** Zero remount, proven pattern (VS Code/Chrome), least total code
- **Cons:** Extra abstraction layer, higher memory (mitigated by LRU)

### B: CSS Display Toggle + Global Flat Render — REJECTED
- All tabs in global container, CSS position to match panel bounds
- **Rejected:** Fragile CSS positioning, ResizeObserver sync, layout jitter

### C: State Preservation + Lazy Remount — REJECTED
- Persist/restore state per tab type
- **Rejected:** Terminal can't resume process, per-type restore code, visible jank

## Chosen Solution: Reverse Portal + LRU Cache

### Architecture

```
App
├── TabContentPool (persistent, NEVER unmounts)
│   ├── InPortal[tab-1] → <ChatTab />       ← React owns here (alive forever)
│   ├── InPortal[tab-2] → <TerminalTab />
│   ├── InPortal[tab-3] → <CodeEditor />
│   └── ... (all tabs from up to 5 projects)
├── PanelLayout (changes on project switch / split / move)
│   ├── EditorPanel A
│   │   └── OutPortal[tab-1]  ← DOM borrows here
│   └── EditorPanel B
│       └── OutPortal[tab-2]
```

### Key Components

1. **TabRegistry store** — Global, cross-project tab list
   - `Map<tabId, { tab: Tab, projectId: string, createdAt: number }>`
   - Survives project switches (not tied to panel state)
   - LRU eviction: when 6th project opened, evict oldest project's tabs

2. **TabContentPool component** — Renders at app root
   - Iterates TabRegistry, creates InPortal for each tab
   - Hidden tabs get `display: none` (in DOM but invisible)
   - Active tabs' InPortals are consumed by OutPortals in panels

3. **EditorPanel refactor** — Replace direct render with OutPortal
   - Instead of `<Component metadata={...} />`, render `<OutPortal node={portalNode} />`
   - Panel only manages tab bar + OutPortal target div

4. **switchProject() refactor** — Layout-only switch
   - Save current project's layout (grid + panel→tab mapping)
   - Load target project's layout
   - Tabs themselves remain in TabRegistry — not created/destroyed
   - Only the grid/panels/activeTabId pointers change

5. **LRU Eviction** — 5 project cache
   - Track project access order
   - When exceeding 5, unmount oldest project's tab InPortals
   - On re-open evicted project, tabs remount fresh (acceptable)

### Data Flow

```
User switches Project A → B:
1. Save layout(A): { grid, panels(with tab IDs), focusedPanelId }
2. Load layout(B): same structure
3. TabContentPool: tabs from A get display:none, tabs from B get OutPortal'd
4. No React unmount — just CSS visibility + DOM reparenting
```

```
User moves tab from Panel 1 → Panel 2:
1. Update panels state (tab ID moves from panel1.tabs to panel2.tabs)
2. Panel 1's OutPortal unmounts (DOM node detaches)
3. Panel 2's OutPortal mounts (DOM node re-attaches in new location)
4. React instance in InPortal: untouched, still alive
```

### Files to Modify

| File | Change |
|---|---|
| `src/web/stores/tab-registry.ts` | NEW — global tab registry |
| `src/web/stores/panel-store.ts` | Refactor switchProject, openTab, closeTab to use registry |
| `src/web/components/layout/tab-content-pool.tsx` | NEW — persistent InPortal layer |
| `src/web/components/layout/editor-panel.tsx` | Replace direct render with OutPortal |
| `src/web/app.tsx` | Add TabContentPool at root |

### Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Memory growth with many tabs | LRU eviction at 5 projects; can add per-project tab limit |
| DOM reparenting breaks CSS `:focus` | Re-focus after OutPortal mount via `requestAnimationFrame` |
| Terminal WebSocket lost on eviction | Terminal already reconnects; just loses scrollback |
| react-reverse-portal maintenance | Tiny lib (50 LOC equivalent); can vendor if needed |

### Success Criteria
- [ ] Switch project → switch back: terminal still has scrollback, chat has messages
- [ ] Move tab between panels: no visible remount flash
- [ ] Split panel with tab: tab content preserved
- [ ] Open 6th project: oldest project tabs evicted cleanly
- [ ] Performance: no measurable render regression with 5 projects cached
