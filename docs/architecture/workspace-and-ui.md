# Workspace & UI

> Part of the [PPM system architecture](../system-architecture.md).

## Adaptive guided tour

The optional welcome card and Settings → General → Learn PPM open a two-screen chooser:
experience (beginner/familiar/advanced), then goal (AI/explore/developer). Shared step IDs
and level-specific copy live in `src/web/lib/onboarding/`; `onboarding-store.ts` owns
versioned browser-local progress. Active guidance restores paused after reload. This is
per browser/origin, not an account profile; changing devices or tunnel origins does not
sync progress. Denied or corrupt storage falls back safely.

Quick orientation is available from the welcome/resume card, active guide, chat welcome
and General settings. Its optional Command Palette and navigation reference uses the
canonical sidebar icon/label registry, explains desktop/mobile entry points and utility
buttons, and opens the real palette on request. It never changes tour progress. While
the reference or palette is open, Escape closes that surface without pausing the tour;
the tour card is hidden behind the palette so it cannot cover its controls.

Step changes use the shared `OnboardingStepTransition`: a 200ms fade and 12px horizontal
slide, reversed for Back. It animates the existing DOM node without delaying state or
duplicating controls. Rapid navigation cancels the previous animation; reduced-motion
preferences skip animation and cancel any running transition when changed live.

`OnboardingRoot` mounts only inside the authenticated app. Nonmodal hints preserve real
workspace interactions; mobile navigation reuses the project sheet and drawer, including
the shared SearchPanel. Collapsed guidance moves above content controls to keep Send reachable.
Typed `ppm:onboarding-evidence` events report actual text-editor, search, terminal and Git
readiness. Chat uses an optional transport lifecycle observer and a client-local attempt ID;
partial output after cancellation/error/disconnection never counts as success. Canonical
session migration preserves identity. `ppm:onboarding-refresh` requests existing readiness
only, never replays a user send or search. History uses the chat toolbar's menu.

The tour never sends prompts, executes terminal commands, edits files or changes provider
permissions automatically. Suggestions fill only an empty hydrated focused composer after
a user click. Completed and skipped steps remain separate. The run-instructions step is
orientation, not proof that a program ran. Images and preview-only files offer a text-file
alternative or skip. Settings and chat welcome can resume a paused/dismissed tour.

The file-reading step accepts any successfully loaded text/source file and Markdown
Preview, regardless of filename. Empty visible project roots offer an explicit skip;
the tour never creates sample files. Root-list errors do not masquerade as emptiness,
and stale requests cannot replace the current guidance. On mobile, collapsed guidance
hides while the navigation drawer/project picker is open so the first file remains tappable.

Project content search resolves grep from PATH or Git for Windows without changing the
server environment. It runs asynchronously with timeout/output bounds, uses project-relative
NUL-delimited filenames, and distinguishes errors from successful zero-result searches.
The frontend surfaces the actual retryable error. The sandbox no longer injects grep into PATH.

The run-instructions action opens a readable root README directly, falling back to
package.json. A loaded visible README Markdown preview qualifies for this orientation
step without switching to Edit, and Markdown previews also qualify for general file reading.
Missing documents and list failures show a retry/browse/skip explanation. Only the
user's explicit acknowledgment completes the run-instructions step.

Verification uses `tests/e2e/onboarding-tour.mjs` and its isolated fixtures: fresh database,
scratch project, local ports, allowlisted test provider and real HTTP/WebSocket routes.
Playwright captures desktop/mobile screenshots and videos without live AI credentials.

## New Chat Provider

Settings → AI offers `Always use default provider` and `Follow last focused chat`.
`ai.default_provider` is the fixed choice or the fallback when the current project has
no focused chat. Fresh installations use follow-focus; existing configurations without
`ai.new_chat_provider_mode` retain default mode.

Focus memory is per project and browser session, across panels. Editors, terminals and
panel chrome do not replace it. New tabs snapshot the source at creation and resolve
settings before mounting chat or claiming an account. An unavailable provider prompts
for an available choice. Existing tabs, resumed sessions and explicit fork/clear
providers are preserved; changing the setting only affects new tabs.

