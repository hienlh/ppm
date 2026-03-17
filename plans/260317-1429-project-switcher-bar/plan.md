---
title: Project Switcher Bar
date: 2026-03-17
status: complete
priority: medium
progress: 100%
---

# Project Switcher Bar

## Overview

Add a narrow, non-collapsible `ProjectBar` to the left of the existing sidebar on desktop, and a bottom sheet project switcher for mobile via `MobileNav`. Also implement keep-alive workspace switching (hide/show instead of unmount).

## Phases

| # | Phase | Status | Est. Effort |
|---|-------|--------|-------------|
| 1 | [Store Extensions](./phase-01-store-extensions.md) | complete | Small |
| 2 | [Avatar Utilities](./phase-02-avatar-utils.md) | complete | Small |
| 3 | [ProjectBar Component (Desktop)](./phase-03-project-bar-desktop.md) | complete | Medium |
| 4 | [Keep-Alive Workspace Switching](./phase-04-keep-alive-switching.md) | complete | Medium |
| 5 | [Mobile Projects Bottom Sheet](./phase-05-mobile-bottom-sheet.md) | complete | Medium |
| 6 | [Sidebar Cleanup](./phase-06-sidebar-cleanup.md) | complete | Small |
| 7 | [Sidebar Tab System](./phase-07-sidebar-tab-system.md) | complete | Medium |
| 8 | [Panel Tab Types Reduction](./phase-08-panel-tab-reduction.md) | complete | Small |
| 9 | [Monaco Editor Migration](./phase-09-monaco-editor-migration.md) | complete | Medium |

## Dependencies

```
Phase 1 → Phase 2 → Phase 3
Phase 1 → Phase 4
Phase 3 + Phase 4 → Phase 5
Phase 3 → Phase 6 → Phase 7 → Phase 8
Phase 9 (independent — parallel with all)
```

## Key Files

- `src/web/stores/project-store.ts` — add color, custom order, CRUD
- `src/web/stores/settings-store.ts` — add sidebarActiveTab
- `src/web/stores/tab-store.ts` — remove projects/git-status TabTypes
- `src/web/lib/project-avatar.ts` — NEW: initials + color utilities
- `src/web/components/layout/project-bar.tsx` — NEW: desktop project bar
- `src/web/components/layout/project-bottom-sheet.tsx` — NEW: mobile project sheet
- `src/web/components/chat/chat-history-panel.tsx` — NEW: sidebar history tab
- `src/web/app.tsx` — keep-alive workspaces + add ProjectBar
- `src/web/components/layout/sidebar.tsx` — horizontal tabs (Explorer/Git/History)
- `src/web/components/layout/mobile-nav.tsx` — add Projects button
- `src/web/components/layout/mobile-drawer.tsx` — bottom tab bar (Explorer/Git/History)
- `src/web/components/layout/tab-content.tsx` — remove projects/git-status cases
- `src/web/components/editor/code-editor.tsx` — replace CodeMirror → Monaco
- `src/web/components/editor/diff-viewer.tsx` — replace MergeView → Monaco DiffEditor
- `vite.config.ts` — add vite-plugin-monaco-editor
