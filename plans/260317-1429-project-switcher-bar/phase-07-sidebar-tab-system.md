# Phase 07: Sidebar Tab System

## Overview
- **Priority:** High
- **Status:** complete
- **Blocked by:** Phase 06 (sidebar cleanup)

Restructure `sidebar.tsx` to support **horizontal tabs at top** (Cursor-style). Three tabs: Explorer (file tree), Git (git status), History (chat session list). Mobile drawer mirrors the same tabs but at the **bottom** (thumb-friendly).

## Context Links
- Sidebar: `src/web/components/layout/sidebar.tsx`
- Mobile drawer: `src/web/components/layout/mobile-drawer.tsx`
- Git status panel (reuse): `src/web/components/git/git-status-panel.tsx`
- Settings store (persist active tab): `src/web/stores/settings-store.ts`

## Visual Design

### Desktop
```
┌──────────────────────────────┐
│ Explorer │ Git │ History      │  ← tab bar (top, horizontal)
├──────────────────────────────┤
│                              │
│  Active tab content          │  ← flex-1, scrollable
│  (FileTree / GitStatusPanel  │
│   / ChatHistoryPanel)        │
│                              │
├──────────────────────────────┤
│ v1.x  [Bug]  [Collapse]      │  ← footer unchanged
└──────────────────────────────┘
```

### Mobile Drawer
```
┌─────────────────────────┐
│ PPM                  [✕]│  ← header
├─────────────────────────┤
│                         │
│  Active tab content     │  ← flex-1, scrollable
│  (file tree / git /     │
│   chat history)         │
│                         │
├─────────────────────────┤
│ [📁 Explorer][⎇ Git][💬]│  ← tab switcher at BOTTOM (thumb-friendly)
└─────────────────────────┘
```

## Requirements

### Sidebar tabs
- [ ] Tab bar at top: Explorer | Git | History
- [ ] Active tab persisted in `settings-store` (`sidebarActiveTab: 'explorer' | 'git' | 'history'`)
- [ ] Explorer tab: renders existing `<FileTree />` (unchanged)
- [ ] Git tab: renders existing `<GitStatusPanel />` — pass `metadata={{ projectName }}` from `activeProject`
- [ ] History tab: renders new `<ChatHistoryPanel />` (see below)
- [ ] Tab bar uses same height as current header (41px) — combine: tab bar replaces the "PPM + project dropdown" header row

### ChatHistoryPanel (new, minimal)
- List of past chat sessions for active project
- Fetch from existing API: `GET /api/projects/:name/sessions` (check if exists)
- Each row: session title / timestamp, click → opens chat tab with that session
- If API doesn't exist yet: show placeholder "Coming soon"

### Mobile drawer changes
- Remove existing bottom section (new tab buttons + old project picker — already removed in Phase 05)
- Add tab switcher at bottom (3 buttons: Explorer, Git, History)
- Content area (flex-1) shows active tab content
- Active tab state: local `useState` in drawer (not persisted — resets on close)

## Related Code Files
- Modify: `src/web/components/layout/sidebar.tsx`
- Modify: `src/web/components/layout/mobile-drawer.tsx`
- Create: `src/web/components/chat/chat-history-panel.tsx`
- Modify: `src/web/stores/settings-store.ts` (add `sidebarActiveTab`)

## Implementation Steps

1. Add `sidebarActiveTab` to `settings-store.ts` (default: `'explorer'`, persist via localStorage)
2. Refactor `sidebar.tsx`:
   - Replace header (PPM label + project dropdown) with horizontal tab bar
   - Three tabs: Explorer / Git / History — use `cn()` for active styling
   - Render content based on `sidebarActiveTab`
   - Git tab: `<GitStatusPanel metadata={{ projectName: activeProject?.name }} />`
   - History tab: `<ChatHistoryPanel projectName={activeProject?.name} />`
3. Create `chat-history-panel.tsx`:
   - Check API existence: `GET /api/projects/:name/sessions`
   - If exists: fetch + render list; if not: show placeholder
   - Keep under 150 lines
4. Refactor `mobile-drawer.tsx`:
   - Remove old bottom section (new tab buttons)
   - Add bottom tab bar (3 icon+label buttons)
   - `activeSidebarTab` local state
   - Render correct content in flex-1 area

## Todo

- [ ] Add `sidebarActiveTab` to settings-store
- [ ] Sidebar tab bar UI
- [ ] Sidebar Explorer tab (wire FileTree)
- [ ] Sidebar Git tab (wire GitStatusPanel)
- [ ] ChatHistoryPanel component
- [ ] Sidebar History tab (wire ChatHistoryPanel)
- [ ] Mobile drawer bottom tab bar
- [ ] Mobile drawer content switching

## Success Criteria
- Sidebar shows 3 tabs on desktop, switches content correctly
- Active tab persists on page reload
- Mobile drawer tabs at bottom, all 3 content areas work
- GitStatusPanel in sidebar functions identically to when it was a panel tab

## Risk Assessment
- **`GitStatusPanel` needs `projectName` from metadata** — currently gets it from `metadata?.projectName`. In sidebar, pass directly from `activeProject?.name`. Component already handles `undefined` projectName gracefully (shows "No project selected").
- **Chat history API may not exist** — scope `ChatHistoryPanel` to show placeholder if endpoint returns 404. Don't block phase on API implementation.
- **Sidebar width (280px)** — 3 tab labels must fit. Use short labels: "Explorer" / "Git" / "History" — at ~93px each in 280px, fits fine.