## File Service & Filtering (Lazy-Load Tree, Palette Index)

**Component:** FileFilterService + API endpoints `/files/list`, `/files/index`, settings endpoints

**Overview:** Provides efficient file discovery with VS Code-style glob filtering and gitignore support. Three-layer filter precedence enforces consistent exclude patterns across tree navigation and search indexing.

**Filter Precedence (evaluated low-to-high):**
1. **Hardcoded defaults** — `node_modules/**`, `.git`, `.env*` (always excluded, cannot override)
2. **Global config** — `files.exclude`, `files.searchExclude`, `files.useIgnoreFiles` (applies to all projects)
3. **Per-project override** — Project-scoped settings (DB: `projects.settings` JSON, schema v21) override global

**API Endpoints:**
```
GET  /api/project/:name/files/list?path=<rel>
     → 1-level directory children with gitignore decoration (isIgnored field)
     → { items: [{ name, type, isDir, isIgnored }], ... }

GET  /api/project/:name/files/index
     → Flat full-project file list (cached in memory, watcher-invalidated)
     → { files: [{ path, isIgnored }], ... }

GET  /api/settings/files
     → Global file filter config (all projects)
     → { filesExclude: [], searchExclude: [], useIgnoreFiles: bool }

PATCH /api/settings/files
     → Update global config (partial: only specified fields)
     → Validates arrays ≤200 items, filters non-string patterns

GET  /api/project/:name/settings
     → Per-project settings (includes file filter overrides)
     → { filesExclude?: [], searchExclude?: [], useIgnoreFiles?: bool, ... }

PATCH /api/project/:name/settings
     → Per-project override (stored in projects.settings JSON, schema v21)
     → Same validation as global, caches invalidation on write
```

**Filtering Model:**

| Config | Applies To | Validation | Notes |
|--------|-----------|------------|-------|
| `filesExclude` | Tree navigation | Glob patterns (max 200) | Hides from tree explorer |
| `searchExclude` | Index + palette search | Glob patterns (max 200) | Hides from search results |
| `useIgnoreFiles` | Both (when true) | Boolean | Include `.gitignore` + `.git/info/exclude` in filtering |

**Frontend Integration:**
- `useFileStore()` hook manages lazy-loading: `loadRoot()`, `loadChildren()`, `loadIndex()`
- AbortController pool cancels pending requests on project switch
- File tree auto-expands root (1 level), children load on-demand with spinner
- Command palette + chat file-picker switched from tree-flattening to `fileIndex` from store
- "Indexing project…" hint shown when `loadIndex()` is pending

**Server-Side Implementation:**
- `FileFilterService.mergeFilters()` — Combine hardcoded + global + project overrides with precedence
- `FileFilterService.isPathIgnored()` — Check if path matches any exclude pattern (gitignore if enabled)
- `FileService.list()` — 1-level enumeration with `isIgnored` field computed per item
- In-memory `indexCache` (Map: projectName → FileIndex) invalidated by `fs.watch` (file changes) + manual `invalidateIndexCache()` calls
- WS `file:changed` events routed to `invalidateFolder()` or `invalidateIndex()` depending on scope

**Database Schema (v21+):**
```typescript
// projects table gains:
settings: TEXT  // JSON: { filesExclude?, searchExclude?, useIgnoreFiles? }

// Example:
projects.settings = JSON.stringify({
  filesExclude: ["**/.venv", "**/*.pyc"],
  searchExclude: ["**/node_modules"],
  useIgnoreFiles: false
})
```

**Deprecated:** `/api/project/:name/files/tree` (marked @deprecated, still functional for backward compat)

---

## Project Workspace Management

### Keep-Alive Pattern (v2.0+)
When switching projects, workspaces are preserved instead of destroyed:
1. **Workspace Mount State**: Each project's UI (tabs, terminal xterm DOM, file selections) remains mounted in the DOM
2. **Visibility Toggle**: CSS `display: none/block` hides/shows workspaces instead of React unmounting
3. **Terminal DOM Persistence**: xterm.js terminal instances retain their DOM structure across switches (prevents re-render flicker)
4. **Cache Efficiency**: Zustand stores persist open tabs, selections, and scroll positions per project

