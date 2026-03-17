# Frontend UI Structure Scout Report

## Summary
Mapped all frontend layout, sidebar, tabs, editor, and panel components in PPM's React+Vite frontend. The app uses a tab-based architecture with desktop/mobile responsive layouts.

---

## Architecture Overview

**Main App Structure** (`src/web/app.tsx`):
- Desktop: Sidebar (left) + TabBar (top) + TabContent (main area)
- Mobile: Bottom nav bar + Drawer overlay
- Global: Command palette, toast notifications, auth state management

**Layout Flow**:
```
App (h-dvh flex flex-col)
├── Main layout (flex flex-1)
│   ├── Sidebar (hidden md:flex, 280px width) — desktop only
│   └── Content area (flex-1 flex flex-col)
│       ├── TabBar (hidden md:flex, 41px height) — desktop only
│       └── TabContent (flex-1) — main content renderer
├── MobileNav (fixed bottom, md:hidden) — mobile only
├── MobileDrawer (fixed overlay, md:hidden) — mobile only
├── CommandPalette (Shift+Shift)
└── Toaster (notifications)
```

---

## Core Layout Components

### 1. Sidebar (`src/web/components/layout/sidebar.tsx`)
**Desktop navigation panel (hidden on mobile)**
- Width: 280px fixed
- Height: Full viewport
- Features:
  - Project dropdown selector (top, 41px height matching tab bar)
  - File tree explorer (scrollable middle section)
  - Version footer + "Report Bug" button (bottom)
  - Project search when >8 projects
  - Active project indicator (checkmark)

**Key Elements**:
- `FolderOpen` icon + project name dropdown
- Device name badge (if configured)
- FileTree component (recursive)
- Bug report button with version

### 2. TabBar (`src/web/components/layout/tab-bar.tsx`)
**Desktop horizontal tab navigation (hidden on mobile)**
- Height: 41px
- Uses `ScrollArea` for overflow
- Features:
  - Scrollable tab list with auto-scroll to active
  - Icons per tab type (Terminal, Chat, Editor, Git, etc.)
  - Close button (X) on hover
  - "+" dropdown menu for new tabs
  - Tab type icons mapped in `TAB_ICONS`

**Tab Types Supported**:
- `projects` — Project selector
- `terminal` — Terminal/CLI
- `chat` — AI chat interface
- `editor` — Code editor
- `git-graph` — Git branch visualization
- `git-status` — Git status panel
- `git-diff` — Diff viewer
- `settings` — Settings panel

**New Tab Options**:
- Terminal, Chat, Git Graph, Git Status, Settings
- Excludes Editor and Projects (opened via file tree/projects tab)

### 3. TabContent (`src/web/components/layout/tab-content.tsx`)
**Main content area renderer**
- Lazy-loads tab components on demand
- Suspense boundary with loading spinner
- Maps tab type → component (using dynamic imports)
- Only one tab visible at a time (`isActive ? "h-full w-full" : "hidden"`)

**Component Mapping**:
```
projects → ProjectList
terminal → TerminalTab
chat → ChatTab
editor → CodeEditor
git-graph → GitGraph
git-status → GitStatusPanel
git-diff → DiffViewer
settings → SettingsTab
```

**Fallback**: Message "No tab open. Use the + button or bottom nav to open one."

---

## Mobile Layout Components

### 4. MobileNav (`src/web/components/layout/mobile-nav.tsx`)
**Mobile bottom tab bar (md:hidden)**
- Position: Fixed bottom (height 48px)
- Features:
  - Menu button (left, opens MobileDrawer)
  - Scrollable tab list
  - Auto-scroll to new active tab
  - Close tabs with X button on tap

**Layout**:
```
[Menu] [Tab1] [Tab2] [Tab3...] [scrollable]
```

### 5. MobileDrawer (`src/web/components/layout/mobile-drawer.tsx`)
**Mobile sidebar overlay (md:hidden)**
- Position: Fixed left, full height, 280px width
- Animation: Slide in from left
- Backdrop: Semi-transparent black (click to close)

**Sections** (top to bottom):
1. **Header**: PPM logo + close (X) button
2. **File Tree**: Active project files (scrollable)
3. **New Tab Actions**: Buttons for Terminal, Chat, Git Status, Git Graph, Settings
4. **Project Switcher**: Dropdown at bottom (upward-opening popover)
5. **Footer**: Version + Report Bug button

**Project Switcher UX**:
- Always visible at bottom for thumb reach
- Popover opens upward (above the button)
- Project search with filter
- Add project option at bottom

---

## Tab Store (`src/web/stores/tab-store.ts`)

**State Management**:
- Per-project tab persistence in `localStorage` (key: `ppm-tabs-{projectName}`)
- Tab history stack (50 entry cap) for navigation
- Singleton tab types (only 1 per project):
  - `git-status`, `git-graph`, `settings`, `projects`

**API**:
```typescript
openTab(tabDef) → tabId        // Create or focus tab
closeTab(id) → void             // Close tab, auto-focus previous
setActiveTab(id) → void         // Focus tab
switchProject(projectName) → void // Load/save tabs per project
updateTab(id, updates) → void   // Update tab metadata
```

**Features**:
- Auto-saves to localStorage on any change
- Recovers previously open tabs when switching projects
- Deduplicates tab history (move to top if exists)
- Falls back to empty state or "Projects" tab if corrupted

