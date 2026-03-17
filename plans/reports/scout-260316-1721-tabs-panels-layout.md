# Tabs, Panels & Layout Architecture

## Overview
PPM implements a sophisticated multi-panel split-screen system with draggable tabs. Each project maintains its own layout state persisted via localStorage.

## Core Files

### State Management
- **panel-store.ts** — Main store managing all panels, tabs, grid layout, and split-screen operations
- **tab-store.ts** — Facade store (backward compat) delegating to panel-store; exposes focused panel's tabs
- **panel-utils.ts** — Grid manipulation utilities, persistence helpers, type definitions
- **project-store.ts** — Project selection and recent project tracking

### Components
- **panel-layout.tsx** — Root layout using react-resizable-panels; renders grid of columns and rows
- **editor-panel.tsx** — Individual panel container; renders tab bar + active tab content
- **tab-bar.tsx** — Tab bar UI with drag-drop support; "+" menu for new tabs
- **draggable-tab.tsx** — Single tab element with drag start/end handlers
- **split-drop-overlay.tsx** — Visual drop zone indicator (left/right/top/bottom/center) when dragging

### Hooks
- **use-tab-drag.ts** — Tab reordering within panel + global drag state tracking
- **use-url-sync.ts** — Keeps browser URL in sync with active project/tab

## Architecture Details

### Panel Grid System
```
grid: string[][]
  grid[col][row] = panelId

Example (2 columns, 2 rows in col 0):
[
  ["panel-a", "panel-b"],  // Column 0: 2 rows
  ["panel-c"]              // Column 1: 1 row
]
```

Constraints:
- Desktop: max 3 columns, max 2 rows per column
- Mobile: max 1 column, max 2 rows

### Tab Lifecycle

**Tab Types** (mutually exclusive):
- Singleton: git-status, git-graph, settings, projects
  - Only 1 instance per project allowed across all panels
  - Activates existing tab if opened again
- Regular: terminal, chat, editor, git-diff
  - Multiple instances allowed per panel

**History Tracking:**
- Each panel maintains `tabHistory` (50-item limit)
- Used to restore previous tab when active tab closes
- Prevents orphaned panels

**Auto-Cleanup:**
- Empty panel auto-closes if not the last panel
- Tabs merge into neighbor when panel closes
- Focused panel switches intelligently

### Drag-Drop System

**Tab Reordering (within panel):**
- Drag start: payload = {tabId, panelId}
- Hover: calculate midpoint to show drop indicator
- Drop: call `reorderTab()` with new index

**Tab Moving (between panels):**
- Same drag start, but drops in different panel
- Calls `moveTab()` with source/target panels
- Tabs can also reorder while moving

**Split-Screen Creation (dragging to edges):**
- `SplitDropOverlay` detects drag zones (25% margins on edges)
- Drop zones: left, right, top, bottom, center
- Center = move tab to this panel
- Edges = create new panel + move tab there
- Grid updated based on split direction

### Project Switching

Flow:
1. User selects project in sidebar
2. `useProjectStore.setActiveProject()` → `useTabStore.switchProject()`
3. `usePanelStore.switchProject()` loads saved layout from localStorage
4. If no saved layout, creates default with single panel + projects tab
5. Tab state synced from panel-store to tab-store (backward compat)

**Persistence Key:** `ppm-panels-{projectName}`

**Migration:** Old `ppm-tabs-{projectName}` format auto-converted to new grid format

### State Subscription

Tab-store subscribes to panel-store changes:
```ts
usePanelStore.subscribe(() => syncFromPanelStore())
```

This keeps focused panel's tabs/activeTabId synced in tab-store for backward compatibility.

## Component Rendering Flow

1. **App.tsx** → Layout structure: Sidebar + PanelLayout + Mobile nav
2. **PanelLayout** → Iterates grid columns → ColumnPanel
3. **ColumnPanel** → Renders horizontal Panel container (react-resizable-panels)
   - If single row: renders EditorPanel
   - If multiple rows: renders Group with RowPanels
4. **EditorPanel** → Renders TabBar + content area + SplitDropOverlay
5. **TabBar** → Renders DraggableTab components + "+" menu
6. **Content area** → Lazy-loads active tab component (terminal, chat, editor, git, etc.)

Resize handles between panels use `<Separator>` with visual grip icons.

## Key Behaviors

**Multiple Panels:**
- Click panel = focus it (visual border highlight)
- Drag tab from one panel → drop on edge → creates new split panel
- Drag tab from one panel → drop in center → moves tab to that panel
- Close panel → tabs merge into adjacent panel

**Tab Management:**
- Drag tab within bar → reorder
- Click X → close tab
- Closed tab auto-selects previous tab from history
- Last panel cannot be closed
- Opening singleton tab that exists in another panel → switches to that panel

**Mobile:**
- No split-screen (grid max 1 column)
- Sidebar hidden, bottom nav shown
- Tab reordering still works

## Data Flow Summary

```
User action (click project)
  ↓
useProjectStore.setActiveProject()
  ↓
usePanelStore.switchProject(projectName)
  ↓
loadPanelLayout(projectName) from localStorage
  ↓
Set: panels, grid, focusedPanelId
  ↓
usePanelStore.subscribe() triggers sync
  ↓
useTabStore state updated (facade for backward compat)
  ↓
Components re-render via Zustand subscriptions
```

## Integration Points

- **URL Sync** (use-url-sync.ts) — Updates browser URL on project/tab change
- **Global Keybindings** (use-global-keybindings.ts) — Cmd+B sidebar toggle, Alt+[ Alt+] tab cycling
- **Settings Store** (settings-store.ts) — Sidebar collapse state
- **Project Store** (project-store.ts) — Active project tracking
- **Tab Components** — Terminal, Chat, Editor, Git, Settings (lazy-loaded)

## Unresolved Questions

None identified from code review.