**Benefits:**
- Instant project switching (no DOM reconstruction)
- Terminal history preserved across switches
- Smooth UX without flashing/re-rendering
- Reduced network requests (cached UI state)

### Project Color, Avatar & Ordering (v2.0+)
**Storage**: 
- Colors stored as optional `color` field in `Project` interface (hex string or undefined)
- Custom avatar images stored content-addressed at `~/.ppm/avatars/<sha256>.webp` via AvatarStorageService

**Endpoints:**
- `PATCH /api/projects/:name/color` — Update project color
- `POST /api/projects/:name/image` — Upload avatar (multipart, 2MB cap, client resizes to 128×128 webp 0.85)
- `GET /api/projects/:name/image` — Stream avatar (immutable cache headers, path-traversal safe)
- `DELETE /api/projects/:name/image` — Remove avatar (reverts to color+initials)
- `PATCH /api/projects/reorder` — Reorder projects array in config

**UI Components:**
- `ProjectBar` (52px sidebar) — Shows project avatars (custom image or color+initials), context menu for reorder/rename/delete/color-picker/change-image
- `ProjectBottomSheet` (mobile) — Bottom sheet switcher with long-press menu ("Change Image"/"Remove Image")
- `ProjectAvatar` component — Renders `<img>` with token auth + cache-bust query param, fallback to color+initials on missing/error
- `PROJECT_PALETTE` — 12-color palette for default colors when not customized

**Avatar Upload & Caching:**
- Client: canvas center-crop to 128×128, export as webp 0.85 quality (via `resize-image.ts`)
- Validation: MIME type (image/png, image/jpeg, image/webp, image/avif), file size ≤10MB
- Server: SHA256 hash for deduplication (same image across projects = same file)
- Cleanup: Deleted on project remove, preserved across rename (updated in project metadata)
- Auth: Token in URL query param allows `<img>` to load when auth enabled
- Cache: Immutable headers (max-age=31536000) + `?v=hash` cache-bust for updates

---

## Code Editor Migration (v2.0+)

**Migration**: CodeMirror 6 → Monaco Editor (@monaco-editor/react)

**Reasons:**
- Better syntax highlighting for complex languages
- Superior IntelliSense and code completion
- Performance improvements on large files
- More polished diff viewer experience

**Components Updated:**
- `src/web/components/editor/code-editor.tsx` — Monaco Editor with language detection
- `src/web/components/editor/diff-viewer.tsx` — Monaco diff viewer for git diffs

**Features:**
- Alt+Z toggle for word wrap
- Automatic language detection from file extension
- Theme sync with app dark/light mode
- Responsive layout with proper scrolling

---

### HTML file preview

Saved `.html` and `.htm` files open with a single toolbar row: breadcrumb, Refresh preview, Code / Preview and an overflow menu. The single refresh button reloads the entry document, also restoring it after following an image or link inside the sandbox. Download, wrap, blame, language and language-server settings live in the menu; Code mode also offers Reload code from disk (disabled while unsaved). Controls support desktop, mobile and external files from OS Explorer. Preview renders the saved file; refreshing it does not replace the editor buffer. Once opened, the code editor stays mounted across mode changes to retain undo and cursor state. Existing tab pop-out/redock also hosts the preview.

`POST /api/html-preview` requires normal API authentication and returns a one-hour capability URL under `/api/html-preview/content/:token/`. The capability serves static assets from the HTML file's directory and descendants with byte-range support for video. Realpath containment, filesystem credential guards, hidden asset restrictions and a static extension allowlist apply to each request. No PPM login token is embedded in the document. Both the iframe and response CSP sandbox scripts without same-origin privileges; resource/fetch access is limited to that preview directory. External CDNs, parent-directory assets, forms, nested frames and browser storage are intentionally unsupported. Refresh renews an expired capability; at most 128 capabilities are retained per server.