---

## Tab Types & Content Components

### Editor (`src/web/components/editor/code-editor.tsx`)
**Code editor with syntax highlighting**
- Uses CodeMirror (`@uiw/react-codemirror`)
- Language detection: JS/TS, Python, HTML, CSS, JSON, Markdown
- Theme: One Dark
- Features:
  - Inline image rendering
  - PDF viewer
  - Markdown preview toggle (Code/Eye icons)
  - External link button
  - Error state with FileWarning icon

### Chat (`src/web/components/chat/chat-tab.tsx`)
**AI chat interface**
- Session management (session picker dropdown)
- Provider selection (default: "claude-sdk")
- Message list + input area
- Slash command picker (`/` key)
- File picker (`@` key)
- File attachment chips
- Usage badge + detail panel
- Bug report popup

---

## Supporting UI Components

### FileTree (`src/web/components/explorer/file-tree.tsx`)
**Recursive file browser**
- Used in Sidebar (desktop) and MobileDrawer (mobile)
- Expandable folders
- File actions (context menu)
- Click opens file in editor tab

### Git Components
- **GitGraph** (`src/web/components/git/git-graph.tsx`) — Branch visualization
- **GitStatusPanel** (`src/web/components/git/git-status-panel.tsx`) — Staged/unstaged changes
- **DiffViewer** (`src/web/components/editor/diff-viewer.tsx`) — File diff display

### Modals & Overlays
- **CommandPalette** (`src/web/components/layout/command-palette.tsx`) — Cmd/Ctrl+Shift+Shift
- **Dialogs** (shadcn/ui) — Various modals
- **DropdownMenu** (shadcn/ui) — Project selector, new tab menu

### Other UI
- **ScrollArea** — Custom scrollbars
- **Tooltip** — Hover info
- **Separator** — Visual dividers
- **Button**, **Input**, **Select**, **Label** — Form controls
- **Sonner Toast** — Notifications

---

## Responsive Breakpoints

**Desktop (md: 768px+)**:
- Visible: Sidebar (fixed left), TabBar (top), Main content
- Layout: 3-column (sidebar + tabbar + content)

**Mobile (<768px)**:
- Hidden: Sidebar, TabBar
- Visible: MobileNav (bottom), MobileDrawer (overlay)
- Layout: Full width content, overlay drawer on top

---

## File Paths Summary

**Layout Files** (core structure):
- `/Users/hienlh/Projects/ppm/src/web/app.tsx` — Root app layout
- `/Users/hienlh/Projects/ppm/src/web/components/layout/sidebar.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/tab-bar.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/tab-content.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/mobile-nav.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/mobile-drawer.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/command-palette.tsx`

**State Management**:
- `/Users/hienlh/Projects/ppm/src/web/stores/tab-store.ts` — Tab state + localStorage

**Tab Content Components**:
- `/Users/hienlh/Projects/ppm/src/web/components/projects/project-list.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/terminal/terminal-tab.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/chat-tab.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/editor/code-editor.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/git/git-graph.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/git/git-status-panel.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/editor/diff-viewer.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/settings/settings-tab.tsx`

**Explorer & Editor**:
- `/Users/hienlh/Projects/ppm/src/web/components/explorer/file-tree.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/explorer/file-actions.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/editor/editor-placeholder.tsx`

**Chat Components**:
- `/Users/hienlh/Projects/ppm/src/web/components/chat/message-list.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/message-input.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/slash-command-picker.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/file-picker.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/session-picker.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/attachment-chips.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/usage-badge.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/tool-cards.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/chat-placeholder.tsx`

**UI Library Components** (shadcn/ui):
- `/Users/hienlh/Projects/ppm/src/web/components/ui/tabs.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/dropdown-menu.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/scroll-area.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/tooltip.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/dialog.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/button.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/input.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/select.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/label.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/context-menu.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/separator.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/ui/sonner.tsx`

**Other**:
- `/Users/hienlh/Projects/ppm/src/web/components/terminal/terminal-placeholder.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/git/git-placeholder.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/chat/chat-placeholder.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/auth/login-screen.tsx`

---

## Key Design Patterns

1. **Lazy Loading**: Tab content components loaded on demand with React.lazy
2. **Responsive Design**: Desktop sidebar + mobile overlay drawer
3. **Tab Persistence**: localStorage per project maintains open tabs across sessions
4. **Singleton Tabs**: Some tabs (settings, git-status) only have 1 instance per project
5. **Auto-scroll**: Tabs auto-scroll to focus when new tab added
6. **URL Sync**: Active project/tab reflected in URL for sharing/bookmarking
7. **Command Palette**: Global shortcut for quick navigation (Shift+Shift)
8. **Health Check**: Server crash detection + auto-reconnect

---

## No Split Panel Implementation Found

**Current State**: The codebase does NOT include split/resizable panels. Tabs are single-pane only.

**If needed for future**:
- Could add drag-handle between TabBar and sidebar (width adjustment)
- Could add vertical splitter in TabContent (split pane editor view)
- Recommend: `react-resizable-panels` or custom `react-resizable` wrapper

---

## Unresolved Questions
- No split/multi-pane editor found — is this planned?
- TabBar has overflow scrolling — consider tab grouping if many tabs?