### Markdown file and folder links

Markdown local links are parsed independently of extensions, then resolved by `use-markdown-file-navigation` through the guarded host `/api/fs/stat` API: files open editor/viewer tabs; directories open desktop/mobile Explorer. Supports Windows/Unix paths, project-relative paths, `~/`, local `file://` URLs, percent-encoded names and line references. Relative links resolve against the message's project root. Missing or ambiguous targets open search; explicit paths never fall back to a different same-named file. Remote file authorities/UNC remain unsupported by the host filesystem policy.

A link may name one place in the file — `app.ts:120`, `app.ts:120-140`, `app.ts#L120` — which `src/web/lib/source-location.ts` splits off the path for both readers of it. The editor reveals that line (selecting the range when one is given) and a tab already open on the file is updated rather than left where it was. A suffix naming an impossible line rejects the link instead of quietly opening line 1. The same suffix travels into the command palette on the search fallback, so it strips it before matching filenames and still jumps once a candidate is picked — including in filesystem (`/`, `~/`, `C:\`) mode, where the directory is listed without it.

## Terminal Flow

```
User clicks Terminal tab
    ↓
TerminalTab.tsx mounts
    ↓
useTerminal hook opens WebSocket: WS /ws/project/:name/terminal/:id
    ↓
TerminalService.spawn() creates PTY (Bun.spawn)
    ↓
xterm.js renders terminal emulator
    ↓
User types: "npm test"
    ↓
xterm.js captures key event
    ↓
Sends via WebSocket: { type: "input", data: "npm test\n" }
    ↓
TerminalService.write(pty, "npm test\n")
    ↓
npm process spawned inside PTY
    ↓
Output captured: "PASS: all tests\n"
    ↓
TerminalService sends: { type: "output", data: "PASS: all tests\n" }
    ↓
xterm.js renders output
    ↓
User resizes window → xterm.js resizes terminal
    ↓
Sends: { type: "resize", cols: 120, rows: 40 }
    ↓
TerminalService calls pty.resize()
    ↓
Shell (bash/zsh) receives SIGWINCH signal
    ↓
Terminal state updated
```

---

## Git Integration Flow

```
User right-clicks file in FileTree
    ↓
Context menu shows "Stage" option
    ↓
User clicks "Stage"
    ↓
FileActions.tsx calls POST /api/project/:name/git/stage
    ↓
Sends: { path: "src/index.ts" }
    ↓
GitService.stage(projectPath, "src/index.ts")
    ↓
Executes: git add src/index.ts (via simple-git)
    ↓
Returns: { ok: true }
    ↓
GitStatusPanel.tsx refreshes: GET /api/project/:name/git/status
    ↓
GitService.status() returns:
    {
      current: "main",
      staged: ["src/index.ts"],
      unstaged: ["README.md"],
      untracked: ["temp.log"]
    }
    ↓
UI updates: "src/index.ts" moves from "Unstaged" to "Staged"
```

---

## Frontend Performance Optimization (v0.9.86+)

### Memory & Re-Render Reduction

**1. useShallow Pattern (Zustand)**
- All destructured store selectors wrapped in `useShallow()` (36 sites)
- Prevents unnecessary re-renders when object properties mutate
- Example: `const { messages, addMessage } = chatStore(useShallow(...))`

**2. Component Memoization (React.memo)**
- 10 heavy components wrapped (CodeEditor, MessageBubble, ProjectBar, ProjectAvatar, TerminalTab, PanelLayout, Sidebar, StatusBar, StatusBarEntry, TabBar, TreeNode)
- Memoization skips re-renders if props unchanged
- Paired with `useCallback` to maintain stable references

**3. Lazy Loading**
- MarkdownRenderer lazy-loaded from 3 sites (reduces initial bundle)
- CodeMirror on-demand in postgres-viewer
- Mermaid diagram support loaded dynamically only when diagram syntax detected

**4. Code Splitting (vite.config.ts)**
- 5 vendor chunks: `vendor-monaco`, `vendor-mermaid`, `vendor-xterm`, `vendor-markdown`, `vendor-ui`
- Heavy libraries (>500KB) in separate chunks for better browser caching
- Each chunk independently cacheable and updated

**5. Chat Pagination & Message Caps**
- Chat history loads 50 messages per page with load-more button (prevents DOM bloat)
- Team activity capped at 500 messages (prevents unbounded growth)

### Benefits
- Faster page load (lazy chunks load on-demand)
- Reduced re-render cycles (useShallow + memo)
- Lower memory footprint (capped message buffers)
- Better caching (vendor chunk stability across versions)

---

## OS File Explorer Window

A floating, OS-skinned window (Windows 11 / macOS Finder chrome, Linux → macOS skin) that browses
the **whole host filesystem** — not just registered project directories — through the widened
`/api/fs` family. This is a deliberate scope change from every other file-facing route in PPM
(project-scoped, path-validated against one repo root): the explorer's authorization boundary is
"the whole disk, behind PPM's existing session auth", not "one project".

### FS scope = auth boundary

Every `/api/fs` route — including `docx-html`, `read`, `raw`, both SQLite doors — passes through
one shared guard chain (`src/services/fs-path-guard.service.ts`) before touching disk:

| Protection | Mechanism |
|---|---|
| PPM-dir shield | `assertNotPpmDir` refuses `getPpmDir()` (config, auth token, credentials) as a source **or** destination of any read or mutation, checked at both the given path and its resolved realpath (defeats a symlink pointed at the PPM dir) |
| Protected roots | `/`, drive roots (`C:\`), `$HOME` and the PPM dir itself refuse delete/rename/move as a source |
| Download tokens | `/api/fs/download/token` issues a single-use, path-bound token; `/api/fs/raw` spends it on first use, rejects replay and any path mismatch |
| Symlink safety | every op `lstat`s the entry itself (never follows to the target) so a link *to* a protected path can itself still be deleted, but nothing can read/write *through* one into the PPM dir |
| SQL injection surface | the external-DB doors (`/api/fs/sqlite/*`) block `ATTACH`/`DETACH` by keyword scan (after stripping comments/string literals) before executing any query — the same class of guard the project-scoped `/sqlite` route also needed |
| No event-loop blocking | every op is `fs.promises`-based with bounded concurrency and a per-entry timeout — a dead network mount or sleeping USB drive cannot stall unrelated requests, which matters once scope is the whole disk instead of one project |

### API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/system/host` | `HostInfo`: platform, path separator, homedir, drives, known folders, OS-pinned folders (Quick Access / Finder Favorites / GTK+KDE bookmarks), warnings |
| GET | `/api/fs/browse` | Directory listing (existing route, whitelist widened to `/`) |
| GET | `/api/fs/stat` | Single-entry metadata |
| POST | `/api/fs/copy` \| `/move` \| `/rename` \| `/touch` \| `/mkdir` | Mutations, collision (`EEXIST`)/self-nesting (`EINVAL`) reported for the client to resolve |
| DELETE | `/api/fs/delete` \| `/rmdir` | `{permanent?}` — OS trash (Recycle Bin / Trash / gio) by default, permanent on request |
| POST/GET | `/api/fs/download/token` / `/api/fs/raw` | Single-use, path-bound download |
| GET/POST | `/api/fs/sqlite/{tables,schema,data,query}` | External `.db` viewer — same shape as the project-scoped `/sqlite` route, `path` absolute, PPM dir refused |

`host-info.service.ts` orchestrates three OS-specific provider sets (`src/services/host-info/`)
behind a 60s cache with in-flight de-duplication (concurrent `?refresh=true` calls share one
rebuild rather than spawning N PowerShell/plutil/findmnt processes).

### Floating window layer

`src/web/components/floating-window/` — a content-agnostic window manager (zustand store):
drag/8-handle-resize gestures write geometry straight to the DOM element (no React re-render per
pointermove), committing to the store only on gesture end; rect + open windows persist to
`localStorage["ppm-windows"]`, restored once per app load and re-clamped to the current viewport.

Windows render in a portal at **z-30..38** (`30 + rank`, capped at an 8-window dense-rank limit) —
below the app's existing `z-40` click-away backdrops and `z-50` Radix layers, so command palette,
dropdowns and dialogs always stay reachable above any number of open explorer windows. Below the
`md` breakpoint the layer never mounts at all; `src/web/components/os-explorer/mobile/` renders the
same `ExplorerBody` component inside a full-screen bottom sheet instead (`variant="sheet"`).
Drag and resize share a `gestureAbandoned()` guard (`use-window-gesture-context.ts`) for the
pointer-up that still arrives after a mid-gesture window close (e.g. dragging by a titlebar button
that closes the frame).

**One chrome, every kind.** `WindowSkinChrome` (`window-skin-chrome.tsx`) is the titlebar every
window kind — explorer, team-member session, system monitor, detached tab — renders: it resolves
the active OS skin via `useExplorerSkin()` (Settings override, else host platform; Linux → macOS)
and delegates to that skin's `WindowsWindowChrome` / `MacosWindowChrome`
(`src/web/components/os-explorer/skins/`), scoped entirely through `[data-skin="windows"|"macos"]`
CSS variables layered over PPM's existing semantic theme tokens — no second color table. The
Windows skin's folder glyph draws only for `kind === "explorer"`; every other kind gets the bare
titlebar. The macOS skin boxes the title between the traffic lights and the PiP button as a flex
child (so a long title truncates instead of overlapping either), and puts the PiP button at the
titlebar's right end; the Windows skin puts it left of minimize.

**PiP is a capability of the frame, not of one kind.** `useWindowBodyElement`
(`use-window-body-element.ts`) creates the single DOM element `FloatingWindow` portals a window's
content into and publishes it as that window's PiP slot (`window-pip-registry.ts`, keyed by window
id). `PipCaptionButton` (`pip/pip-caption-button.tsx`), rendered by both skins, moves that slot into
a `documentPictureInPicture` window and back; it is absent (not disabled) where the API is
unsupported. `WindowPipPlaceholder` (`window-pip-placeholder.tsx`) takes the body's place in the
frame while it plays in PiP, with a ≥44px "Bring back" control. The mechanics below (attach/detach,
style mirroring, key forwarding, resize signalling) apply to whichever window kind currently owns
the slot — a tab-host window is only the one kind whose body is itself a portal target for another
component (`TabPool`).

#### Tab-host windows (detaching a tab into its own window)

- **Off-grid panel.** Detaching creates `` `__win__:${windowId}` `` (`windowPanelId()`,
  `stores/panel-utils.ts`) — same treatment as `__dock__`: lives in `panels`, never in `grid`, so no
  grid math (rows/columns/split) sees it. `stores/window-panel-actions.ts` is the only writer of
  these panels and enforces the paired invariant: `focusedPanelId` never points at one (it would
  send the next `openTab()` with no explicit panel into a window). `popOutTab`/`redockFromWindow`
  create and destroy the panel and its window together; every close path (titlebar ×, keyboard,
  reconcile) routes through `redockFromWindow`, which re-docks to the origin panel if it is still in
  the grid, else the focused grid panel, else the first grid panel. All tab types pop out except
  `system-monitor`, which already has its own window kind.
- **Straight to PiP.** The tab context menu offers a second route (`open-tab-in-pip.ts`): pop out,
  then adopt the new window's body into a PiP window in the same gesture. The window is real — PiP
  can only adopt an element already in the page, and it needs a home to restore into — but it is
  marked pip-only (`markPipOnlyWindow`, `window-pip-registry.ts`), which makes the frame render it
  `hidden` (never unmounted: the body must stay connected for the restore) and makes closing PiP
  close the window, so the tab lands back in its strip. The one await between the two steps is a
  React commit — the frame's layout effect publishes the body element (`whenWindowSlot`) — which
  leaves the click's transient activation intact for `requestWindow()`.
- **No-remount move.** `TabPool` (`components/layout/tab-pool.tsx`) mounts every tab once into a
  wrapper `div[data-tab-pool-id]` created imperatively in `ReparentingTab`
  (`components/layout/reparenting-tab.tsx`) and rendered into it via `createPortal` — React attaches
  its listeners to the wrapper itself, so they keep firing after the node moves, including into
  another document. A `useLayoutEffect` with no deps calls `appendChild` to move the wrapper into
  whichever element last registered for the tab's panel id (`slotRegistry`,
  `components/layout/tab-pool-registry.ts`); `TabHostWindowContent`'s slot `div` is always mounted
  (never swapped for a placeholder), because it may currently be living inside the PiP document.
- **Persistence.** Window panels persist to their own global `localStorage["ppm-window-panels"]`
  key (`stores/window-panel-persistence.ts`), separate from the per-project `ppm-panels-*` blob and
  not synced to the server — the same limitation window geometry (`ppm-windows`) already has.
  `WINDOW_KINDS` (`window-store-types.ts`) is the single list both the window store and
  `window-persistence.ts` filter against; `team-member` is excluded from restore because its body
  streams a live subagent session that cannot survive a reload.
- **Reconcile.** The two halves persist separately, so a reload can restore one without the other.
  `reconcileTabHostWindows` (`stores/window-panel-reconcile.ts`), run once per project via
  `useWindowPanelReconcile()` after the window layer restores, and unconditionally below `md` (the
  window layer never mounts there): a panel whose window is gone comes back to the grid; a window
  with no panel behind it closes.
- **PiP host.** `attachPipHost`/`isDocumentPipSupported` (`floating-window/pip/pip-host.ts`,
  `pip-support.ts`) move a window's *slot* element — never a tab's own wrapper — into a
  `documentPictureInPicture` window, one at a time per page. `pagehide` triggers a synchronous
  restore (no `await` between it and the DOM move) so a closing PiP document never strips listeners
  off a still-live terminal. `pip-style-copy.ts` mirrors stylesheets + `adoptedStyleSheets` once and
  `<html>` class/inline theme CSS vars + `<body>` class **and inline style** on every theme change
  (the page background is an inline `background: var(--bg)` on `<body>` in `index.html`, not a
  class), plus a MutationObserver for Vite HMR-injected `<style>` tags. `pip-key-forward.ts`
  re-dispatches keydown/keyup from the PiP window onto the main window for app-level shortcuts,
  skipping targets that own their own input (`input`, `.monaco-editor`, `.xterm-helper-textarea`,
  etc.). `pip-resize-signal.ts` dispatches a non-bubbling `ppm:host-resize` CustomEvent on each
  `[data-tab-pool-id]` wrapper inside the slot (on attach, every PiP `resize`, and on detach); the
  terminal and editors subscribe via `onHostResize` and re-fit, because main-window
  `ResizeObserver`s are late or silent for a PiP-driven size.
- **Radix portals in PiP.** `PortalContainerProvider` (`components/ui/portal-container-context.tsx`)
  is mounted inside `ReparentingTab` around each tab's content, fed the PiP document's `body` while
  that tab's window is in PiP (`usePipPortalContainer`, `window-pip-registry.ts`) — so a tab's own
  dropdowns/tooltips/dialogs render inside the PiP document instead of opening unreachably in the
  main window. `undefined` (document default) while docked.
- **Known limitations** (see the comment block atop `pip/pip-caption-button.tsx`): sonner toasts
  always render in the main window (one app-root toaster); `useIsMobile()`/Tailwind `md:` read the
  main window's viewport, not the PiP window's; `onSelect`/`selectionchange` degrades for PiP
  content; the terminal's reconnect check reads the main document's visibility; Monaco keybindings
  (Ctrl+Z, Ctrl+F, …) don't fire while the editor sits in PiP (typing still reaches the buffer); a
  tab-host window's titlebar keeps the tab title captured at pop-out time.
- **Mobile.** Pop-out and PiP are hidden entirely below `md` (`useIsMobile()`) — never a scaled-down
  window.
