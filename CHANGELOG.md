# Changelog

## [0.13.47] - 2026-04-26

### Added
- **Unread tint in session list panel**: Session rows on the main session list page now show background tint + bold text for unread sessions (same treatment as sidebar history bar)

### Fixed
- **Bell popover text invisible on light theme**: Session title text was inheriting tint color, now uses `text-foreground` for readability
- **Session titles missing in bell popover**: Added `last_known_title` column to `session_metadata` (migration v23), saved when incrementing unread. `getAllUnread()` uses `COALESCE(session_titles.title, last_known_title)` so SDK-generated titles display correctly
- **Project identification in bell popover**: Added colored dot matching project avatar color in group headers

## [0.13.46] - 2026-04-26

### Fixed
- **Chat crash on load**: `ReferenceError: Cannot access 'O' before initialization` — `topUnexpandedCompact` was used in `useCallback` dependency array before its `const` declaration (temporal dead zone). Moved declaration above the callback

## [0.13.45] - 2026-04-26

### Fixed
- **Debug: enable source maps** for production build to trace runtime errors with real file names

## [0.13.44] - 2026-04-25

### Fixed
- **PWA icon 404**: Manifest and service worker referenced `.png` icons but only `.svg` files existed, causing download errors. Updated icon refs to match actual SVG assets
- **Tab reload on project switch**: TabPool only rendered active project's tabs, causing all chat/terminal tabs to reload when switching projects. Now renders tabs from all visited projects via `projectGrids` for keep-alive

## [0.13.43] - 2026-04-25

### Changed
- **Chat infinite scroll**: Replaced manual "Load XX more messages" button with auto-loading IntersectionObserver sentinel. Scrolling up now seamlessly loads both in-memory paginated messages and pre-compact JSONL history without separate buttons. Includes 150ms debounce to prevent cascade triggers

## [0.13.42] - 2026-04-25

### Fixed
- **Tab reload on project switch**: Switching projects caused all chat/terminal tabs to reload and lose state. TabPool only rendered the active project's tabs, unmounting old ones. Now renders tabs from all visited projects via `projectGrids`, preserving component state across project switches

## [0.13.41] - 2026-04-25

### Fixed
- **Cross-project tab leak**: Tabs from other projects could appear in the current project's tab bar due to a race condition in `openTab` during fast project switching. Added defensive `projectId` filter in TabPool, TabBar, and MobileNav

## [0.13.40] - 2026-04-25

### Fixed
- **Scroll jank in all tabs**: `opacity: 0` on inactive tab wrappers created a separate GPU compositing layer per tab, degrading scroll performance. Switched to `visibility: hidden` which skips painting entirely

## [0.13.39] - 2026-04-25

### Fixed
- **Blank panel after split**: Splitting a tab caused the original panel's content to disappear. The `useEffect` cleanup in EditorPanel fired asynchronously after the new EditorPanel had already registered its slot, deregistering it again. Removed the redundant cleanup — callback ref already handles deregistration synchronously

## [0.13.38] - 2026-04-25

### Fixed
- **Closed tab ghost stays visible**: Closing a tab left its DOM wrapper orphaned in the panel slot (React's `removeChild` failed because the node was reparented). Added `useLayoutEffect` cleanup to move wrapper back to hidden container before React unmounts it

## [0.13.37] - 2026-04-25

### Added
- **Eruda mobile console**: Add optional Eruda debug console for mobile debugging — activated via `?eruda` URL query parameter. Loads on-demand, no impact on normal usage

## [0.13.36] - 2026-04-25

### Fixed
- **Mobile tab overlap**: Tabs from non-focused panels overlapped in the visible panel's slot because their wrappers stayed reparented from a previous render. Now moves orphaned wrappers back to the hidden container when their panel slot isn't mounted

## [0.13.35] - 2026-04-25

### Fixed
- **Infinite re-render loop crashes app (React #185)**: `NotificationBellPopover` used `useProjectStore` selector returning new object without `useShallow` — zustand's `Object.is` comparison always detected "change", triggering infinite re-renders. Added `useShallow` to match all other components

## [0.13.34] - 2026-04-25

### Fixed
- **Infinite re-render loop (React #185) from DOM patches**: v0.13.29 preemptive `parentNode` check in `removeChild`/`insertBefore` silently skipped DOM operations, leaving React's state inconsistent → infinite retry loop. Switched to try/catch that only swallows `NotFoundError`, preserving normal DOM behavior

## [0.13.33] - 2026-04-25

### Added
- **Notification bell in project bar**: Bell button with unread session count badge in sidebar footer. Popover lists unread sessions grouped by project with session titles — click to navigate directly
- **Session titles in notifications**: Backend `getAllUnread()` JOINs session titles, WS broadcasts include `sessionTitle` for display in bell popover

### Fixed
- **Web title unread count inflated**: `selectTotalUnread` was summing event counts instead of counting sessions — reading one session could subtract multiple from the `(N)` title badge. Now counts unique sessions

## [0.13.32] - 2026-04-25

### Fixed
- **Windows restart timeout with old supervisor**: `ppm restart` command file approach requires supervisor v0.13.31+. Old supervisors ignore unknown `restart` action. Added fallback: if server PID doesn't change within 5s, kill server process directly — supervisor auto-respawns it

## [0.13.31] - 2026-04-25

### Fixed
- **Windows restart fails with SIGUSR2 error**: `ppm restart` on Windows threw `TypeError [ERR_UNKNOWN_SIGNAL]: Unknown signal: SIGUSR2` — Unix signals don't exist on Windows. Now writes command file that supervisor polls every 1s (same mechanism as upgrade). Also fixed `ppm start` sending SIGUSR1/SIGUSR2 directly on Windows for resume/upgrade paths

## [0.13.30] - 2026-04-25

### Fixed
- **Session read 404**: `clearForSession` in notification store called `/api/chat/sessions/{id}/read` — missing project prefix. Now uses `/api/project/{name}/chat/sessions/{id}/read`
- **Workspace sync 404 for `__global__`**: Virtual `__global__` project is not a real server project. Skip workspace fetch/sync to avoid 404 noise

## [0.13.29] - 2026-04-25

### Fixed
- **removeChild crash persists despite error boundaries (v0.13.27-28)**: Error boundaries cannot catch this — the error occurs in React's commit-phase DOM operations before React can route it to any boundary. Browser extensions inject DOM nodes that desync React's virtual DOM. Patched `Node.prototype.removeChild` and `insertBefore` to silently skip mismatched nodes (standard React #11538 workaround)

## [0.13.28] - 2026-04-25

### Fixed
- **removeChild crash still occurs (v0.13.27 boundary too deep)**: Error boundary was wrapping `MarkdownContent` only — the `removeChild` error fires higher up during React's commit phase at the `MessageBubble` level. Moved boundary to wrap each `MessageBubble` in the message list, so individual messages degrade to plain text instead of crashing the entire app

## [0.13.27] - 2026-04-25

### Fixed
- **Chat UI crashes with "removeChild" error, preventing page load**: `rehype-raw` in MarkdownRenderer creates DOM nodes that desync with React's virtual DOM. Browser extensions modifying the DOM worsen the issue. Added error boundary around markdown rendering — falls back to plain text instead of crashing the entire app
- **Compact history expansion refactored**: Replaced manual "Load more" button with IntersectionObserver sentinel that auto-loads previous messages and expands compact history when scrolled near top

## [0.13.26] - 2026-04-25

### Changed
- **Connection dot → reload button**: Green/red status dot replaced with RefreshCw icon + small status dot overlay. Click spins the icon and reloads chat messages (+ reconnects WS if disconnected)

## [0.13.25] - 2026-04-25

### Fixed
- **UI freezes after compaction — requires reload to see continuation**: `compact_status: done` handler called `refetchMessages()` mid-stream, which replaced all messages with REST history (killing the in-progress streaming message), then reset `streamingContentRef`/`streamingEventsRef`. Next `flushMessages` cycle overwrote the last REST message with empty content, making the UI appear frozen while SDK continued in the background. Fix: removed mid-stream refetch — the turn-end `phase→idle` handler already calls refetch safely after streaming stops
- **Compact indicator shows "Thinking..." instead of "Compacting messages..."**: During compaction, `phase` is `"thinking"` so `isStreaming` is true — the streaming ThinkingIndicator rendered with generic "Thinking..." label. The compact-specific indicator (`!isStreaming && compactStatus`) was dead code during actual compaction since it required `!isStreaming`. Fix: pass `"Compacting messages..."` as `statusMessage` to the streaming indicator when `compactStatus === "compacting"`, removed the dead `!isStreaming` branch

## [0.13.23] - 2026-04-25

### Fixed
- **systemd "not our child" prevents auto-restart**: When upgrading from v0.13.20 (old Bun.spawn path), systemd loses track of the new supervisor and silently ignores Restart=always on exit. Supervisor now self-heals on startup — detects stale unit file, regenerates it, and restarts through systemd to get properly tracked

## [0.13.22] - 2026-04-25

### Fixed
- **Tab state lost on move/split**: Moving or splitting tabs caused full component remount, losing chat scroll, terminal buffer, editor cursor/undo. Now uses DOM reparenting (TabPool) — components mount once and physically move between panel slots without unmounting

## [0.13.21] - 2026-04-25

### Fixed
- **systemd kills PPM during self-replace upgrade**: selfReplace() spawned a new supervisor via Bun.spawn() that systemd couldn't track ("not our child"), leading to service death on daemon-reload. Now exits cleanly under systemd and lets Restart=always bring it back with updated code
- **Service not auto-restarting**: Changed systemd Restart=on-failure → Restart=always so PPM always recovers regardless of exit reason
- **Autostart tests kill production PPM**: integration tests overwrote the real ppm.service file with test config and triggered daemon-reload, killing the running server. Tests now skip when PPM service is already active

## [0.13.20] - 2026-04-25

### Fixed
- **Loading messages flash on mobile**: "Loading messages..." screen flashed after every AI response and on WS reconnect (e.g. phone screen off/on). Now uses stale-while-revalidate — keeps current messages visible during background refetch

## [0.13.19] - 2026-04-25

### Fixed
- **Windows upgrade no auto-restart**: `ppm upgrade` on Windows upgraded files but didn't restart the server — SIGUSR1 doesn't exist on Windows. Now writes command file that supervisor polls every 1s
- **Windows path traversal rejection**: File tree lazy-loading and zip downloads failed on Windows hosts — `assertWithinProject` hardcoded `/` separator instead of `path.sep`
- **Upload response backslash paths**: Upload endpoint returned `input\file.jpg` on Windows instead of `input/file.jpg`, breaking frontend path matching

## [0.13.17] - 2026-04-25

### Fixed
- **Swipe-to-dismiss stale closure**: Bottom sheet swipe gesture could fail to dismiss due to stale `dragY` state in touch end handler — now uses ref for reliable threshold check
- **No upload progress feedback**: Dragging files into the file tree showed no visual feedback — now shows toast with loading spinner, success/error result
- **Duplicate Loader2 import**: Consolidated duplicate lucide-react import in file-tree.tsx

## [0.13.16] - 2026-04-25

### Added
- **File tree explorer overhaul**: VS Code-style file explorer with git decorations, inline rename/create, drag-to-move, cut/copy/paste, collapse all, keyboard navigation (arrow keys, Enter, F2, Delete), multi-selection (Ctrl+Click, Shift+Click), compact folders, reveal active file
- **File copy API**: `POST /files/copy` endpoint for copying files/folders within a project
- **File icon map**: 40+ file type icons with color coding in the explorer tree
- **Adaptive context menu**: Unified component (`adaptive-context-menu.tsx`) — right-click menu on desktop, long-press bottom sheet on mobile. Drop-in replacement for radix ContextMenu
- **Reusable bottom sheet**: Shared `BottomSheet` component with swipe-to-dismiss gesture, used by context menus, project selector, and mobile nav action sheets
- **Mobile detection hook**: Centralized `useIsMobile()` hook for reactive breakpoint checks

### Changed
- **Project bottom sheet**: Migrated to shared `BottomSheet` component with swipe-to-dismiss
- **Mobile nav action sheets**: Migrated to shared `BottomSheet` component with swipe-to-dismiss
- **File tree modularized**: Split into tree-node, context menu, inline input, keyboard nav, file upload drag, and file icon map modules

### Fixed
- **Double context menu on mobile**: Nested radix ContextMenus caused two menus to open on long-press — resolved by adaptive component with stopPropagation
- **File opens during long-press**: Click event suppressed after long-press context menu trigger on mobile
- **Git folder decorations broken**: `isDir` variable used before declaration in tree-node git status selector
- **Missing useState import**: `useState` removed from file-tree.tsx imports but still used — restored
- **Global clipboard shortcuts**: Ctrl+X/C/V was intercepting all keyboard events globally — scoped to file tree container focus

## [0.13.15] - 2026-04-24

### Fixed
- **File compare with absolute paths**: Comparing files outside the project (e.g. `/tmp/`) no longer fails with "Path traversal not allowed" — absolute paths now use `readSystemFile` instead of project-scoped read

## [0.13.14] - 2026-04-24

### Fixed
- **DB CLI run multi-statement**: PostgreSQL `ppm db run` now splits SQL into individual statements and executes within `sql.begin()` transaction. Handles strings, comments, dollar-quoting. Strips user-supplied `BEGIN`/`COMMIT`/`ROLLBACK` to avoid conflicts with managed transaction

## [0.13.13] - 2026-04-24

### Added
- **DB CLI run command**: `ppm db run <name> <file.sql>` executes SQL files against saved connections. Supports multi-statement files and transactions (`BEGIN...COMMIT`). Respects readonly flag. Works with both SQLite (`db.exec()`) and PostgreSQL

## [0.13.12] - 2026-04-24

### Fixed
- **CLI project add/remove missing config**: `configService.load()` now called before project operations in CLI context to ensure SQLite config is loaded
- **Project sync data loss on SIGKILL**: `syncProjectsToDb` wrapped in transaction — DELETE + INSERT are atomic, preventing wiped project list on forced kill
- **Supervisor stale device name**: `device_name` is now read directly from SQLite instead of in-memory `configService` cache, which was never updated when server process wrote changes

## [0.13.11] - 2026-04-24

### Fixed
- **Chat input lag on text selection**: Shift+arrow, Ctrl+A, Ctrl+C keystrokes in textarea no longer run through 21+ global keybinding checks — early return guard skips all but save-prevent (Mod+S) when focus is inside text inputs
- **Chat input re-renders from file store**: MessageInput now uses imperative Zustand subscribe() instead of hook selectors, preventing re-renders on file index updates
- **Inline lambda breaking MessageInput memo**: Stabilized `onExternalPathsConsumed` callback with useCallback in ChatTab
- **Streaming re-renders blocking main thread**: Replaced requestAnimationFrame (~16ms/60fps) with setTimeout(100ms) throttle and wrapped setMessages in startTransition for low-priority rendering

## [0.13.9] - 2026-04-23

### Added
- **Inline SQL result panel**: Run button in .sql files now executes queries inline, showing results in a bottom panel with DataGrid (supports eye icon preview, export, etc.). "Open in Tab" button opens full DB Viewer for advanced use
- **Resizable preview panels**: Both DataGrid cell/row preview and SQL result panels now have drag-to-resize handles (min 80px)

## [0.13.8] - 2026-04-23

### Added
- **DB viewer inline preview panel**: Eye icon opens a Monaco editor preview panel at the bottom of the data grid with syntax highlighting, beautify (JSON/XML), and word wrap toggles. "Open in Tab" button creates uniquely-named tabs (e.g. `Row #42 — users`) for side-by-side comparison

### Fixed
- **DB viewer duplicate "Untitled" tabs**: Cell/row viewer tabs now have unique IDs via `viewerKey` metadata in `deriveTabId`, allowing multiple viewer tabs to coexist
- **Inline content tab title override**: Code editor no longer overrides caller-set titles for inline content tabs to "Untitled"
- **Tab hover tooltip**: Tab bar now shows full title on hover for truncated tab names

## [0.13.7] - 2026-04-23

### Added
- **Mobile code editor toolbar**: Bottom toolbar on touch devices with paste, undo/redo, tab and 18 symbol keys (brackets, quotes, operators). Matches terminal toolbar pattern. Paste uses Clipboard API on HTTPS, textarea fallback on HTTP. Visual viewport tracking keeps toolbar above mobile keyboard

## [0.13.6] - 2026-04-22

### Added
- **Mobile tab tag left-edge bar + amber streaming icon**: Tab tag indicator mirrors desktop left-edge bar style on mobile. Streaming icon uses amber color for consistency with favicon streaming indicator

### Fixed
- **Fork fails on compacted sessions ("Message not found")**: After SDK compaction, old message UUIDs are purged from session JSONL. Forking at a pre-compaction message threw 500. Now catches the error and falls back to a fresh session — user's message is still pre-filled in the new tab

## [0.13.5] - 2026-04-22

### Fixed
- **Tunnel URL changes shortly after upgrade (WSL/systemd)**: Adopted tunnel was dying ~10-15s after old supervisor exited during self-replace upgrade, forcing a tunnel respawn with a new trycloudflare URL. Root cause: `Bun.spawn(..., { stderr: "pipe" })` tied cloudflared's stderr to a pipe held by the *old* supervisor; when that supervisor exited, the pipe's read-end closed and cloudflared received `SIGPIPE` on its next periodic log write (typical cadence ~10-15s). `systemd-run --scope` wrapping did NOT protect against this because `--scope` inherits stdio from the invoker. Fix: redirect cloudflared stderr to `~/.ppm/cloudflared.log` (file fd, not pipe). URL extraction polls the file instead of reading the pipe stream. Tunnel now survives parent exit cleanly — adopted URL persists across upgrades

## [0.13.4] - 2026-04-22

### Fixed
- **Expand compact duplicated post-compact messages + scrollbar jumped**: Claude's compact summary references the CURRENT session JSONL (pre+summary+post in one file), so parsing the whole file and prepending re-inserted the compact marker and every post-compact message. Frontend now sends the compact message's raw uuid as `&before=<uuid>`; `parseJsonlTranscript` stops at that line (exclusive) so only pre-compact messages return. For nested expansions, the `pc-{hash}-` prefix is stripped before sending so the recursive boundary resolves correctly. Also added a manual scroll anchor — `ScrollAnchorBridge` captures `scrollTop`+`scrollHeight` before the prepend and restores `scrollTop + (newHeight - oldHeight)` after the commit (skipped when user is at bottom so `use-stick-to-bottom` retains control). Replaces the CSS `overflow-anchor: auto` fallback which was unreliable on large prepends
- **Command palette: `.git` files leaked into results + `.env` was missing**: Two compounding bugs. (1) Glob regex treated `**/X` as requiring at least one parent segment, so hardcoded `**/.git` exclude silently failed at repo root — users searching for e.g. `refs` got flooded with `.git/refs/heads/...` entries. (2) Gitignore logic hard-excluded all ignored paths, so `.env` never reached the index. Fix:
  - `globPatternToRegex`: detect `**/` prefix, emit `(^|.*/)X(/|$)` so root-level matches work
  - `walkForIndex`: soft-exclude gitignored FILES (surface with `isIgnored: true` flag), hard-exclude gitignored DIRECTORIES (skip recursion to avoid walking huge dirs)
  - Palette: render `isIgnored` entries with `opacity-60` + tooltip so `.env` shows up visibly-muted, distinguishable from tracked files
  - Tests updated — previously asserted the buggy behavior as correct

## [0.13.3] - 2026-04-22

### Added
- **File Compare** — Side-by-side diff viewer for comparing two files or file versions
  - Four ways to trigger: (1) tab context menu "Select for Compare" / "Compare with Selected", (2) file tree context menu (same), (3) command palette "Compare Files...", (4) keyboard shortcut `Mod+Alt+D`
  - Reuses existing `DiffViewer` component + `/files/compare` API endpoint
  - Supports dirty buffer content: unsaved editor changes captured at select-time
  - New zustand store `useCompareStore` persists selection across reload (strips dirty content >500KB)
  - Auto-clears selection on project switch
  - New keybinding action `compare-files` with customizable default `Mod+Alt+D`

### Changed
- **Tab tag indicator moved to left-edge bar (VS Code style)**: Previously, tag colored the chat icon directly — caused false positives where untagged active tabs looked tagged (inherited `text-primary` blue). Now tag renders as a floating `2px × 60%-height` rounded-right bar at `left-0` of the tab wrapper. Zero layout shift (absolute positioned), no conflict with `border-b-2` active indicator. Icon color reverts to normal active/inactive states
- **Streaming icon + typing dots now amber** (matches favicon streaming color `#f59e0b`) so the "in process" signal is consistent across tab icon and browser favicon. Applied via `text-amber-500` on icon wrapper during `isStreaming`; dots inherit via `bg-current`

### Fixed
- **Compact indicator stuck after turn ends**: `compactStatus="compacting"` was only cleared by a matching `compact_boundary` from the SDK. SDK can emit `status: compacting` without a subsequent boundary (turn finishes first, stream tears down, or compaction is deferred), so the indicator stayed on the UI even after the session returned to idle. Fix:
  - Server persists `compactStatus` on `SessionEntry` and force-clears + broadcasts `compact_status: done` on turn `done` and in the consumer `finally` block (covers errors, closes, deferred compaction)
  - `session_state` payload now carries `compactStatus` on connect / reconnect / `ready`, so late-joining clients see authoritative state instead of stale/missing updates
  - Client clears `compactStatus` on `phase_changed → idle` as a belt-and-braces guard and honors `state.compactStatus` in `session_state`
  - Debug logs added under `[chat] session=<id> compact_status=…` for each transition (set / boundary / cleared-on-done / cleared-on-teardown) to make regressions easy to diagnose

## [0.13.2] - 2026-04-21

### Changed
- **Chat tab badges redesign** — reduced visual noise from 3 separate indicators to integrated icon states:
  - **Tag**: removed left-side color dot, now colors the chat icon itself. Untagged tabs force neutral gray (`text-text-secondary`) regardless of active state, so they don't get confused with blue-tagged tabs when active (`text-primary` was leaking into icon)
  - **Streaming**: replaced top-right pulsing green dot with **Messenger-style typing dots** bouncing inside the chat bubble icon (3× `size-[2px]` circles using `bg-current` + staggered `animationDelay`). Added `tabTypingBounce` keyframe (1.5px translate, 1s loop) to `globals.css` with `prefers-reduced-motion` fallback
  - **Notification**: unchanged — still top-right colored dot when unread and tab inactive
- **Favicon streaming indicator** — replaced blue/amber flash with **typing dots animation** on amber background (`#f59e0b`, high-attention) for better peripheral visibility. Pre-encodes 4 frames (3 active positions + 1 rest frame — rest frame makes cycle boundary perceptible so all 3 dots appear to bounce equally) cycled every 300ms. `setFavicon()` signature changed: second arg is now `streamingFrame: number | null` (null = idle) instead of `isStreamingAlt: boolean`. Exports `STREAM_FRAME_COUNT` for DRY cycling in `useNotificationBadge`

## [0.13.1] - 2026-04-21

### Fixed
- **WSL/Linux upgrade killed entire PPM stack (100% repro)**: Under `systemd` with `Type=simple`, the old supervisor's `process.exit(0)` at the end of `selfReplace()` triggered `KillMode=mixed` cgroup cleanup that SIGKILLed the freshly-spawned new supervisor along with server + cloudflared. Root cause: `Bun.spawn + unref()` does not escape the unit cgroup. Fix combines two changes:
  - **Type=notify + MAINPID handoff**: Generated systemd unit now uses `Type=notify` / `NotifyAccess=all`. New supervisor sends `READY=1` via `sd_notify` on startup; during `selfReplace()`, old supervisor sends `MAINPID=<new_pid>` so systemd re-tracks the new supervisor as MainPID *before* the old one exits — cgroup is preserved instead of torn down
  - **Tunnel in transient systemd scope**: `spawnTunnel()` now wraps `cloudflared` in `systemd-run --user --scope --quiet --collect` when running under systemd, hoisting the tunnel into its own cgroup so the trycloudflare URL survives ppm.service restarts (even the worst-case one). Preserves `adoptTunnel()` domain continuity across upgrades
  - **Auto-migration**: `ppm start` detects stale unit files missing `Type=notify` and regenerates them silently; user runs one `systemctl --user restart ppm.service` after first upgrade to pick up the new unit

### Added
- **`src/services/sd-notify.ts`**: Thin wrapper around `systemd-notify` binary for `READY=1` / `MAINPID=` messages. No-op when `NOTIFY_SOCKET` is unset (non-systemd)
- **`isAutoStartUnitStale()` helper**: Detects outdated systemd unit files so `ppm start` can regenerate them inline

## [0.13.0] - 2026-04-21

### Added
- **`ppm export skill`**: Install a Claude Code skill at `~/.claude/skills/ppm/` so external AI agents can control PPM via its CLI, HTTP API, and SQLite config DB. Flags: `--install`, `--scope user|project`, `--output <dir>`, `--format claude-code`. Generates `SKILL.md` + `references/{cli-reference,http-api,db-schema,common-tasks}.md`. CLI/HTTP references are auto-generated at build time by walking the Commander tree and scanning Hono route files. DB schema is generated at install time from the user's `~/.ppm/ppm.db` (opened readonly). Re-install is safe: existing files are renamed to `<name>.bak-<YYYYMMDDHHmm>` before overwrite. Preview mode (no `--install`/`--output`) writes the merged `SKILL.md` to stdout.
- **`buildProgram()` export in `src/index.ts`**: Module now exports the assembled Commander tree without parsing argv, enabling build-time introspection for auto-generated docs. Runtime behavior preserved via `import.meta.main` guard.

### Changed
- **Generator rename**: `scripts/generate-ppm-guide.ts` → `scripts/generate-ppm-skill.ts` (plus `scripts/lib/` modules). Output moved from `assets/skills/ppm-guide/` → `assets/skills/ppm/`. `npm` scripts: `generate:guide` → `generate:skill`; `prepublishOnly` updated.

## [0.12.12] - 2026-04-21

### Fixed
- **Login broken when using `--share` without profile**: The `--share` flag was positionally parsed as a DB profile name in both supervisor and server child, causing them to read `ppm.--share.db` (with a random auto-generated token) instead of `ppm.db`. Users saw perpetual "Unauthorized" on login despite entering the correct token

### Added
- **Expand compacted conversation**: When Claude compacts context and references a JSONL transcript (`read the full transcript at: ...`), the chat now shows a "Load previous conversation" button. Clicking fetches pre-compact messages via `GET /chat/pre-compact-messages?jsonlPath=...` and **prepends them into the main message list above the compact card** (natural Messenger-style UX) — scroll up to view history, and nested compact summaries in loaded history show their own button for recursive expansion. Expansions are ephemeral (reset on session switch). Extracted shared JSONL parsing into `src/services/jsonl-transcript-parser.ts`. Path validated strictly under `~/.claude/` (symlink-resolved realpath) with a 50MB size guard
- **Full-content diff endpoint**: `GET /git/file-full-diff?file=&ref=` returns original (ref) and modified (working tree) file contents for Monaco DiffEditor

## [0.12.11] - 2026-04-21

### Fixed
- **Upgrade wiped user config back to defaults**: `configService.importFromYaml()` unconditionally overwrote SQLite config keys with `{...DEFAULT_CONFIG, ...yaml}` on every `load()` call. The upgrade path via supervisor `selfReplace()` re-ran the saved `originalArgv` — which contained `-c <yaml>` baked into systemd/launchd `ExecStart` — re-triggering the overwrite and resetting user config to defaults + stale YAML contents

### Removed
- **Legacy YAML config support**: Fully migrated to SQLite; removed `-c/--config <path>` CLI flag (from `start`, `restart`, `open`, `autostart enable`), YAML import/migration code, `configPath` in autostart ExecStart, and `__serve__`/`__supervise__` positional config slot. `js-yaml` dep retained (skill frontmatter only)

## [0.12.10] - 2026-04-21

### Fixed
- **Auth retry stuck across turns**: `authRetried` was a per-session boolean, so the second 401 in any subsequent turn skipped token refresh and the stream hung. Replaced with per-turn counter (`authRetryCount`, max 2) that resets on each successful turn, so every turn gets a fresh refresh budget
- **Multi-attempt auth recovery**: Centralized auth-error recovery in `recoverFromAuthError` — attempt 1 refreshes the current account's OAuth token, attempt 2 switches to a different active account, only then surfaces an error. All three 401 detection paths (`api_retry`, assistant text, result) share this logic
- **api_retry 401 stall**: When no recovery path remains, break immediately instead of falling through to SDK's internal 10x retry (which wasted ~5 minutes before surfacing the error)

## [0.12.9] - 2026-04-21

### Fixed
- **Synthetic auth error leaking into history**: Filter SDK-persisted error messages (`isApiErrorMessage: true`, `error` field, or `model: "<synthetic>"` with auth/rate-limit text) when loading session history — raw "Failed to authenticate. API Error: 401 …" no longer shows up as an assistant bubble after reload

## [0.12.8] - 2026-04-21

### Changed
- **Bash tool header**: Show `description` in the tool card summary instead of the raw command — command still visible in the expanded details

### Fixed
- **TypeScript errors**: Add `session_migrated` variant to `ChatEvent`, replace out-of-scope `writeLog` in server bootstrap with `console.warn`, guard `split("-")[0]` in semver compare, relax `token` to optional in Jira store `saveConfig`, and fix `@/types/project` imports in file-store helpers (alias resolves to `src/web/*`)

## [0.12.7] - 2026-04-21

### Fixed
- **Code block scrollbar overlapping text**: Reserve bottom gutter on markdown `<pre>` blocks so overlay-style horizontal scrollbars no longer cover the last line
- **Code block theme mismatch**: Highlight.js syntax theme now swaps with light/dark mode (github light / github-dark-dimmed) — removed forced-dark `pre` override in light mode

## [0.12.6] - 2026-04-20

### Fixed
- **CLI db commands hang (postgres)**: Close postgres connection pool after CLI operations — cached pool's 5min idle timer was keeping the process alive
- **CLI db commands hang (sqlite)**: Same issue — close sqlite cached connections after CLI operations

## [0.12.5] - 2026-04-20

### Fixed
- **CLI db commands hang**: Close postgres connection pool after CLI operations (`db test`, `db tables`, `db schema`, `db data`, `db query`) — cached pool's 5min idle timer was keeping the process alive

## [0.12.4] - 2026-04-20

### Fixed
- **Auth retry content leak**: Reset streaming state (`lastPartialText`, `assistantContent`) on retry — prevents stale error text from suppressing retry response
- **Error text not cleared on retry**: Frontend now clears previous streaming events on `account_retry`, removing "Failed to authenticate" text before showing retry response

## [0.12.3] - 2026-04-20

### Added
- **Claude Opus 4.7 model support**: Add `claude-opus-4-7` as available model across SDK provider, CLI init, proxy test UI, and config validation (coexists with Opus 4.6)

## [0.12.2] - 2026-04-20

### Fixed
- **Quota exhaustion auto-retry**: Detect "You've hit your limit" SDK message as rate limit — triggers account rotation and retry instead of showing raw error
- **False success on error results**: `onSuccess()` no longer called when SDK result has error subtype, preventing failed accounts from staying active
- **Assistant text quota detection**: Detect quota limit messages in assistant text content (not just error field), covering all SDK delivery paths

## [0.12.1] - 2026-04-20

### Added
- **Tab bar tag support**: Color dot and right-click "Set Tag" context menu on chat tabs in the tab bar

## [0.12.0] - 2026-04-20

### Added
- **Session tagging**: Per-project tags (Todo, In Progress, Review, Done) with color-coded dots on session rows
- **Tag management UI**: Create, edit, delete, reorder tags in project settings; set default tag for new sessions
- **Tag filter chips**: Filter sessions by tag across History panel, ChatWelcome, and EditorPanel landing
- **Context menu on sessions**: Right-click (or long-press mobile) for Pin, Rename, Set Tag, Delete — available in all session lists
- **Keyboard shortcuts**: Press 1-9 in History panel to quick-assign tags to active session
- **Bulk tag endpoint**: PATCH /chat/sessions/bulk-tag for multi-session tagging (max 100)
- **Tag CRUD API**: Full REST endpoints under /projects/:path/tags with cross-project authorization
- **Auto-tag new sessions**: Sessions auto-get project's default tag on creation

### Fixed
- **Tag persistence**: setSessionTag now uses UPSERT so tags persist for sessions discovered from JSONL (missing session_metadata rows)
- **Route ordering**: Literal routes (default-tag, bulk-tag, reset) registered before parameterized /:id routes to prevent Hono mismatch
- **Tag count accuracy**: Counts refetched from API after tag changes instead of fragile client-side optimistic updates

## [0.11.18] - 2026-04-20

### Fixed
- **Tunnel domain loss on upgrade**: Supervisor startup was wiping tunnelPid/shareUrl from status.json before adoptTunnel() could read them; now preserves tunnel info when previous state is "upgrading"

## [0.11.17] - 2026-04-20

### Fixed
- **DB viewer column jump**: Remove smooth scroll animation for instant column navigation
- **DB connection error display**: Show actual connection errors (e.g. "Connection timed out", "connect ECONNREFUSED") instead of generic "No tables cached"
- **DB route timeout**: Add 15s timeout to database routes to prevent proxy 502 on unreachable hosts
- **API client JSON parsing**: Handle empty/broken proxy responses gracefully instead of cryptic JSON parse errors

### Improved
- **Connection import**: Auto-refresh table cache for newly imported connections

## [0.11.16] - 2026-04-20

### Fixed
- **Tool card text selection**: Add `select-text` to expanded tool card content so users can select/copy file paths, bash output, and other tool details in chat

## [0.11.15] - 2026-04-20

### Fixed
- **Slash command display in chat**: Parse `<command-message>/<command-name>/<command-args>` XML tags and render as styled chip instead of raw text
- **Extension tab auto-reopen**: Track recently closed extension viewTypes to prevent auto-reopen when extension sends `webview:create` after user intentionally closed the tab

## [0.11.14] - 2026-04-20

### Fixed
- **External file preview (image/PDF/video/audio)**: Files opened from filesystem search (e.g. `/tmp/`) now load correctly — `useBlobUrl` routes absolute paths through `/api/fs/raw` instead of project-scoped endpoint that returned 403

## [0.11.13] - 2026-04-20

### Fixed
- **Slash command search flicker**: Move fuzzy search from server-side to client-side — eliminates 200ms flicker caused by debounced API calls replacing instant client filter results

## [0.11.12] - 2026-04-20

### Fixed
- **Command palette search ranking**: Replace boolean fuzzy filter with 6-tier scoring — exact filename matches now rank first instead of last

## [0.11.11] - 2026-04-20

### Added
- **Real-time bash output streaming**: Chat displays live incremental bash output during tool execution via WebSocket, with cross-platform support (Linux/macOS)

### Fixed
- **Supervisor port-race during upgrade**: SIGKILL + process group kill + port-availability polling replaces unreliable 500ms sleep; server startup retries port check 4x before exit

## [0.11.10] - 2026-04-19

### Added
- **File type icons**: Explorer tree now shows distinct icons for 50+ file extensions — images, videos, audio, databases, archives, spreadsheets, and language-specific code icons with color coding

## [0.11.9] - 2026-04-19

### Added
- **Streaming favicon indicator**: Favicon alternates between blue and amber when any chat tab is streaming an AI response; notification badge preserved during animation
- **Streaming tab icon indicator**: Chat tabs show a pulsing emerald dot on the icon while streaming, replacing the static notification badge during active streams

## [0.11.8] - 2026-04-19

### Fixed
- **Supervisor shutdown timeout**: Use SIGKILL for child processes instead of SIGTERM — prevents 90s systemd timeout caused by orphaned grandchildren (Claude SDK subprocesses)
- **Supervisor signal handler**: Add 5s force-exit safety net if `process.exit(0)` doesn't terminate
- **Tunnel retry overflow**: URL extraction failure path now respects MAX_RESTARTS and resets counter after stable window (previously retried infinitely)

### Improved
- **Supervisor logging**: All supervisor logs now write to stderr so `journalctl` captures full lifecycle events
- **Tunnel exit logging**: Log exit code and signal when tunnel process dies for easier debugging
- **systemd service hardening**: Add `TimeoutStopSec=10` and `KillMode=mixed` to generated service unit

## [0.11.7] - 2026-04-19

### Added
- **Video preview**: Open video files (mp4, webm, mov, ogg, avi, mkv) in editor tabs with native playback controls
- **Audio preview**: Open audio files (mp3, wav, flac, aac, m4a, wma) in editor tabs with native audio controls

### Refactored
- Extract ImagePreview, PdfPreview into separate files with shared `useBlobUrl` hook (DRY)

## [0.11.6] - 2026-04-19

### Added
- **Real-time editor reload**: Editor tabs auto-reload when files change on disk (external edits, AI chat, drag-drop upload) via `fs.watch` + WebSocket; skips reload if unsaved changes exist
- **Real-time file tree refresh**: Explorer sidebar auto-refreshes on file system changes instead of only on window focus

## [0.11.5] - 2026-04-19

### Fixed
- **Silent message loss on fast streaming**: Race condition where assistant response was never rendered — `done` event cancelled pending rAF before content flushed to React state; now creates assistant message from accumulated refs when no flushed message exists
- **Upload auto-expand**: File explorer now auto-expands the target folder after drag-and-drop upload so newly uploaded files are immediately visible

## [0.11.4] - 2026-04-19

### Fixed
- **AskUserQuestion re-prompting on reconnect**: Replaying turn_events no longer re-triggers already-answered AskUserQuestion dialogs; server enriches answered approvals with response data, client skips stale setPendingApproval during replay
- **Missing user messages on reconnect**: User messages for in-progress turns were lost during WS reconnect; server now includes the current turn's user message in turn_events payload, client uses targeted truncation instead of dropping completed history

## [0.11.3] - 2026-04-19

### Added
- **Drag-and-drop file upload**: Drag files from OS file manager into explorer sidebar to upload; drop on folder targets that folder, drop on blank area targets project root
- **Upload limits**: 50MB per file, 20 files per drop, path traversal protection

## [0.11.2] - 2026-04-19

### Fixed
- **Token refresh on 401**: Force actual OAuth refresh when API returns 401, even if token appears fresh by expiry timestamp — fixes intermittent "Token refreshed" message that didn't actually refresh

## [0.11.1] - 2026-04-19

### Added
- **Explorer toolbar**: New File, New Folder, and Refresh buttons always visible at top of file explorer
- **Blank-area context menu**: Right-click anywhere in empty explorer space to create files/folders or refresh

## [0.11.0] - 2026-04-19

### Added
- **Jira Debug Sessions**: New debug session service replaces bot_task flow — enqueue, resume, cancel debug sessions for Jira results with SDK integration and WS streaming
- **Jira sidebar panel**: Dedicated Jira tab in sidebar (desktop) and mobile drawer with unread badge, ticket cards, watcher form, filter builder, and debug prompt dialog
- **Jira unread tracking**: `read_at` column on results, unread count API, badge on sidebar tab
- **Jira test JQL endpoint**: `POST /watchers/test-jql` to validate JQL queries against live Jira
- **Jira baseline poll**: First auto-poll sets `last_polled_at` without inserting results, preventing flood of old tickets
- **File browser: New Folder**: Create folders with `git init` directly from FileBrowserPicker via `POST /api/fs/mkdir`
- **File browser: Delete Folder**: Remove folders from FileBrowserPicker via `DELETE /api/fs/rmdir` with confirmation
- **WS broadcast helpers**: `broadcastGlobalEvent()` and `forwardEventToSession()` for background processes to stream events to frontend
- **Jira WS events**: Global `jira:*` events dispatched via `window.dispatchEvent` for real-time UI updates
- **Drag files to chat**: Drag files from explorer directly into chat input

### Fixed
- **Extension first-load failure**: Broken WS proxy caused extensions to fail on initial load
- **Git graph SVG alignment drift**: Fixed mobile detail panel and alignment issues
- **Copy button drift on scroll**: Prevented copy button from drifting on horizontal scroll in code blocks
- **Jira config form sync**: Form state now syncs when existing config loads asynchronously
- **Jira search API migration**: Migrated to `/search/jql` API with correct params, fallback to classic endpoint
- **Jira filter display names**: Show display names instead of account IDs in filter chips
- **Bot task FK errors**: Gracefully handle FK errors during Jira poll instead of crashing entire poll
- **Soft-deleted result resurrection**: `insertResult` now resurrects soft-deleted duplicates instead of silently skipping

### Changed
- **Jira settings → sidebar toggle**: Jira moved from settings category to a toggle switch + dedicated sidebar tab
- **DB migration v19**: Added `read_at`, `triggered_by` columns; index for unread count; cleanup stale running results
- **Watcher poll source tracking**: `pollWatcher()` now accepts `source` param (`auto`/`manual`) for triggered_by tracking

## [0.10.5] - 2026-04-16

### Fixed
- **Stale status.json after supervisor restart**: `ppm status` showed dead PIDs when supervisor restarted on a different port. Supervisor startup now does a full write (not patch) to clear stale data from previous runs. `updateStatus()` logs errors instead of silently swallowing them.
- **Auth token for extensions**: Extensions (git-graph) and frontend components now include Bearer auth token in all fetch() calls to PPM API, fixing 401 errors when auth is enabled.
- **WS message queuing**: `WsClient.send()` queues messages during reconnection instead of dropping them.

### Improved
- **Git-graph touch layout**: Uses `pointer: coarse` media query instead of `max-width: 768px` for more accurate touch device detection with compact row sizing.

## [0.10.4] - 2026-04-16

### Fixed
- **Restore markdown rendering during streaming**: Reverted plain-text bypass that prevented markdown (tables, headers, code blocks) from rendering while assistant is streaming. Full `MarkdownRenderer` now runs during streaming again.

## [0.10.3] - 2026-04-16

### Performance
- **CSS `field-sizing: content` for native textarea auto-resize**: Use browser-native auto-sizing instead of JavaScript `scrollHeight` reads. Eliminates forced synchronous layout reflow on every keystroke. JS resize kept as fallback for browsers without `field-sizing` support (Safari 18.2+, Chrome 123+).
- **CSS `contain: strict` on message list**: Prevents textarea resize from triggering layout recalculation of the entire message list DOM tree. Browser can skip message layout when only the input area changes.

## [0.10.2] - 2026-04-16

### Performance
- **Uncontrolled textarea for chat input**: Converted chat input from React controlled (`value={state}`) to uncontrolled (`defaultValue` + ref). Eliminates React re-render on every keystroke — browser handles text input natively. Fixes input lag on Chromium-based browsers (Coc Coc) on iPad where React's `textarea.value` re-assignment caused jank. Safari was unaffected because WebKit optimizes same-value assignments.
- **Picker state callback deduplication**: Track slash/file picker open state in refs; only call parent `onSlashStateChange`/`onFileStateChange` when state actually transitions. Previously called on every keystroke even when pickers were already closed.

## [0.10.1] - 2026-04-16

### Performance
- **Plain text during streaming**: Bypass heavy `MarkdownRenderer` (6 plugins: remarkGfm, remarkMath, remarkBreaks, rehypeRaw, rehypeKatex, rehypeHighlight) during active streaming. Renders plain text with `whitespace-pre-wrap` while tokens arrive, then switches to full markdown once streaming ends. Eliminates the dominant per-frame cost on iPad/mobile.

## [0.10.0] - 2026-04-16

### Performance
- **Pre-parsed keybinding combos**: Cache `ParsedCombo` objects on store load/override instead of calling `parseCombo()` on every keydown. Eliminates 21+ object allocations per keystroke. Extension keybindings also cached.
- **rAF-debounced textarea auto-resize**: Batch height recalculation via `requestAnimationFrame` instead of forcing synchronous layout reflow on every keystroke. Significant improvement on mobile/tablet.
- **Early-exit picker state updates**: Skip regex matching and parent callbacks in `updatePickerState` when text has no `/` or `@` characters. Avoids unnecessary work on most keystrokes.
- **CSS `select-none` on chat chrome**: Non-text elements (tool cards, buttons, icons, badges) marked `select-none`; only actual message text is selectable. Reduces browser selection computation cost on Cmd+A.

## [0.9.98] - 2026-04-15

### Fixed
- **Auto-start service crash recovery**: `ppm start` now starts via systemd/launchd when autostart was previously enabled, giving OS-level crash recovery (Restart=on-failure). Changed systemd from `Restart=always` to `Restart=on-failure` so `ppm stop` works cleanly.
- **`ppm stop` vs service manager conflict**: `ppm stop --all` and hard-stop now stop the system service first (systemctl stop / launchctl bootout) before killing processes, preventing the service manager from immediately restarting the supervisor.
- **Auto-enable autostart on first `ppm start`**: Server auto-registers with systemd/launchd after successful startup (with `skipStart` so it doesn't double-spawn).

### Performance
- **Chat input lag during streaming**: Extracted inline `onSend` and `onSlashItemsLoaded` callbacks into stable `useCallback` refs in ChatTab, so `memo(MessageInput)` correctly skips re-renders during streaming token updates.
- **Streaming render throttle**: `syncMessages` now batches rapid WS events via `requestAnimationFrame` instead of triggering a React render on every token. Reduces re-renders from hundreds/sec to ~60fps max.

## [0.9.97] - 2026-04-15

### Fixed
- **Git Graph duplicate stash entries**: Same stash appeared twice — once as `refs/stash` from `git log --all` and once as `stash@{0}` from `git stash list`. Excluded `refs/stash` from log query since stashes have dedicated rendering.

## [0.9.96] - 2026-04-15

### Fixed
- **Git Graph infinite reload loop on project switch**: Extension dispose→recreate during project switch briefly set panel to undefined, triggering reload-recovery effect which dispatched the command again — infinite loop. Fixed by checking `prevProjectRef` before dispatch.

## [0.9.95] - 2026-04-15

### Fixed
- **Extension webview infinite error toasts**: Removed retry loop that dispatched `ext:command:execute` every 2s with no limit, causing infinite error toasts when extension failed to activate. Now dispatches once — user closes and reopens tab to retry. Load timeout reduced from 10s to 5s.

## [0.9.94] - 2026-04-15

### Performance
- **Zustand useShallow**: Added shallow selectors to 17 store consumers to prevent unnecessary re-renders on unrelated state changes
- **React.memo**: Wrapped 11 heavy components (CodeEditor, MessageBubble, ProjectBar, TerminalTab, PanelLayout, Sidebar, StatusBar, TabBar, TreeNode, etc.)
- **Lazy loading**: MarkdownRenderer, mermaid, and CodeMirror loaded on demand via React.lazy/dynamic import
- **Code splitting**: Vite manualChunks splits vendor-monaco, vendor-mermaid, vendor-xterm, vendor-markdown, vendor-ui into separate cached chunks
- **Chat pagination**: Display last 50 messages with load-more button for long conversations
- **Team message cap**: Capped team activity accumulation at 500 messages to prevent unbounded memory growth

## [0.9.93] - 2026-04-15

### Fixed
- **Infinite tab creation on project switch**: Switching projects with Git Graph open no longer creates 99+ duplicate tabs. Fixed dedup logic in `webview:create` handler to detect existing tabs with `@panelId` suffix variants, and prevented double-dispatch from reload + project-sync effects.

## [0.9.92] - 2026-04-15

### Fixed
- **Webview panel lifecycle**: Closing a git-graph tab now properly disposes the panel on the extension side. Previously, the extension kept a stale `activePanel` reference and refused to create a new panel on reopen.
- **Git Graph broken after stash visualization**: Stash virtual commits were inserted after parent in array but graph algorithm scans forward — graph silently broke when stashes existed. Fixed insertion order (stash before parent, same pattern as uncommitted).

## [0.9.90] - 2026-04-15

### Added
- **Git Graph stash branch visualization**: Stashes now render as separate branch spurs from their parent commit in the graph (like VSCode Git Graph). Grey branch lines, `stash@{N}` badge, and right-click context menu (Apply/Pop/Drop).

### Fixed
- **Wrong project loading in Git Graph**: Fixed bug where switching projects would show the previous project's commits. ExtensionWebview now always dispatches the command on mount to ensure correct project data.

## [0.9.88] - 2026-04-15

### Fixed
- **Git Graph spacing too large**: Reduced font sizes, row heights, padding, and column widths across toolbar, commit rows, detail panel, and all UI elements for a tighter, more compact layout.

## [0.9.87] - 2026-04-15

### Added
- **Git Graph stash management**: Toolbar popover with stash count badge, list all stashes with Apply/Pop/Drop actions, "Stash Changes" button.
- **Git Graph rebase context menu**: "Rebase current branch onto this..." in commit context menu with confirmation dialog.
- **Conflict detection & merge state display**: Parse UU/AA/DD status codes, detect merge/rebase/cherry-pick state from .git sentinel files, show conflict section + banner with Continue/Skip/Abort.
- **Inline conflict resolution editor**: Monaco-based editor with colored decorations (green current, blue incoming) and Accept Current/Incoming/Both buttons.
- **Extension error reporting**: Error toasts for extension command failures, activation error tracking and display on browser connect.
- **Extension breadcrumb logging**: `[ExtService]`, `[ExtHost]`, `[ExtWS]`, `[ext-git-graph]` tagged console.log at each pipeline step.

### Fixed
- **Extension silent failure**: Extensions that failed to activate or execute commands now show error toasts instead of spinning forever.
- **Extension timeout UX**: Improved from generic "failed to load" to specific error message with retry button.

## [0.9.86] - 2026-04-15

### Added
- **Git Graph worktree management**: Toolbar popover with full CRUD — list worktrees with branch/hash/status badges, create (existing or new branch), remove, and prune stale entries. "Create Worktree Here..." in commit context menu.
- **Project auto-add for worktrees**: Opening a worktree not registered as a project prompts to add it automatically, then switches to it.
- **Extension project switching API**: `window.switchProject()` in vscode-compat allows extensions to trigger project switches via `project:switch` WS message.

### Fixed
- **Branch-already-exists dialog**: Creating a branch that exists now shows replace/cancel dialog instead of a generic error toast.

## [0.9.85] - 2026-04-14

### Added
- **New file editor tabs**: Create untitled editor tabs (Untitled-1, Untitled-2...) via Ctrl+N or Command Palette. Content persists in localStorage across sessions. Save As dialog on first Ctrl+S using file browser picker.
- **Right-click context menu on tabs**: Copy path, download, rename, delete files directly from tab context menu.

### Changed
- **Markdown rendering migrated to react-markdown**: Replaced `marked` with `react-markdown` for better extensibility and React integration.

### Fixed
- **Upgrade dismiss persisted to sessionStorage**: Dismissed upgrade banner no longer reappears during same session.
- **WebSocket project path decoded for Windows**: Paths with special characters now work on Windows.

## [0.9.84] - 2026-04-13

### Fixed
- **Device rename now syncs to cloud**: Implemented JWT token auto-refresh so cloud API calls succeed after token expiry. Previously `refreshAccessToken` was a stub returning null.
- **Cloud sync errors surfaced**: PUT /settings/device-name now returns `cloud_synced` and `cloud_error` fields instead of silently swallowing failures.
- **Heartbeat propagates device name**: Cloud server now persists device name from both WS and HTTP heartbeats, providing eventual consistency even if JWT-based rename fails.

## [0.9.83] - 2026-04-12

### Fixed
- **Sessions with large first messages now appear in history**: SDK's `listSessions` silently drops sessions whose first message exceeds its 64KB head buffer (e.g. pasted API docs). PPM now scans the JSONL directory as fallback to recover these sessions.
- **Cloud CLI config not loaded**: `ppm cloud` commands now call `configService.load()` before reading `cloud_url`, so saved config is properly picked up.
- **Supervisor device name sync**: Cloud heartbeat now syncs device name from PPM config to cloud device file when user changes it in settings.
- **Port-forwarding tunnel resilience**: Refactored tunnel spawning with probe failure tracking and auto-respawn for dead tunnels.
- **URL sync UUID validation**: Chat tab URLs now validate session ID format, preventing short/random tab-derived IDs from being treated as session IDs.
- **Test suite fully passing**: Added missing SDK mock exports (`getSessionInfo`, `forkSession`, `renameSession`) and updated `maxTurns` assertions to match current default (1000).

## [0.9.82] - 2026-04-11

### Added
- **Math formula rendering in markdown**: LaTeX math expressions now render in chat and markdown preview using KaTeX. Supports inline `$...$` and block `$$...$$` notation. Malformed LaTeX degrades gracefully to raw text.

## [0.9.81] - 2026-04-10

### Added
- **Persistent toast notification for pending approvals**: When an approval request or AI question arrives on a non-active session tab, a Sonner toast with "Go to session" action appears and persists until dismissed or resolved.

### Fixed
- **Approval timeout removed**: `waitForApproval` no longer auto-rejects after 5 minutes. Approvals wait indefinitely until user responds or session is cleaned up.
- **`deleteSession` approval cleanup bug**: Was using wrong key (`sessionId` on a `requestId`-keyed map) — now properly iterates and resolves all pending approvals for the deleted session.
- **Reconnect tool_result reliability**: Tool results are now embedded onto matching tool_use events in the buffer, so reconnecting clients don't lose tool output.
- **Cloud WS reconnect backoff**: Reconnect attempt counter only resets after auth succeeds, preventing tight reconnect loops when server closes immediately after connect.
- **Tunnel URL lazy sync**: `getTunnelUrl()` now falls back to reading `status.json` when supervisor sets the URL after server startup.

## [0.9.80] - 2026-04-10

### Fixed
- **"Session ID already in use" error**: Removed dual-ID system (ppmId/sdkId mapping via `session_map` table). PPM UUID is now used directly as SDK session ID, eliminating the `effectiveIsFirst` heuristic that caused resume vs new-session misclassification.
- **Non-deterministic message timing**: Replaced `setTimeout(500ms)` with `isConnected`-based pending message flush using `useRef` + `useEffect` for reliable first-message delivery after WS connect.
- **Legacy JSON migration crash**: `config.service.ts` called removed `setSessionMapping` — replaced with `setSessionMetadata`.
- **CLI provider session migration**: Restored `session_migrated` WS handler for CLI providers that discover session IDs from CLI output.
- **Fork session not tracked**: Fork route now calls `resumeSession` to register forked session with provider in-memory state.

### Changed
- DB migration v16: creates `session_metadata` table, migrates data from `session_map`, cleans up orphaned ppm_id entries in `session_titles`/`session_pins`.
- Removed `session_migrated` from `ChatEvent` type (SDK provider no longer needs it).
- Removed `migratedSessionId` state from frontend `use-chat` hook.
- Net deletion of ~86 lines of complexity.

## [0.9.79] - 2026-04-10

### Fixed
- **Silent hang on resume of never-completed sessions**: When a session's first attempt hung (no SDK `init` event received), subsequent messages tried to `resume` a non-existent JSONL file, causing the SDK subprocess to silently hang. Now detects missing SDK mapping and treats as a new session.

## [0.9.78] - 2026-04-10

### Added
- **SDK subprocess stderr logging**: Real-time stderr output from Claude CLI subprocess is now logged to server console for debugging hangs and crashes.
- **MCP servers diagnostic log**: Log which MCP servers are being passed to SDK query.
- **Query creation log**: Log when `query()` async iterator is created to confirm subprocess started.

## [0.9.77] - 2026-04-10

### Fixed
- **Streaming hang with no timeout**: `status_update` events (account routing) were treated as real SDK content, prematurely cancelling the 120s heartbeat timeout. If the SDK subprocess hung after account selection, the UI showed "streaming" forever with no error. Now `status_update` is correctly classified as metadata so the timeout still fires.

## [0.9.76] - 2026-04-09

### Fixed
- **Concurrent token refresh race**: Multiple sessions starting near-simultaneously all refreshed the same token. Removed redundant in-memory freshness check — `ensureFreshToken()` now re-reads from DB, so concurrent sessions see the already-refreshed token.

## [0.9.75] - 2026-04-09

### Fixed
- **Duplicate Run buttons in SQL editor**: CodeLens providers were registered globally but never disposed on tab close, causing "▷ Run" buttons to multiply with each .sql tab opened.

## [0.9.74] - 2026-04-09

### Changed
- **Status update display**: `status_update` events now show as thinking-style indicator (spinner + status text) instead of blockquotes in message body. Transient — not persisted in message history.

## [0.9.73] - 2026-04-09

### Added
- **Pre-flight token refresh loop**: Account selection now retries all available accounts when OAuth token refresh fails, instead of failing immediately.
- **`status_update` ChatEvent**: Frontend shows real-time status during account routing, token refresh, and account switching phases.
- **`onPreflightFail()` method**: Failed accounts enter 60s–5min exponential cooldown during pre-flight.
- **`excludeIds` param for `next()`**: Account selector can skip specific accounts (used by pre-flight loop).
- Unit tests for `next(excludeIds)`, `onPreflightFail()`, and `all_excluded` fail reason (+7 tests).

## [0.9.72] - 2026-04-09

### Added
- **Column search/jump**: Columns button + `/` shortcut opens filterable dropdown with arrow key navigation. Scrolls to column accounting for sticky pinned columns.
- **Row viewer**: Eye icon per row opens full row data as formatted JSON in a new editor tab.
- **Shortcut hints**: Footer shows keyboard shortcuts (`/` columns, `⌘A` select all, `⌘C` copy) on desktop.

### Changed
- **Cell viewer**: Opens in a new editor tab (with syntax highlight + beautify) instead of a popup dialog.
- **Column filters**: Now controlled from parent and synced bidirectionally with SQL editor. Editing ILIKE in SQL and pressing Ctrl+Enter reflects filters in table header.

### Fixed
- **Loading overlay**: Spinner now shows on table during query execution (both filter and manual queries).
- **Filter query mode**: Column filter queries and matching Ctrl+Enter queries stay in table grid mode instead of switching to read-only query result panel.
- **Hooks order**: Moved hooks above early return to fix React Rules of Hooks violation.
- **Column search perf**: All search state (query, index) lives inside the dropdown — no DataGrid re-renders on keystrokes.

## [0.9.71] - 2026-04-09

### Fixed
- **CLI db commands**: `ppm db` subcommands (list, add, remove, test, tables, schema, data, query) were implemented but not registered in CLI entry point — now accessible.

### Added
- Unit tests for CLI db command registration and option structure.
- Unit tests for `isReadOnlyQuery` utility (18 cases including CTE attack patterns).
- Unit tests for database routes: readonly enforcement, validation, edge cases (+30 tests).
- Unit tests for db.service connection CRUD: insert, resolve, update, delete, encryption round-trip (+17 tests).

## [0.9.70] - 2026-04-09

### Fixed
- **SDK subprocess crash on resume**: Resumed sessions with existing JSONL files would crash (exit code 1) because `--session-id` was used instead of `--resume`. Now always uses `--resume` for resumed sessions.
- **Session lookup**: Use targeted `getSessionInfo()` with correct project dir instead of listing all sessions.
- **SDK stderr capture**: Subprocess stderr is now logged on crash for diagnostics.
- **Thinking budget option**: Fixed `thinkingBudgetTokens` → `maxThinkingTokens` (correct SDK option name).

## [0.9.69] - 2026-04-09

### Fixed
- **Cloud WS replaced loop**: `isConnected()` now returns true during 500ms auth handshake, preventing Cloud monitor from killing valid connections. Fixed `disconnect()` not resetting `reconnecting` flag.
- **Token refresh buffer**: Increased OAuth token refresh buffer from 60s to 1 hour to prevent 401 errors mid-conversation.
- **SDK retry stale closures**: Extracted `closeCurrentStream()` helper that reads from session map instead of captured variables, preventing retry paths from closing already-replaced streams. Fixed phantom session entries from retry init events.

## [0.9.68] - 2026-04-08

### Fixed
- **ConnectionList hooks crash**: Moved `useMemo` out of `.map()` loop to fix React hook order violation (error #310).
- **CodeEditor hooks crash**: Moved `useState`/`useCallback` before early returns to fix React hook count mismatch (error #310).

## [0.9.67] - 2026-04-08

### Changed
- **Cell viewer**: Large/structured cell data now opens in a new editor tab (with syntax highlighting + beautify) instead of a popup dialog.

## [0.9.66] - 2026-04-08

### Added
- **Database viewer overhaul**: Full-featured DataGrid with inline editing, row selection (Cmd+A select all, Cmd+C copy as TSV), bulk delete, insert row, and export (CSV/JSON) for both table view and custom query results.
- **SQL autocomplete**: Context-aware completion for keywords, table names, column names (with alias/dot support), operators, and aggregate functions. Async column fetching with client-side cache.
- **Cell viewer dialog**: Large/structured data (JSON, XML) opens in a Monaco editor with syntax highlighting and beautify toggle. Responsive: large dialog on desktop, 75% bottom sheet on mobile.
- **Column filter (ILIKE)**: Per-column filter inputs with debounced auto-execution via WHERE ILIKE clauses.
- **Pin columns/rows**: Sticky horizontal pinning for columns, sticky vertical pinning for rows. DOM-measured offsets for accurate positioning.
- **Export button**: Export current page or full table as CSV/JSON, with selected-rows-only export.
- **SQL query editor**: Monaco-based with run button, Cmd+Enter execution, and `getStatementAtCursor` for multi-statement files.
- **.sql file run button**: Execute SQL files directly from the code editor against a connected database.

### Fixed
- **PostgreSQL SSL errors**: Parse `sslmode` from connection string; `no-verify`/`require` sets `rejectUnauthorized: false`.
- **PK detection**: Boolean coercion from postgres library (`"t"`/`"f"` strings) now handled correctly.
- **[object Object] in cells**: Objects/arrays now JSON-stringified instead of using `String()`.
- **Selection performance**: Replaced @tanstack/react-table with plain HTML + `memo(DataRow)` for lag-free row selection.
- **Mobile touch support**: Pin/filter/delete buttons visible without hover (`md:opacity-0 md:group-hover:opacity-100` pattern).
- **Sticky positioning gaps**: `border-collapse: separate` + ResizeObserver for accurate header/column/row measurements.
- **Autocomplete z-index**: `fixedOverflowWidgets: true` for Monaco suggest widget.

## [0.9.65] - 2026-04-08

### Changed
- **Removed `ppm cloud link`/`unlink` CLI commands**: Login auto-links, logout auto-unlinks — separate commands no longer needed. API routes remain for web UI.

## [0.9.63] - 2026-04-08

### Fixed
- **Cloud auto-link**: `ppm cloud login` now auto-links device (no separate `ppm cloud link` needed). `ppm cloud logout` auto-unlinks.
- **Supervisor cloud monitor**: Supervisor periodically checks cloud-device.json and auto-connects/disconnects/reconnects WS as needed. Fixes "stuck offline" after upgrade or file loss.
- **Stale tests**: Aligned usage-cache and chat-routes tests with current API response shapes.

## [0.9.62] - 2026-04-08

### Fixed
- **SDK subprocess crash auto-retry**: When the Claude Code subprocess crashes (exit code 1), PPM now automatically retries once with a fresh subprocess after a 1s delay, instead of immediately showing the error. Only surfaces the crash message if the retry also fails.

## [0.9.61] - 2026-04-08

### Fixed
- **Telegram message clarity**: Thinking blocks now wrapped in `<blockquote>` (indented with vertical bar), tool calls in `<pre>` blocks (monospace background). Much easier to distinguish from actual response text.

## [0.9.60] - 2026-04-08

### Fixed
- **Usage chart clarity**: Added data summary, descriptive labels for each section, hover tooltips with sample counts, hour-axis on heatmap, and color legend (low-high + no data).

## [0.9.59] - 2026-04-07

### Added
- **Usage pattern charts**: Account profile view (eye icon) now shows day-of-week bars, hour-of-day heatmap, and 7x24 grid to identify peak usage times. Toggle between 5-hour and weekly metrics.

## [0.9.58] - 2026-04-07

### Fixed
- **OAuth refresh token races**: Per-account mutex prevents concurrent refresh calls from racing (Anthropic rotates refresh tokens). Skips refresh if token already fresh.

### Added
- **History panel pagination**: "Load more" button loads older sessions. Pinned sessions are always visible regardless of page. Backend supports `limit`/`offset` query params.

## [0.9.57] - 2026-04-07

### Fixed
- **Telegram bot thinking display**: Consecutive thinking chunks are now merged into a single `💭` block instead of rendering as multiple broken lines.

## [0.9.56] - 2026-04-07

### Fixed
- **Usage panel shows all accounts**: Expired temporary accounts are no longer hidden from Usage & Accounts panel. Users can delete them manually.

## [0.9.55] - 2026-04-07

### Added
- **Database row deletion**: Delete rows from SQLite and PostgreSQL tables via data grid UI. Hover row to reveal trash icon, click to confirm/cancel inline. Works for both project-scoped SQLite viewer and unified database connections viewer.
- **Delete row API**: `DELETE /sqlite/row` (project-scoped) and `DELETE /api/db/connections/:id/row` (unified) endpoints with readonly enforcement.

## [0.9.53] - 2026-04-07

### Added
- **Supervisor Always Alive**: `ppm stop` now does a soft stop — kills server only, supervisor stays alive with Cloud WS + tunnel. Use `ppm stop --kill` or `ppm down` for full shutdown.
- **`ppm down` command**: Alias for `ppm stop --kill` (full shutdown).
- **`ppm stop --kill` flag**: Full shutdown that kills supervisor + server + tunnel.
- **Stopped page**: When server is stopped, tunnel URL serves a minimal HTML status page + 503 on `/api/health`.
- **Supervisor detection**: `ppm start` detects existing supervisor and resumes/upgrades instead of spawning a new one.
- **Cloud WS commands**: `start` (resume from stopped), `shutdown` (full kill), `stop` (now soft stop).
- **Exception handlers**: Supervisor catches `uncaughtException`/`unhandledRejection` — never crashes.
- **Lockfile**: Prevents concurrent `ppm start` races (`~/.ppm/.start-lock`).
- **Windows command file polling**: Supervisor polls command file every 1s on Windows (no SIGUSR2).

### Changed
- **BREAKING**: `ppm stop` default behavior changed from full shutdown to soft stop.
- **Autostart**: Generates `__supervise__` instead of `__serve__`. Existing users must run `ppm autostart disable && ppm autostart enable` to regenerate.
- **Supervisor modularized**: Split into `supervisor.ts` (orchestrator), `supervisor-state.ts` (state machine + IPC), `supervisor-stopped-page.ts` (stopped HTML server).

## [0.9.52] - 2026-04-07

### Added
- **Full `ppm bot` CLI**: All 13 Telegram commands now have CLI equivalents — `project switch/list/current`, `session new/list/resume/stop`, `memory save/list/forget`, `status`, `version`, `restart`, `help`. AI can invoke any command via Bash tool from natural language (e.g. "chuyển sang project ppm" → `ppm bot project switch ppm`).
- **Auto-detect chat ID**: `resolveChatId()` auto-detects single approved paired Telegram chat. Falls back to `--chat <id>` when multiple chats exist.
- **System prompt with natural language mapping**: AI receives full CLI reference + Vietnamese/English intent examples, executes commands directly instead of describing actions.

## [0.9.51] - 2026-04-07

### Added
- **`ppm bot memory` CLI command**: AI can now save cross-project memories via Bash tool — `ppm bot memory save/list/forget`. Stores to `_global` scope in SQLite, persists across all projects and sessions. GoClaw-inspired pattern (CLI tool, not MCP).
- **System prompt instructs AI**: AI automatically knows to use `ppm bot memory save` when user asks to remember preferences, change address style, or save facts.

### Changed
- **/memory, /remember, /forget**: Now always use `_global` project scope (cross-project).
- **ppmbot-memory tests updated**: Removed stale tests referencing deleted methods (`recall`, `save`, `parseExtractionResponse`, `extractiveMemoryFallback`).

## [0.9.50] - 2026-04-07

### Changed
- **/sessions redesigned**: Filters by current project, shows pinned sessions first with 📌 icon, displays session titles (not project names), supports pagination via `/sessions 2`. Matches PPM web UI behavior.

## [0.9.49] - 2026-04-07

### Fixed
- **/resume accepts session ID prefix**: `/resume fdc4ddaa` now works alongside `/resume 2` (index). Matches session by ID prefix from `/sessions` list.
- **/restart actually restarts**: Server now exits with code 42 (restart signal) instead of 0 (clean exit). Supervisor recognizes code 42 and respawns immediately without backoff.
- **Restart notification delivered**: Supervisor respawns after `/restart`, new server sends "PPM v0.9.49 restarted successfully." to all paired chats.
- **/project lists all projects**: `getProjectNames()` now merges config projects + unique project names from session history. Previously returned empty when no projects in config.

## [0.9.48] - 2026-04-06

### Changed
- **Memory → Identity layer**: Stripped custom memory extraction, decay, periodic AI extraction prompts. PPMBot now stores only identity/preferences + explicit `/remember` facts. Contextual memory delegated to provider's native system (Claude Code MEMORY.md). `ppmbot-memory.ts` 333→111 LOC.
- **Removed "don't write memory" directive**: AI provider manages its own contextual memory naturally.

## [0.9.47] - 2026-04-06

### Fixed
- **AI writes to Claude memory files**: Added core directive preventing AI from managing its own memory/identity files. Memory is handled by PPMBot externally.
- **Garbage identity saved**: Removed `hasCheckedIdentity` fallback that saved random messages as identity. Identity only collected through `/start` onboarding flow.
- **Identity onboarding context**: AI now gets a hint that the message is an identity intro, so it acknowledges warmly instead of treating it as a task.

## [0.9.46] - 2026-04-06

### Added
- **/version command**: Shows current PPM version in Telegram.

## [0.9.45] - 2026-04-06

### Fixed
- **Identity lost on server restart**: Identity save ran AFTER `streamToTelegram()` — if streaming timed out, the save was skipped. Moved identity persistence to before streaming so it writes to SQLite immediately.

### Added
- **Restart notification includes version**: `/restart` now sends "PPM v0.9.45 restarted successfully" instead of generic message.

## [0.9.42] - 2026-04-06

### Changed
- **Port Forwarding UI**: Replaced iframe-based browser preview with a Port Manager. Tunnels now open in a new browser tab instead of an iframe, fixing cross-origin rendering issues with Cloudflare tunnels. Tab renamed from "Browser" to "Ports".
- **Renamed browser → ports**: All code references (files, components, routes, TabType, tests) renamed from "browser" to "ports" for consistency.

### Fixed
- **Git worktree list**: Removed unsupported `-v` flag from `git worktree list --porcelain` command
- **Light mode colors**: Fixed invisible UI elements by using `primary` tokens instead of `accent` (which is subtle gray in light mode)

## [0.9.43] - 2026-04-06

### Fixed
- **Identity onboarding asks every /start**: FTS5 search with implicit AND missed keywords. Now checks memory category/content directly.
- **/sessions shows useless list**: Now displays session title (first message preview), session ID snippet, and formatted date/time.

### Changed
- **/project without args**: Lists all projects with ✓ marker on current, instead of just showing current project name.

### Added
- **/restart command**: Exits PPM process (for process manager to restart), notifies all paired chats on successful restart.
- **Memory & Identity section** in PPMBot settings: View and delete stored memories. API: GET/DELETE `/api/settings/clawbot/memories`.

## [0.9.40] - 2026-04-06

### Changed
- **Merged Telegram settings into PPMBot**: Bot token now configured in PPMBot settings (single place). Removed separate Telegram section from Notifications.
- **Notifications go to all paired devices**: Removed `chat_id` config — Telegram notifications now broadcast to all approved paired chats. No more manual chat ID entry.

### Added
- **Test Notification button** in PPMBot settings — sends test message to all approved paired devices.

## [0.9.39] - 2026-04-06

### Fixed
- **Stream hangs 3 minutes after AI finishes**: `done` event was received but the `for-await` loop didn't break — `break` inside `switch` only exits the switch, not the loop. Used labeled `break eventLoop` to properly terminate on `done`.
- **Identity never saved to memory**: Memory extraction only ran on session end. Now saves identity directly when user responds to onboarding prompt, and runs AI extraction every 5 messages.

## [0.9.36] - 2026-04-06

### Fixed
- **Stream timeout during tool execution**: Per-event timeout increased from 60s to 180s. Tool calls (bash, file writes, memory saves) frequently exceed 60s between events, causing premature stream termination.

## [0.9.35] - 2026-04-06

### Fixed
- **Stream hangs forever on stuck AI**: Replaced elapsed-time timeout with per-event `Promise.race` (60s per event). If `.next()` hangs, stream is terminated cleanly instead of blocking forever.
- **"Project not found" when no default configured**: Added `~/.ppm/bot/` fallback project so bot works immediately without project setup.

### Added
- **Identity onboarding**: `/start` now prompts new users for name, role, stack, and language preference when no identity memories exist.

## [0.9.34] - 2026-04-06

### Changed
- **Renamed ClawBot → PPMBot**: All user-facing text, files, classes renamed. DB tables/config key remain `clawbot` for backward compat.

### Fixed
- **Bot unresponsive after first message**: Polling loop blocked on AI stream hangs — now uses fire-and-forget handler calls. All messages + commands stay responsive.
- **Thinking shown but no answer**: Thinking events mixed raw HTML into markdown text, causing double-processing. Now tracks HTML and markdown segments separately.
- **No stream timeout**: Added 5-minute timeout to prevent indefinite AI stream hangs.

### Added
- **Telegram command menu**: Bot registers commands via `setMyCommands` on startup — users see autocomplete when typing `/`
- **Bot personality**: Default system prompt makes PPMBot concise and mobile-friendly. Welcoming `/start` greeting.

## [0.9.33] - 2026-04-06

### Fixed
- **CLI `config set telegram` fails**: `telegram` key missing from DEFAULT_CONFIG, so CLI rejects it as "not found". Added default empty telegram config.

## [0.9.32] - 2026-04-06

### Added
- **ClawBot Telegram integration**: Chat with AI providers directly from Telegram
  - Long-polling Telegram bot (no webhook/public URL needed)
  - Progressive message editing with 1s throttle for streaming responses
  - Pairing-based access control (6-char code, approve via web UI)
  - FTS5 memory system with AI extraction + regex fallback
  - Cross-project memory recall when mentioning project names
  - Message debouncing (configurable, default 2s) for rapid messages
  - Context window monitoring with auto-session rotation at >80%
  - 11 bot commands: /start, /project, /new, /sessions, /resume, /status, /stop, /memory, /forget, /remember, /help
  - Settings UI: enable/disable, paired devices, system prompt, display toggles
  - `[Claw]` prefix + bot icon in chat history for Telegram sessions
  - DB migration v13: clawbot_sessions, clawbot_memories (FTS5), clawbot_paired_chats

## [0.9.31] - 2026-04-05

### Fixed
- **Tunnel URL lost on self-replace upgrade**: Server child's `stopTunnel()` killed the cloudflared process and wrote `tunnelPid: null` to status.json during SIGTERM — new supervisor couldn't adopt the tunnel. Now sets `.restarting` flag before killing server child so tunnel survives upgrade.
- **Tunnel PID not set before status persist**: `setExternalUrl` called `persistToStatusFile` before `setExternalPid` was called, writing `tunnelPid: null` to status.json on server boot. Reordered to set PID first.

## [0.9.26] - 2026-04-05

### Fixed
- **Local endpoint showing tunnel URL**: Proxy settings now returns `localEndpoint` from server's actual port instead of relying on `window.location.origin` which shows the tunnel URL when accessed remotely

### Changed
- **Proxy test UI → dialog**: Moved test panel from inline section to a dialog (bottom-sheet on mobile) with endpoint format selector (Anthropic / OpenAI) for verifying response format

## [0.9.24] - 2026-04-05

### Fixed
- **Self-referencing proxy loop**: SDK subprocess inherited `ANTHROPIC_BASE_URL=/proxy` from shell env, calling PPM's own proxy instead of real Anthropic API → infinite 401 loop. Now detects and strips self-referencing proxy URL and paired API key from SDK env.

## [0.9.22] - 2026-04-05

### Fixed
- **SDK internal 401 retry loop stuck**: SDK retries 401 errors 10x with exponential backoff using same expired token (~2 min stuck at "Thinking..."). Now intercepts `api_retry` on first 401, refreshes token immediately, and if refresh fails (e.g. temporary account with no refresh token), switches to a different account instantly.
- **Auto-refresh spam for temporary accounts**: Accounts without refresh token triggered auto-refresh every 5 min, failing every time. Now skips them in the auto-refresh loop.

## [0.9.20] - 2026-04-05

### Fixed
- **SDK retry hangs after token refresh**: All 4 retry paths (auth refresh + rate limit, in streaming and result events) used a stale `sdkId` resolved once at function start — for first messages this equals the PPM UUID which the SDK doesn't recognize, causing `query()` to hang forever. Now re-resolves session mapping before each retry and pushes `firstMsg` when no SDK session exists yet.
- **Workspace layout lost on new device**: Fetch server workspace BEFORE `setActiveProject` so `switchProject` picks up server data instead of creating an empty layout with a new timestamp

## [0.9.19] - 2026-04-05

### Fixed
- **Proxy for OAuth accounts**: OAuth tokens (Claude Max/Pro) now route through SDK `query()` bridge instead of direct API forwarding, which was returning rate_limit_error. API key accounts still use direct forwarding.

### Added
- **SDK proxy bridge** (`proxy-sdk-bridge.ts`): Translates Anthropic Messages API requests into Agent SDK calls for OAuth accounts, supporting both streaming SSE and non-streaming JSON responses with account rotation

## [0.9.16] - 2026-04-04

### Fixed
- **Debug button on iPad**: Use `ClipboardItem` pattern so Safari preserves user gesture through async fetch — previously clipboard write failed silently
- **Teammate-message tags**: Strip `<teammate-message>` XML tags from session history at backend level and chat text display
- **TeamCreate output**: Handle content-block array format in TeamCreate output extraction

## [0.9.10] - 2026-04-04

### Added
- **Agent Team UI**: Real-time team monitoring with REST API, WebSocket events, and popover UI
  - REST endpoints: `GET /api/teams`, `GET /api/teams/:name`, `DELETE /api/teams/:name`
  - WS: detect TeamCreate, fs.watch inbox changes, broadcast team_detected/team_inbox/team_updated
  - Chat input: team button with unread pulse badge, activity popover with member status + message timeline
  - AI Settings: team list with delete confirmation below Agent Teams toggle
- **Git worktree management**: Create/delete worktrees with dialog UI, worktree panel, service + routes
- **Touch tab drag**: Touch device support for tab dragging, split-drop overlay improvements

### Security
- Team name allowlist regex prevents path traversal on all team endpoints
- CSS color sanitization in team message rendering

## [0.9.8] - 2026-04-04

### Fixed
- **Fullscreen usage overlay**: Account cards now fill entire viewport as a no-scroll grid overlay instead of just expanding height with scroll
- **Provider + Settings button merged**: Combined provider badge and AI Settings into a single clickable button in chat toolbar

### Removed
- Unused `contextWindowPct` display from chat toolbar (was already non-functional)

## [0.9.7] - 2026-04-04

### Added
- **File download**: Browser-native single file download from file tree context menu and editor toolbar
- **Folder zip download**: Stream folder contents as zip archive (excludes `.git`, `node_modules`)
- **Download tokens**: Short-lived one-time tokens (30s TTL) for secure browser-initiated downloads
- **Shared error-status helper**: Extracted `errorStatus()` to `src/server/helpers/error-status.ts`

### Security
- Download tokens scoped to `/files/raw` and `/files/download/zip` paths only
- Path traversal protection with trailing slash check

## [0.9.6] - 2026-04-04

### Fixed
- **Touch device hover buttons**: Buttons hidden behind `hover:` are now always visible on iPad/touch devices using `@media (hover: hover)` detection instead of breakpoint-based hiding — fixes invisible action buttons across git panel, chat history, project list, session picker, tabs, and more (14 files)

## [0.9.5] - 2026-04-04

### Fixed
- **Streaming session survives FE disconnect**: Active chat sessions no longer killed when iPad sleeps or browser disconnects — agent runs to completion, cleanup only applies to idle sessions
- **Instant WS reconnect on wake**: Added `visibilitychange` listener so WebSocket reconnects immediately when page becomes visible instead of waiting for exponential backoff

### Changed
- **Mobile nav layout**: Updated mobile navigation layout

## [0.9.4] - 2026-04-03

### Fixed
- **ext-database adaptive theme**: Replace hardcoded Catppuccin Mocha dark theme with light/dark adaptive CSS using `prefers-color-scheme` and shadcn zinc palette (table viewer + query panel)

### Added
- **ext-database connection management**: Edit, delete, test, export, import connections via commands (matching builtin viewer features)
- **ext-database tree view groups**: Connections grouped by group name, readonly 🔒 indicator, row counts on table nodes
- **ext-database color & readonly**: Add connection flow now collects group name, color, and readonly toggle

## [0.9.3] - 2026-04-03

### Fixed
- **Session context loss on token refresh**: Auth refresh and rate-limit account switching now resume the existing SDK session instead of starting a fresh one, preserving all conversation context (tool calls, thinking, etc.)

## [0.9.2] - 2026-04-03

### Fixed
- **Mobile input layout**: Reorder buttons (attach → textarea → mic → send) for better thumb reach
- **Desktop input layout**: Move mic button next to send button for consistent grouping
- **Usage panel fullscreen**: Add fullscreen toggle for Usage & Accounts panel when multiple accounts present, with grid layout in fullscreen mode

## [0.9.1] - 2026-04-03

**"Open Platform"** — Multi-provider AI, MCP management, and extension architecture.

### Added — Extension System
- **Extension architecture (Phase 1-6)**: VSCode-compatible npm extensions with Bun Worker isolation, RPC protocol, state persistence, and contribution registry
- **@ppm/vscode-compat API shim**: commands, window (showInformationMessage, showErrorMessage, showQuickPick, showInputBox, createTreeView, createWebviewPanel, createStatusBarItem), workspace, EventEmitter
- **Extension UI components**: StatusBar items, TreeView with color dots/badges/actions, WebviewPanel (iframe sandbox), QuickPick/InputBox dialogs
- **WS bridge**: Real-time extension↔browser communication for tree updates, command execution, webview messaging
- **ext-database extension**: Database viewer with connection tree (color dots, PG/DB badges, action buttons), table viewer webview (data grid, inline editing, pagination, SQL panel), add connection flow
- **Extension Manager UI**: Install/uninstall/enable/disable extensions in Settings, dev-link for local development
- **CLI support**: `ppm ext install`, `ppm ext dev-link`, extension lifecycle management

### Added — Multi-Provider AI
- **Provider interface**: `AIProvider` with optional capabilities (`abortQuery?`, `getMessages?`, `listSessionsByDir?`)
- **CliProvider base class**: Abstract base for CLI-spawning providers (Cursor, Codex, Gemini)
- **Cursor CLI integration**: `CursorCliProvider` with NDJSON streaming, event mapping, history reader, workspace trust auto-retry
- **Provider selector UI**: Choose provider when creating chat sessions

### Added — MCP Management
- **MCP server CRUD**: REST API, SQLite storage, Settings UI, add/edit/delete servers
- **Auto-import**: Reads `~/.claude.json` on first access, skips existing/invalid entries
- **SDK integration**: Servers passed as `mcpServers`, tools auto-allowed via `mcp__*` wildcard

### Added — Other
- **Rate-limit auto-retry**: SDK retries on rate_limit/server_error with exponential backoff (15s, 30s, 60s) up to 3 attempts
- **Account rate-limit switching**: Auto-switch to next account on rate limit, skip 5hr-exhausted accounts
- **Increased max turns**: Default maxTurns bumped from 100 to 1000

### Fixed
- **Streaming auth loop**: Auth errors break streaming loop, cooldown account, tear down session
- **Streaming session resource leak**: `finally` block properly closes SDK subprocess and generator
- **Session mapping on resume**: Preserve existing sdk_id mapping to prevent orphaning JSONL history
- **Extension broadcast**: Contributions update broadcast on activate/deactivate
- **Extension webview**: Open tab when extension creates a webview panel
- **Extension auto-activate**: Auto-activate after dev-link install

## [0.8.94] - 2026-04-02

### Fixed
- **Session JSONL "not found" after disconnect/restart**: Debug endpoint relied on in-memory `projectPath` which was lost when session cleanup timer expired or server restarted. Now persists `project_path` in `session_map` DB table (migration 11) and falls back to DB lookup when in-memory state is gone.
- **Session mapping missing project info**: `setSessionMapping` now saves `projectName` and `projectPath` at both session creation and SDK init, ensuring resumed sessions can locate their JSONL files.

## [0.8.93] - 2026-04-02

### Removed
- **Cloud upgrade command**: Removed remote upgrade trigger from cloud — upgrade is now local-only (CLI `ppm upgrade` or UI banner)

## [0.8.92] - 2026-04-02

### Fixed
- **Fork UX**: Forked session now shows conversation history up to the fork point, puts the forked user message in input for editing instead of auto-sending
- **Fork at first message**: Forking the first user message creates a fresh empty session instead of erroring

## [0.8.91] - 2026-04-02

### Added
- **Session delete cleanup**: Deleting a session now removes JSONL files, DB mappings, titles, and pins; kills orphaned CLI processes
- **Mid-message fork**: Fork a session at a specific message via `forkAtMessage()` SDK capability with dynamic import
- **Compact handling**: Detect SDK compact events (`status`/`compact_boundary`) and forward "compacting..." status to frontend
- **Change password UI**: Settings panel for changing password with current/new password fields

### Fixed
- **Orphaned session on fork failure**: Restructured fork route to create PPM session only after SDK fork succeeds
- **Compact status stale badge**: Reset `compactStatus` on session change to prevent stale "compacting..." indicator
- **Cloud heartbeat device name**: Include device name in heartbeat payloads for cloud sync
- **Upgrade banner compact**: Reduced padding and fixed mobile overlap with device name badge

## [0.8.90] - 2026-04-02

### Fixed
- **Upgrade banner height**: Reduced padding and button sizes for a more compact banner
- **Mobile banner overlap**: Device name badge now shifts down when upgrade banner is visible, preventing overlap on mobile

## [0.8.89] - 2026-04-02

### Added
- **Account delete button**: Trash icon on each account card in Usage & Accounts panel with overlay confirmation popup
- **Expired account UX**: Expired temporary accounts (no refresh token) are dimmed, toggle/export hidden — only delete available

### Fixed
- **Account panel showing all accounts**: Usage & Accounts panel now always displays all accounts including expired temporary ones (previously filtered out)
- **MCP config table missing**: `McpConfigService.list()` gracefully returns empty object when `mcp_servers` table doesn't exist yet
- **Account error logging**: Consistent error message formatting in auto-refresh and pre-flight refresh logs

## [0.8.88] - 2026-04-01

### Added
- **Multi-provider architecture**: Generic AI provider system — `AIProvider` interface, `CliProvider` base class, `ProviderRegistry`, Cursor CLI integration with NDJSON streaming
- **MCP server management**: Configure Model Context Protocol servers via Settings UI — SQLite storage, REST API (CRUD + import), SDK integration with `mcp__*` wildcard
- **SDK streaming input**: Persistent `AsyncGenerator`-based chat with message channel pattern replacing one-shot queries

### Fixed
- **SDK process leak**: Prevent orphaned SDK processes on WebSocket disconnect and cancel
- **Cursor history**: Filter out `<user_info>` system context messages from imported sessions

## [0.8.87] - 2026-04-01

### Fixed
- **Session message loss on auth retry**: OAuth token expiry mid-query (e.g. during long bash commands) caused retry to create a new SDK session, overwriting the session mapping and losing all prior messages. Retry now resumes existing session instead.
- **Session CWD fallback to homedir**: `resumeSession()` didn't restore `projectPath` from SDK metadata, causing queries to use `$HOME` as CWD and JSONL to be stored under wrong project. Now extracts `cwd` from SDK session data.

## [0.8.85] - 2026-04-01

### Added
- **Connection lost overlay**: Full-screen overlay when API unreachable for >15s — tunnel mode links to PPM Cloud for new URL, localhost mode shows restart hint

### Fixed
- **Double-Shift command palette**: Only triggers when Shift pressed alone — no longer fires during Shift+key combos (uppercase typing, shortcuts)

## [0.8.84] - 2026-04-01

### Fixed
- **Account import overwrite**: Import now updates tokens for existing accounts even when they already have a (possibly expired/corrupt) refresh token — previously skipped, causing "0 imported"
- **Tunnel probe adopted PID**: Supervisor now monitors adopted tunnel processes and respawns if they die

### Added
- **Account rotation settings**: Settings gear icon in Usage & Accounts panel for rotation/retry config

## [0.8.83] - 2026-04-01

### Fixed
- **Account label desync**: Status bar now shows the actual streaming account label (real-time) instead of stale `lastPickedId` from usage polling — matches "via X" shown in chat messages when using multi-account round-robin

## [0.8.82] - 2026-04-01

### Added
- **Thinking block auto-scroll**: Thinking content now auto-scrolls to bottom during streaming using `StickToBottom`
- **Expandable recent sessions**: "Show more" / "Show less" button on chat welcome and empty panel — fetches up to 20 sessions, shows 5 initially

## [0.8.81] - 2026-04-01

### Fixed
- **Usage polling**: Re-wire `startUsagePolling()` into server startup — accidentally removed during supervisor refactor, causing prod to never auto-fetch usage limits (only manual refresh worked)

## [0.8.80] - 2026-04-01

### Added
- **Cloud command ack**: Device sends `command_ack` immediately when receiving a cloud command, before processing — allows cloud to confirm receipt and update UI

## [0.8.79] - 2026-04-01

### Added
- **Chat welcome screen**: New chat tabs now show pinned and recent sessions (same as empty panel) instead of a bare placeholder — quick access to continue previous conversations

## [0.8.78] - 2026-04-01

### Fixed
- **Cloud version reporting**: Supervisor heartbeat now reads version from running server child (via `status.json`) instead of its own captured constant — after `ppm restart` or `bunx @hienlh/ppm@latest restart`, cloud dashboard correctly reflects the updated version

## [0.8.77] - 2026-04-01

### Added
- **Deterministic tab IDs**: Tabs now use `{type}:{identifier}` format (e.g., `editor:src/index.ts`) instead of random UUIDs — enables deduplication, shareable URLs, and cross-device persistence
- **Type-based URLs**: URLs reflect tab content — `/project/my-app/editor/src/index.ts`, `/project/my-app/chat/claude-agent-sdk/session-abc`
- **Backend workspace sync**: New `workspace_state` table (DB v10) with GET/PUT `/api/project/:name/workspace` endpoints — tab layout persists server-side with per-project debounce and latest-wins merge
- **Deep linking**: Opening a URL auto-restores workspace from server and focuses the target tab
- **Split-duplicate support**: Same file can open in multiple panels using `@panel-id` suffix on non-singleton tab types

### Changed
- **URL format**: From `/project/{name}/tab/{randomId}` to `/project/{name}/{type}/{path}` — old random-ID URLs gracefully ignored
- **Tab migration**: `migrateTabIds()` automatically converts old random tab IDs to deterministic format on project load
- **Singleton dedup**: Only `git-graph` and `settings` tabs are globally deduplicated; editor/chat/terminal tabs allow split duplicates

## [0.8.76] - 2026-04-01

### Fixed
- **SDK error messages**: 500/5xx server errors and 429 rate-limits now show correct user-facing messages instead of confusing "unknown API error" with debug instructions
- **Session title on resume**: Prioritize DB-stored title when resuming a chat session

## [0.8.75] - 2026-04-01

### Changed
- **Tunnel always enabled**: `ppm start` now always starts Cloudflare tunnel — `--share` flag deprecated (still accepted, no-op)

## [0.8.74] - 2026-04-01

### Fixed
- **Cloud WS reconnect loop**: Stale WebSocket closure handlers from replaced connections no longer reset module state
- **Cloud WS auth race**: Delay heartbeat/queue flush 500ms after auth to let server complete async DB auth — prevents 4002 rejection

## [0.9.0-beta.10] - 2026-03-31

### Merged from main (0.8.69 → 0.8.72)
- **Supervisor state machine**: States `running → paused → upgrading` with promise-based wait/resume
- **Cloud WebSocket client**: Persistent WS connection replacing HTTP heartbeat — auto-reconnect with backoff
- **Remote commands via Cloud**: Supervisor handles restart/stop/upgrade/resume/status via Cloud WS
- **Pin/Save sessions**: Pin important chat sessions to top of history — persisted in DB across devices
- **Editor breadcrumb scrolling**: Enable scrolling in breadcrumb dropdown menus

## [0.9.0-beta.9] - 2026-03-31

### Merged from main (0.8.68)
- **Hot-reload timer leak**: Background polling timers (usage fetch, account refresh, cloud heartbeat) leaked on Bun `--hot` reload — module-level vars reset but old timers kept running. Moved timer refs to `globalThis` to survive reloads.

## [0.9.0-beta.8] - 2026-03-30

## [0.8.72] - 2026-03-31

### Added
- **Supervisor state machine**: States `running → paused → upgrading` with promise-based wait/resume. Supervisor pauses after 10 consecutive crashes, resumes via `ppm restart --force` or SIGUSR2
- **Cloud WebSocket client**: Persistent WS connection from supervisor to PPM Cloud replacing HTTP heartbeat — auto-reconnect with exponential backoff + jitter, 60s heartbeat, 50-message offline queue
- **Remote commands via Cloud**: Supervisor handles restart/stop/upgrade/resume/status commands received from Cloud WS
- **`ppm restart --force`**: Resume a paused supervisor (crashed too many times)
- **Status CLI state display**: `ppm status` shows paused/upgrading state with reason, timestamp, and last crash error

### Changed
- **Foreground mode removed**: `ppm start` no longer accepts `-f`/`--foreground` — always runs as supervised daemon
- **Heartbeat via WS**: Cloud heartbeat migrated from HTTP polling (5min) to WebSocket (60s), includes `appVersion`, `serverPid`, `uptime`

### Fixed
- **Upgrade failure recovery**: `selfReplace` failure now correctly resets state from "upgrading" back to "running" and notifies Cloud

## [0.8.71] - 2026-03-31

### Added
- **Pin/Save sessions**: Pin important chat sessions to always appear at the top of history, empty state, and session picker — persisted in DB across devices
- Mobile-friendly: pin/rename/delete buttons always visible on mobile, hover-reveal on desktop

### Fixed
- Fixed duplicate import in chat routes
- Fixed session action buttons misaligned when date column has variable width

## [0.8.70] - 2026-03-31

### Added
- **Recent chats on empty state**: When no tabs are open, show up to 5 recent chat sessions for quick access — click to reopen directly

## [0.8.69] - 2026-03-31

### Fixed
- **Auth 401 auto-retry**: Detect 401 errors returned as assistant text content (SDK doesn't always set error field) — refresh OAuth token and retry with fresh session automatically instead of showing raw error to user
- **Result-level 401 retry**: 401 in SDK result events now triggers token refresh + retry (previously only refreshed without retrying)

### Added
- **Account retry notification**: FE shows inline status when auth retry happens (e.g. "↻ Token refreshed — retrying with **Alex**...")
- **Session debug button**: Bug icon in chat toolbar copies session IDs + JSONL path to clipboard for quick debugging

## [0.8.68] - 2026-03-31

### Fixed
- **SDK process leak**: Prevent claude-agent-sdk subprocess leak on WS disconnect and cancel — cleanup timer now starts regardless of streaming state, orphaned sessions cleaned up in 30s, abortQuery fully teardowns subprocess

### Merged from main (0.8.65–0.8.67)
- **CSV cell word wrap**: Wrap toggle applies to CSV table cells
- **CSV inline editing**: Cell editor upgraded to auto-resizing textarea with multi-line support
- **Auto-upgrade port conflict**: Supervisor self-replace prevents crash-restart loop
- **Editor breadcrumb bar**: VSCode-style path breadcrumb with nested dropdown navigation
- **Editor toolbar**: Contextual actions — Markdown Edit/Preview, CSV Table/Raw, Word Wrap
- **CSV table preview**: `@tanstack/react-table` viewer with virtual scrolling and inline editing
- **Chat session titles**: Persist in PPM DB to prevent SDK from overwriting user-set titles
- **Chat abort error**: Suppress abort error toast on user cancel

## [0.9.0-beta.7] - 2026-03-27

### Merged from main
- **Usage polling dedup**: Concurrent `pollOnce` calls share single in-flight fetch
- **429 cooldown floor**: Min 60s cooldown on 429 responses
- **Browser preview tests**: Unit tests (12) + integration test (6) for tunnel routes

## [0.9.0-beta.6] - 2026-03-27

### Merged from main
- **Browser preview tab**: Localhost preview via per-port Cloudflare Quick Tunnels. Enter port → tunnel starts → iframe loads tunnel URL. Ghost cleanup every 30s. All tunnels killed on shutdown.
- **Voice input**: Mic button in chat, `Cmd+Shift+V` shortcut, command palette entry
- **Voice input stops on send**: Auto-stops recognition when message sent

## [0.9.0-beta.5] - 2026-03-27

### Merged
- Consolidated `feat/streaming-input-migration` into `beta`

## [0.9.0-beta.3] - 2026-03-26

### Added
- **Streaming input migration**: Chat system migrated from per-message `query()` to SDK-recommended persistent `AsyncGenerator` streaming input — follow-up messages `yield` into a single long-lived query instead of spawning new subprocesses
- **Message priority**: Follow-up messages support `now` (interrupt), `next` (queue, default), `later` priority via SDK `streamInput` — PriorityToggle UI visible during streaming
- **Image attachment support**: Messages can include base64 images (png/jpeg/gif/webp, max 5 images, max 5MB each) passed through to SDK `MessageParam` content blocks
- **Persistent event consumer**: `startSessionConsumer()` runs for session lifetime, processing events across multiple turns — replaces per-message `runStreamLoop()`

### Changed
- **Cancel = interrupt**: Cancel button now calls `query.interrupt()` (session stays alive) instead of `query.close()` (killed subprocess)
- **No more abort-and-replace**: Follow-up messages push into existing generator via `pushMessage()` instead of aborting current stream and starting new query
- **Crash auto-recovery**: Streaming session cleanup on crash, next message auto-recovers by creating new session

### Fixed
- **First-message images dropped**: Images on initial message now passed through `startSessionConsumer` to SDK
- **Double done event**: `yieldedDone` flag prevents duplicate done broadcast on session end
- **Retry channel leak**: Old message channel properly closed (`controller.done()`) before retry
- **abortQuery fallback cleanup**: Streaming session cleaned up when `interrupt()` unavailable

## [0.9.0-beta.2] - 2026-03-26

### Fixed
- **Chat input drops uploading files on send**: Pressing send while files are still uploading now queues the message and auto-sends once all uploads complete, instead of silently dropping in-progress attachments. Send button shows spinner when queued; clicking again cancels.
- **Ping interval leak**: `evictClient()` clears ping interval when broadcast error removes client
- **Black screen after closing all tabs**: Panel auto-close used `Object.keys(panels)` which counted keep-alive panels from other projects — last panel got removed, leaving empty grid. Now uses `grid.flat().length` to count only current-project panels. Added defensive recovery in PanelLayout for empty grid.

## [0.8.59] - 2026-03-26

### Fixed
- **Usage polling chain breaking permanently**: `startUsagePolling` recursive setTimeout chain now uses `Promise.race` with 60s timeout guard and `try/finally` — if `pollOnce` hangs or rejects, `scheduleNext` still runs
- **OAuth token refresh hanging forever**: `refreshAccessToken` fetch now has 15s `AbortSignal.timeout` — prevents blocking usage polling and auto-refresh when Anthropic OAuth is slow/unresponsive

### Changed
- **Account selector sustainability scoring**: Raise cap from 1.0 to 2.0 (scaled /2) so accounts with imminent weekly reset score higher than accounts with more remaining capacity but far-off resets

## [0.8.58] - 2026-03-26

### Fixed
- **Stale upgrade banner**: Banner showed old version (e.g. v0.8.56) even after upgrading past it. Route now compares availableVersion > currentVersion before returning. Supervisor clears stale availableVersion on startup.

## [0.8.57] - 2026-03-26

### Fixed
- **Self-replace port conflict**: Old supervisor's server held port while new supervisor tried to bind it, causing "port in use" crash. Now kills server/tunnel children and waits 500ms before spawning new supervisor.

## [0.8.56] - 2026-03-26

### Added
- **Account card footer**: Token expiry countdown and status label (long-lived/temp/expired/key) with color coding; hover for explanation

## [0.8.55] - 2026-03-26

### Added
- **Account management in Usage panel**: Add/Export/Import accounts directly from the Usage & Accounts panel — no more navigating to Settings
- **Account dialogs**: Extracted reusable Add, Export, Import dialog components
- **Horizontal account cards**: Account cards scroll horizontally with snap points when multiple accounts exist
- **Per-account export**: Export button on each OAuth account card opens export dialog with that account pre-selected
- **Default export password**: Export/import uses default password `ppm-hienlh` when password field left empty
- **Operation feedback**: Success message banner with 4s auto-dismiss after add/export/import operations
- **Image overlay**: Zoom preview overlay component for images (mermaid diagrams etc.)

### Fixed
- **SDK user message rendering**: System text in SDK-generated user messages (tool_result/task-notification XML) no longer renders as user chat bubbles
- **Hot-reload port check**: `bun --hot` reload no longer exits with "port in use" — detects hot-reload mode via globalThis flag
- **File listing order**: Command palette file listing uses BFS instead of DFS so root-level files appear before the limit

### Changed
- **Settings**: Removed Accounts category from settings (moved to Usage panel)

## [0.8.54] - 2026-03-25

### Added
- **Auto-upgrade feature**: Supervisor checks npm registry every 15min for new versions
- **Upgrade UI banner**: Dismissible banner with one-click upgrade button, dark mode support, 44x44px touch targets
- **Upgrade API**: `GET /api/upgrade` (status) + `POST /api/upgrade/apply` (install + supervisor self-replace)
- **`ppm upgrade` CLI**: `--check` flag for version check, auto-detects bun/npm install method
- **Supervisor self-replace**: After upgrade, spawns new supervisor → waits for PID in status.json → old exits gracefully
- **Integration tests**: 9 tests for upgrade service (compareSemver, checkForUpdate, API routes)
- **`PPM_HOME` env var**: Override `~/.ppm` directory for test isolation

### Fixed
- **Tests killing production PPM**: Test cleanup read shared `~/.ppm/status.json` and killed all PIDs including running prod. Now uses isolated temp dirs
- **SDK provider tests**: Fixed empty response assertion, missing `/tmp/my-project` dir, success subtype with 0 turns
- **Account service tests**: `importEncrypted()` made async but tests didn't await — added async/await + updated return type
- **Push routes test**: VAPID key empty due to DB reset by other tests — added `beforeEach` to reinit

### Changed
- **Test isolation**: `supervisor-resilience` and `daemon-tunnel-reuse` tests use `PPM_HOME` temp dirs instead of shared `~/.ppm`

## [0.8.53] - 2026-03-25

### Added
- **Process supervisor**: Long-lived parent process manages server + tunnel children with auto-restart on crash (exponential backoff 1s→60s, resets after 5min stable)
- **Tunnel resilience**: Auto-respawn cloudflared on death, extract new URL, sync to cloud immediately
- **Server health watchdog**: GET /api/health every 30s, kills hung server after 3 consecutive failures
- **Tunnel URL probe**: GET tunnelUrl/api/health every 2min, regenerates tunnel after 2 failures
- **SIGUSR2 graceful restart**: `ppm restart` signals supervisor to restart server only (tunnel stays alive, no backoff)
- **Count-based exception exit**: 3+ uncaught exceptions in 1 minute triggers exit for clean supervisor restart
- **Integration tests**: 8 tests covering supervisor spawn, crash recovery, SIGUSR2 restart, backoff behavior

### Changed
- **Daemon mode**: `ppm start` now spawns supervisor process instead of server directly
- **macOS autostart**: KeepAlive changed from conditional (SuccessfulExit=false) to unconditional
- **Linux autostart**: Restart policy changed from `on-failure` to `always`
- **`ppm stop`**: Kills supervisor PID first (cascades to children), 2s grace period
- **`ppm status`**: Shows supervisor PID and alive status
- **`ppm restart`**: Uses SIGUSR2 to supervisor for server-only restart

## [0.8.52] - 2026-03-25

### Fixed
- **Command palette IME conflict**: Double-Shift no longer falsely triggers command palette while typing with IME (Vietnamese Telex/VNI, Chinese, Japanese, Korean input methods). Tracks `compositionstart`/`compositionend` events and checks `e.isComposing`

## [0.8.51] - 2026-03-25

### Added
- **API Key / Token field**: New input in AI Settings to set a direct API key — overrides account rotation and env vars. Masked in responses (shows `••••` + last 4 chars)
- **Anthropic API proxy**: Forward Anthropic Messages API requests through PPM with account token rotation. Endpoints: `POST /proxy/v1/messages`, `POST /proxy/v1/messages/count_tokens`
- **Proxy settings UI**: Enable/disable proxy, manage auth key, view tunnel URL and request count
- **Proxy settings API**: `GET/PUT /api/settings/proxy` for proxy configuration
- **Auth priority**: Settings `api_key` > account token > shell env `ANTHROPIC_API_KEY` > block project .env
- **Proxy tests**: 18 integration tests for proxy API, 4 unit tests for buildQueryEnv priority, 3 unit tests for api_key masking

### Changed
- **Message list**: Removed unused pinned message feature

## [0.8.50] - 2026-03-25

### Fixed
- **Export token invalidation**: Export no longer auto-refreshes tokens by default — previously, every export called `refreshBeforeExport` which invalidated all previously shared tokens. Now opt-in via "Refresh tokens before export" toggle

### Added
- **Export refresh toggle**: New checkbox in export dialog — "Refresh tokens before export" (default off). Info box explains trade-offs: safe share (green) vs refresh-first (amber) vs full transfer (red)
- **Token test dialog** (dev-only): Test access token validity per account, simulate multi-round export with pre/post/exported token comparison. Hidden in production builds via `import.meta.env.DEV`
- **Test API endpoints** (dev): `POST /api/accounts/test-export`, `POST /api/accounts/test-raw-token`, `POST /api/accounts/:id/test-token`

## [0.8.49] - 2026-03-25

### Fixed
- **Auth error backoff**: `onAuthError` now uses 5-minute base cooldown (exponential up to 30min) instead of 1s rate-limit backoff — prevents rapid retry loops on dead/rejected accounts
- **No permanent disable**: Auth errors never permanently disable accounts — cooldown allows recovery from transient issues (subscription lapse, org changes, API hiccups)

## [0.8.48] - 2026-03-25

### Fixed
- **Account auth errors**: Use cooldown instead of permanent disable on `authentication_failed` / 401 — auth issues can be transient (subscription lapse, org changes, API hiccups)
- **SDK refresh safety**: Pass `disableOnFail=false` in SDK error handlers — prevents `refreshAccessToken` from disabling accounts as side effect during auto-retry

## [0.8.47] - 2026-03-25

### Fixed
- **Usage polling**: Use `ensureFreshToken()` in background usage poll — prevents 401 from expired tokens causing auto-fetch to always fail
- **Temp accounts**: Don't auto-disable temporary accounts (no refresh token) when token expires — they now expire naturally and get cleaned up after 7 days
- **Account export**: `refreshBeforeExport` no longer disables accounts as a side effect on refresh failure

## [0.8.46] - 2026-03-25

### Fixed
- **Account delete**: Replace `window.confirm()` with shadcn Dialog for delete confirmation — native confirm was silently blocked in WebView/embedded contexts

## [0.8.45] - 2026-03-25

### Fixed
- **Account export**: Keep refresh token on source machine when exporting with full transfer — auto-cleared only when token becomes invalid

## [0.8.44] - 2026-03-25

### Improved
- **Sticky user messages**: Rewrite as JS scroll-based pinned header with push-out transition (react-listview-sticky-header style) — CSS sticky didn't work with StickToBottom
- **Pinned bubble style**: Pinned header matches user bubble appearance (rounded, bordered, shadow, line-clamp-2, expand/collapse)
- **User bubble cleanup**: Remove wrapper div nesting, fork button now absolute top-right, eliminate extra bottom spacing
- **Horizontal overflow**: Fix always-visible horizontal scrollbar by moving overflow-x-hidden to StickToBottom wrapper

## [0.8.43] - 2026-03-25

### Fixed
- **Sticky user messages**: Only the last user message sticks to top — prevents multiple messages overlapping
- **npm package**: Exclude screenshot PNG files from published package

## [0.8.41] - 2026-03-25

### Improved
- **User chat bubble**: Full-width layout, 2-line collapse with expand/collapse, compact attachment chips
- **Sticky user messages**: Most recent user message sticks to top while scrolling through assistant responses
- **System tag rendering**: Claude system tags (`<system-reminder>`, `<claudeMd>`, etc.) rendered as collapsible badges instead of raw text
- **Markdown images**: Local file path images in assistant markdown now load via authenticated `/api/fs/raw` endpoint
- **Raw file endpoint**: New `GET /api/fs/raw?path=` for serving binary files (images, etc.)

### Refactored
- **Tunnel service**: Moved status file patching into service layer, cleaned up route handler

## [0.8.40] - 2026-03-24

### Fixed
- **Windows SDK hang**: Force `node` executable instead of `bun` for SDK subprocess on Windows to prevent hangs
- **Windows test-tool**: Re-exec `test-tool.mjs` via Git Bash on Windows

### Removed
- **SDK patch system**: Remove `patch-sdk.mjs` and runtime patching — no longer needed with upstream SDK fixes

## [0.8.39] - 2026-03-24

### Fixed
- **Binary frontend missing**: Compiled binary now ships with `web/` assets in archive (`.tar.gz`/`.zip`). Server looks for `web/` next to binary when running in compiled mode.
- **Windows install**: Fix TLS 1.2, SSL revocation, and download hang issues in PowerShell installer

## [0.8.38] - 2026-03-24

### Fixed
- **Binary daemon crash**: Compiled binary failed to spawn daemon — was passing `run script.ts` args which only work with `bun` runtime. Now detects compiled binary mode and spawns correctly.

## [0.8.37] - 2026-03-24

### Fixed
- **Intel Mac AVX crash**: Use baseline x64 builds that work on all Intel CPUs (no AVX requirement)
- **Linux ARM64**: Add `ppm-linux-arm64` binary for Raspberry Pi / ARM servers

## [0.8.36] - 2026-03-24

### Changed
- **Install script progress bar**: Show download progress during binary install
- **npm package size**: Exclude compiled binaries from npm tarball (154MB → ~20MB)

## [0.8.35] - 2026-03-24

### Fixed
- **Binary --version crash**: Fix `ENOENT: /$bunfs/package.json` error when running compiled binary — use static import instead of `readFileSync` so Bun embeds version at compile time
- **Install script upgrade check**: Check binary availability before downloading; show current vs new version and changelogs on upgrade; auto-add PATH to shell profile

## [0.8.34] - 2026-03-24

### Fixed
- **Remove stale YAML config references**: Update docs, help text, and architecture diagrams to reflect SQLite-based config storage — removes misleading `~/.ppm/config.yaml` references that could confuse users and AI assistants

## [0.8.33] - 2026-03-24

### Changed
- **Settings redesign**: Replace flat accordion with two-level iOS Settings-style navigation — quick-access settings (Device Name, Theme) at top, category drill-down (AI, Notifications, Accounts, Shortcuts) with back button. Scales infinitely without overflow.
- **Notifications grouped**: Push notifications and Telegram settings combined under single Notifications category
- **Open Chat shortcut**: Default changed from Cmd+Shift+L to Cmd+L

### Added
- **Auto-focus chat input**: Opening a new chat tab automatically focuses the message input

## [0.8.27] - 2026-03-24

### Changed
- **Temporary export/import**: Exported accounts no longer include refresh tokens — imported accounts are temporary (~1h access-only). Prevents token rotation conflicts between machines.
- **Temporary account UI**: Shows "Temporary" badge for accounts without refresh token, "Expired" badge when expired. Expired temporary accounts cannot be re-enabled.
- **Auto-cleanup**: Expired temporary accounts (no refresh token) are automatically deleted after 7 days.
- **Export warning**: Export dialog now explains that exported accounts are temporary and the importing machine should login directly for permanent access.
- **Invalid refresh token cleanup**: When refresh fails with `invalid_grant`, clears the refresh token so the account becomes temporary (same lifecycle rules apply: can't re-enable when expired, auto-deleted after 7 days)
- **Skip expired accounts in usage**: Expired temporary accounts are excluded from usage polling and usage panel — no wasted API calls or UI clutter

## [0.8.24] - 2026-03-24

### Fixed
- **Import token rotation**: After importing accounts, immediately refresh OAuth tokens so the importing machine owns fresh tokens. Source machine's tokens will be invalidated by Anthropic's rotation — warns user in UI.

## [0.8.23] - 2026-03-24

### Fixed
- **Stop disabling accounts on background refresh failure**: Startup and background auto-refresh no longer disable accounts when refresh fails — only actual query-time failures disable accounts. Prevents all accounts being disabled after server restart.
- **Better refresh error logging**: Log response body from Anthropic when token refresh fails (was only logging status code)
- **Token state diagnostic logging**: Log `token_expires_in` before each SDK query for debugging auth issues

## [0.8.22] - 2026-03-24

### Fixed
- **OAuth pre-flight token refresh**: Check token freshness before each SDK query and refresh proactively if expired or expiring within 60s
- **Auto-refresh on startup**: Run token refresh check immediately on server start instead of waiting 5 minutes for first interval
- **OAuth auto-refresh on auth failure**: Automatically refresh expired OAuth token and retry when SDK returns `authentication_failed`, instead of just showing error to user

## [0.8.21] - 2026-03-24

### Fixed
- **OAuth auto-refresh on auth failure**: Automatically refresh expired OAuth token and retry when SDK returns `authentication_failed`, instead of just showing error to user

## [0.8.20] - 2026-03-24

### Fixed
- **SDK patch resolution**: Use `fileURLToPath` instead of `new URL().pathname` for cross-platform SDK path resolution; add debug logging for bunx SDK resolution

## [0.8.19] - 2026-03-24

### Fixed
- **SDK patch for bunx**: Apply SDK patches (drain, await prompt, readline) at runtime before server start — `bunx` skips `postinstall` hooks so patches were never applied

### Changed
- **Settings UI**: Redesign from accordion to tabbed navigation (General, AI, Notifs, Accounts, Keys) with scroll areas and About section showing version

## [0.8.18] - 2026-03-24

### Fixed
- **Restart reliability**: Kill orphan processes holding the port via `lsof`/`netstat` (cross-platform), not just the PID from status.json — fixes restart failures when old server process outlives its PID record

## [0.8.17] - 2026-03-24

### Changed
- **Account settings UI**: Add "Lowest usage" option to strategy selector (BE validation + FE type + dropdown)

## [0.8.16] - 2026-03-24

### Changed
- **Keyboard shortcuts**: Git Graph default `⌘G` (was `⌘⇧G`), Terminal default `⌘'` (was `` ⌘` ``)
- **Command palette**: Show keyboard shortcut badges on action commands

## [0.8.15] - 2026-03-24

### Fixed
- **Usage polling reliability**: Replace `setInterval` with recursive `setTimeout` to prevent overlap and timer death from unhandled async rejections; wrap `pollOnce` in try/catch

### Added
- **Lowest-usage account strategy**: New `lowest-usage` routing strategy picks account with lowest 5-hour utilization, skips accounts at 100% weekly/5hr, falls back gracefully when all exhausted

## [0.8.14] - 2026-03-24

### Fixed
- **CLI error logging**: Always read stderr (even on exit code 0), log error event content to server logs for Windows CLI debugging

## [0.8.13] - 2026-03-24

### Added
- **Device name setting**: Editable device name in Settings UI — updates page title and syncs to PPM Cloud

## [0.8.12] - 2026-03-23

### Added
- **Execution mode setting**: Configurable `execution_mode` (sdk/cli) in Settings → AI Provider — replaces hardcoded Windows platform check

### Changed
- **claude-agent-sdk**: Bump from 0.2.76 to 0.2.81

## [0.8.11] - 2026-03-23

### Fixed
- **Windows dev workflow**: Replace shell `&` with `concurrently` for cross-platform dev script, run dev:server in foreground, use `--profile dev` for SQLite-based config
- **PowerShell daemon**: Fix `ArgumentList` rejecting empty strings by stripping trailing empties and using `_` placeholder

## [0.8.10] - 2026-03-23

### Fixed
- **Block project .env poisoning**: All auth env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are now explicitly set in SDK subprocess env — prevents Claude SDK from falling back to project `.env` which may contain unrelated/invalid keys (root cause of indefinite SDK hang)

## [0.8.9] - 2026-03-23

### Added
- **Base URL setting**: Configurable `base_url` in Settings → AI Provider, injected as `ANTHROPIC_BASE_URL`. Overrides shell env.

### Changed
- **Auth env priority**: PPM settings (accounts + base_url) > shell env. Project `.env` no longer read — prevents conflict with projects that use Claude API directly.

### Fixed
- **Env var diagnostics**: Timeout and error messages guide users to check `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` env vars with exact debug commands
- **Auth source logging**: Log which source each auth var comes from — helps diagnose SDK hangs

## [0.8.6] - 2026-03-23

### Fixed
- **Actionable timeout error**: Timeout error now shows project path, exact `claude -p "hi"` debug command, and steps to check hooks/MCP/settings
- **SDK lifecycle logging**: All SDK `system` events (hook_started, init, etc.) now logged with full JSON — helps diagnose where SDK hangs

## [0.8.5] - 2026-03-23

### Fixed
- **Diagnostic error messages for project-specific failures**: When SDK returns `assistant error: unknown`, error now includes project path and exact `claude` CLI command to run for diagnosis
- **Full SDK event dump on error**: Log complete assistant message JSON for debugging (visible in server logs)
- **Removed broken session retry**: Retry-as-fresh-session didn't help since fresh sessions also fail for the same project — removed to avoid masking the real error

## [0.8.4] - 2026-03-23

### Fixed
- **Poisoned session auto-recovery**: When resuming an existing SDK session fails with an assistant error (e.g. `unknown`), automatically retry as a fresh session instead of hanging for minutes — fixes projects stuck on a bad session

## [0.8.3] - 2026-03-23

### Fixed
- **WSL timeout diagnostics**: Connection timeout error now detects WSL environment and suggests specific DNS/proxy troubleshooting steps
- **No-credentials warning**: Log warning when no account and no API key in env — helps diagnose why SDK subprocess hangs

## [0.8.2] - 2026-03-23

### Fixed
- **Heartbeat during SDK connection**: Keep "Connecting... (Xs)" indicator alive until real content arrives — previously stopped by `account_info` event, causing misleading "thinking" state during 3-minute SDK failures
- **Unknown API error hint**: "API error: unknown" now shows actionable guidance (check connectivity, re-add account, new session)

## [0.8.1] - 2026-03-23

### Fixed
- **Silent timeout on account decrypt failure**: When all account tokens fail decryption (e.g. different machine key in WSL), now shows actionable error instead of 120s silent timeout
- **SDK error extraction**: Use `errors: string[]` array per SDK spec instead of non-existent singular `error` field — previously swallowed error details
- **Assistant message error detection**: Handle `SDKAssistantMessage.error` field for `authentication_failed`, `billing_error`, `rate_limit`, `server_error` per SDK spec
- **Empty success detection**: Detect SDK returning `success` with 0 turns and no content as silent failure, surface guidance to user
- **Network error hints**: Add WSL-specific hints for ConnectionRefused, auth failures, and connectivity issues

## [0.8.0] - 2026-03-23

### Added
- **Permission mode selector**: 4 Claude Code modes (default/acceptEdits/plan/bypassPermissions) — per-session sticky mode with Shift+Tab cycling
- **System prompt customization**: Global "Additional Instructions" textarea in AI Settings, threaded to SDK
- **PreToolUse hook for permissions**: In-process hook handles tool approval for non-bypass modes — surfaces approval requests to frontend via WebSocket
- **Git graph overhaul**: Modular components, infinite scroll, and lane recycling for improved performance

### Improved
- **Permission mode defaults**: Global default permission mode configurable in AI Settings
- **Config validation**: System prompt max 10K chars, invalid permission_mode auto-sanitized
- **Windows CLI fallback**: `--append-system-prompt` flag support

### Fixed
- **Mode selector dropdown**: Click-outside handler no longer closes dropdown before selection registers
- **QR code dark theme**: White background with color-scheme:light to prevent dark mode inversion
- **Cloud sign-in from UI**: Device code flow for web-based cloud login
- **Cloud unlink/logout**: Confirm dialogs to prevent accidental disconnection

## [0.7.36] - 2026-03-23

### Added
- **Cloud & Share popover**: New unified popover in project bar replacing old Share button — sign in to PPM Cloud, link device, share tunnel, view QR code, open cloud dashboard — all in one place
- **Cloud server API**: `/api/cloud/status`, `/api/cloud/login`, `/api/cloud/link`, `/api/cloud/unlink` endpoints for web UI integration
- **Auto-share on link**: Linking device auto-starts tunnel if not already sharing

### Improved
- **Project bar cleanup**: Extracted 180+ lines of share logic into dedicated `cloud-share-popover.tsx` component

## [0.7.35] - 2026-03-23

### Improved
- **Cloud link auto-sync**: `ppm cloud link` detects active tunnel and sends heartbeat immediately — device shows online on cloud dashboard without restart

## [0.7.34] - 2026-03-23

### Added
- **Device code login**: `ppm cloud login --device-code` for remote terminals (PPM terminal, SSH, headless). Enter 6-char code at ppm.hienle.tech/verify from any browser.
- **Auto-detection**: CLI auto-picks browser flow on desktop, device code flow on remote sessions. Falls back to device code if browser fails.

## [0.7.33] - 2026-03-23

### Fixed
- **Cloud sync from UI**: Share button in web UI now triggers cloud heartbeat sync (previously only CLI `--share` flag worked)
- **Heartbeat cleanup**: Stopping tunnel from UI properly cleans up cloud heartbeat interval

## [0.7.32] - 2026-03-23

### Added
- **PPM Cloud CLI**: `ppm cloud login/logout/link/unlink/status/devices` — connect PPM instances to PPM Cloud for device registry + tunnel URL sync
- **Auto-sync heartbeat**: `ppm start --share` automatically syncs tunnel URL to cloud every 5 minutes if device is linked
- **Cloud URL config**: `ppm config set cloud_url <url>` to use custom cloud instance

### Security
- Cloud auth files (`cloud-auth.json`, `cloud-device.json`) restricted to owner-only (chmod 0o600)
- XSS prevention in OAuth callback HTML
- Heartbeat interval cleanup prevents duplicate timers on restart

## [0.7.31] - 2026-03-23

### Improved
- **Restart message**: updated PPM terminal hint to "wait for auto-reconnect" instead of "reload the page" since web client reconnects automatically

## [0.7.30] - 2026-03-23

### Fixed
- **Restart from PPM terminal**: worker and restart command now ignore SIGHUP — killing the old server destroys the terminal PTY which sends SIGHUP to the process group, previously killing the worker before it could spawn the new server

## [0.7.29] - 2026-03-22

### Added
- **Auto-start on boot**: `ppm autostart enable/disable/status` registers PPM to start automatically via OS-native mechanisms — macOS launchd, Linux systemd, Windows Registry Run key
- **Cross-platform support**: auto-detects compiled binary vs bun runtime, resolves paths correctly on all platforms
- **VBScript hidden wrapper**: Windows auto-start runs PPM without visible console window
- **GitHub Actions CI**: test matrix for macOS, Linux, and Windows with unit + integration tests

### Technical
- 2-layer architecture: generator (pure functions, testable) + register (OS interaction)
- 40 unit tests + 20 integration tests (platform-specific with `describe.if`)
- KeepAlive/Restart-on-failure for crash recovery on all platforms

## [0.7.28] - 2026-03-22

### Added
- **Secure account export/import**: password-encrypted backup (scrypt + AES-256-GCM), selective account export, auto-refresh tokens before export
- **Import dialog**: inline error display for wrong password or corrupted backup

### Improved
- **Account cards**: compact 2-row layout, usage % inline, singular/plural "req(s)"
- **Test isolation**: bunfig.toml preload ensures all tests use in-memory DB (no more production DB writes)

### Fixed
- **Cross-machine account import**: tokens now properly re-encrypted with local machine key
- **Usage refresh spinner stuck**: refresh button no longer hangs when token decrypt fails

## [0.7.27] - 2026-03-22

### Fixed
- **Restart from PPM terminal**: restart spawns a detached worker process so it completes even when the server (and its terminals) are killed mid-restart
- **Restart result visibility**: restart command now polls for the worker's result and displays it inline; pre-restart message warns PPM terminal users to wait and reload
- **Restart server script path**: saved in `status.json` during `ppm start` to avoid ephemeral `bunx` cache path issues

## [0.7.26] - 2026-03-22

### Fixed
- **First message stuck on "thinking"**: send `streaming_status` immediately before `resumeSession` so FE gets heartbeat feedback even when SDK session lookup is slow
- **WS message silently dropped**: queue messages sent while WebSocket is still CONNECTING, flush on open instead of dropping

### Improved
- Added timing logs for `resumeSession`, `runStreamLoop` start, first SDK event delay, and all dropped `safeSend` events for easier debugging

## [0.7.25] - 2026-03-22

### Fixed
- **Git status mobile scroll**: file rows no longer accidentally open context menu while scrolling — tap opens diff, long-press (~400ms) opens action menu, with `select-none` to prevent text selection

## [0.7.24] - 2026-03-22

### Fixed
- **"In use" badge removed**: removed redundant "In use" label from active account card in usage panel
- **Scroll-to-bottom button overlap**: floating button no longer overlaps the chat input area

## [0.7.23] - 2026-03-22

### Fixed
- **Restart from PPM terminal**: restart command now spawns a detached worker process so it survives when the old server (and its terminals) are killed — previously running `ppm restart` inside a PPM terminal would kill the restart process itself before the new server could be spawned, causing persistent 502
- **Restart server script path**: save server entry script path in `status.json` during `ppm start` so restart always uses the stable installed location instead of a potentially ephemeral `bunx` cache path

## [0.7.22] - 2026-03-22

### Fixed
- **Mobile nav horizontal scroll**: tabs now scroll horizontally when many are open — added `min-w-0` to flex containers so `overflow-x-auto` works correctly

## [0.7.21] - 2026-03-22

### Improved
- **Usage refresh UX**: account cards stay visible during refresh instead of hiding behind "Loading..." text; changed accounts flash with a highlight animation for 1.5s so users can easily spot updated values

## [0.7.20] - 2026-03-22

### Fixed
- **Usage panel initial flash**: panel no longer briefly shows single-account view before loading multi-account cards
- **Usage panel reload**: clicking refresh now correctly re-fetches all account usages after server finishes polling Anthropic API, fixing race condition where stale DB snapshots were read before refresh completed
- **Clipboard API fallback**: export/import account data now works on mobile Safari — export falls back to file download, import shows a paste dialog when clipboard is unavailable
- **Duplicate account import**: import now skips accounts with matching email, not just matching ID — prevents duplicates when importing across devices

## [0.7.17] - 2026-03-22

### Changed
- **Merged usage & accounts panels**: combined the separate Accounts and Usage panels above chat input into a single "Usage & Accounts" panel with account controls (toggle, verify, profile) inline on each usage card
- **Consolidated action buttons**: Copy/Paste/Export/Import buttons in settings grouped into a "More" dropdown menu
- **Delete button**: replaced emoji `✕` with Lucide `X` icon
- **Touch targets**: increased icon button sizes for better mobile usability
- **Auto-dismiss toasts**: success/error messages in settings now auto-clear after 4 seconds
- **ON/OFF text → Switch**: quick panel account toggles now use consistent Switch component

### Fixed
- **Usage timestamp timezone**: SQLite `datetime('now')` returns UTC without `Z` suffix causing 7h offset in non-UTC timezones — now appends `Z` for correct parsing
- **Stale "last fetched" time**: usage refresh no longer shows old timestamp when data hasn't changed — `recorded_at` is touched on every successful fetch
- **Cascade delete**: deleting an account now removes its usage history snapshots from `claude_limit_snapshots`

## [0.7.16] - 2026-03-21

### Added
- **Account indicator on messages**: assistant messages now show `via <account label>` below the response when multi-account mode is active

## [0.7.15] - 2026-03-21

### Fixed
- **npm package**: exclude `.env.test` from published tarball

## [0.7.14] - 2026-03-21

### Added
- **Explorer gitignore dimming**: files/folders matched by `.gitignore` display at reduced opacity in the file tree
- **Multi-account E2E tests**: real AI call tests for SDK and CLI using token from `.env.test`; covers default auth, platform detection (macOS/Windows), and decrypt error handling

### Fixed
- **Explorer .env access**: removed hardcoded `.env` block from file tree, directory browser, and file read/write — `.env` files are now visible and editable like any other file

## [0.7.13] - 2026-03-20

### Fixed
- **Account decrypt crash on different machine**: `getWithTokens` now catches decrypt errors (mismatched `account.key`) and returns `null` instead of crashing the API

## [0.7.12] - 2026-03-20

### Fixed
- **Account list not loading**: use `Promise.allSettled` so one failing API call doesn't prevent accounts from showing

## [0.7.11] - 2026-03-20

### Fixed
- **Account export/import**: pass auth token in API calls (was using raw `fetch` without `Authorization` header)

## [0.7.10] - 2026-03-20

### Changed
- **Usage panel layout**: responsive grid (1–4 columns) replaces collapsible list for account usage cards
- **Usage data**: removed legacy fallback — each account shows only its own per-account data

### Removed
- **Health check polling**: removed `useHealthCheck` hook (5s `/api/health` ping + crash toast)

## [0.7.9] - 2026-03-20

### Added
- **Manual token input**: add Claude accounts via dialog — supports OAuth tokens (`claude setup-token`) and API keys with auto-detection
- **Per-account usage limits**: Usage Limits panel shows collapsible per-account sections with 5hr/weekly bars
- **Active account indicator**: chat header badge shows `[account label]`, account cards show "In use" badge and ring highlight
- **Inline usage bars**: compact 5h/Wk mini-bars on each account card in settings
- **API endpoints**: `GET /api/accounts/active`, `GET /api/accounts/usage`, `GET /api/accounts/:id/usage`, `POST /api/accounts`
- **DB migration v6**: `account_id` column on `claude_limit_snapshots` for per-account tracking

### Changed
- **Usage polling**: rewritten for multi-account with per-token 429 cooldown (respects `retry-after` header)
- **SDK env vars**: auto-detect token type — OAuth → `CLAUDE_CODE_OAUTH_TOKEN`, API key → `ANTHROPIC_API_KEY`

## [0.7.8] - 2026-03-20

### Fixed
- **AskUserQuestion answer text**: changed `text-accent` to `text-foreground` so the selected answer is clearly visible instead of muted

## [0.7.7] - 2026-03-20

### Fixed
- **Diff viewer loading forever**: `ResizeObserver` effect had empty deps `[]`, so it ran once at mount while the loading spinner was showing — `containerRef` was null, effect returned early, and Monaco never measured its container height after the API call completed; fixed by adding `loading`/`error` to the effect deps

## [0.7.6] - 2026-03-20

### Fixed
- **Diff viewer toolbar**: moved expand/word-wrap buttons into a fixed header bar (hidden on mobile); fixes toolbar being rendered outside the scroll container
- **Diff viewer empty state**: handles metadata-only diffs (file mode change, rename) where `parseDiff` returns no hunks — shows "No content changes" instead of blank screen

## [0.7.5] - 2026-03-20

### Added
- **Usage limit history (SQLite)**: Claude 5hr/weekly limit snapshots now persisted to `claude_limit_snapshots` table (migration v4) — inserts new row only when utilization or reset-time changes, auto-cleans records older than 7 days
- **Usage polling interval**: Changed from 60s to 2min; `GET /chat/usage?refresh=1` forces an immediate API fetch and waits before returning the fresh DB snapshot
- **FE reads from DB**: `refresh=0` reads latest snapshot directly from DB (no Anthropic API call); `refresh=1` waits for fresh fetch then reads DB

## [0.7.4] - 2026-03-20

### Added
- **Search: files to include filter** — filter search results by file/folder glob patterns (e.g. `*.ts`, `src/**`, `*.ts, *.tsx`); uses path-aware glob matching that supports `**` and path prefixes (unlike grep's `--include` which only matches filenames)
- **Search: replace input** — find & replace across files with "Replace All" button; applies the same case/word/regex options as the search query and shows replacement count on completion

## [0.7.3] - 2026-03-20

### Added
- **Mark as read**: `BellOff` button in chat toolbar clears notification badge for current session

### Fixed
- **Tab title badge timing**: Document title now updates immediately in background tabs using direct Zustand subscription instead of `useEffect` (which is throttled by browser when tab is hidden)
- **Tab title format**: Title now shows `{project} - {device} - PPM` pattern
- **Auto-clear on tab focus**: Notification badge clears automatically when switching back to browser or navigating to the active chat tab — no need to click the tab again
- **Left/right overflow badge direction**: Fixed incorrect badge side using `getBoundingClientRect()` instead of `offsetLeft` (which was relative to offsetParent, not scroll container)

## [0.7.2] - 2026-03-20

### Fixed
- **Tunnel URL sync**: `ppm start --share` tunnel URL now synced into `tunnelService` on daemon startup — Share button in web UI shows correct URL instead of treating tunnel as inactive and starting a duplicate

## [0.7.1] - 2026-03-20

### Fixed
- **Session rename persistence**: Use SDK `customTitle` field instead of volatile `summary` when listing/resuming sessions, so custom titles survive reloads
- **Session rename ID resolution**: Resolve PPM UUID → SDK session ID and pass project dir when renaming, ensuring SDK finds the correct session file
- **SDK crash recovery**: When SDK subprocess exits with code 1 during session resume, automatically retry as a fresh session instead of showing a cryptic error

## [0.7.0] - 2026-03-20

### Added
- **Notification system**: Zustand-based notification store with per-session tracking, unread counts in document title, and SVG favicon badge
- **Notification sounds**: 3 distinct Web Audio API tones — ascending chime (done), urgent alert (approval), soft triplet (question)
- **Notification badge colors**: red (approval_request), amber (question), blue (done) on tabs, project avatars, and scroll arrows
- **Telegram notifications**: Bot API integration with offline-only delivery, SSRF-safe bot token validation, HTML message formatting with deep links
- **Telegram settings UI**: Bot token + chat ID configuration with save/test buttons, test uses saved config when inputs empty
- **Settings accordion**: Collapsible sections for General, Notifications, Tunnel, Telegram, AI, and About
- **Tab overflow indicators**: Color-coded scroll arrows showing most urgent hidden notification type
- **Deep link support**: `?openChat=sessionId` query param to open/focus specific chat tabs
- **Database export/import**: Bulk export/import connections with deduplication, validation, and dropdown menu UI
- **Shared network utility**: Extracted `getLocalIp()` to `src/lib/network-utils.ts`

### Changed
- README simplified with concise quick-start guide

## [0.6.7] - 2026-03-19

### Added
- **QuestionCard component**: extracted standalone question UI with tabs, keyboard navigation (arrow keys, 1-9 quick select, Enter submit), custom "Other" input, proper light/dark mode contrast using primary color tokens
- **File browser picker**: consolidated `/api/fs/*` endpoints for command palette filesystem browsing

### Fixed
- **Project restore on reload**: URL project was ignored because effects overwrote the URL before `parseUrlState()` ran; now captures URL in a ref on mount
- **Command palette default order**: AI Chat option moved to top when no query entered
- **Light mode contrast**: QuestionCard replaced `accent` tokens (near-white in light mode) with `primary` for visible borders, selected states, and buttons

## [0.6.6] - 2026-03-19

### Added
- **Database management sidebar**: full CRUD for SQLite + PostgreSQL connections with color-coded groups, readonly enforcement, CLI commands (`ppm db list/add/remove/test/tables/schema/data/query`)
- **Unified database viewer**: generic `database-viewer.tsx` + `use-database.ts` hook — one viewer for all DB types via adapter pattern, auto-switches SQL dialect (PostgreSQL/SQLite)
- **Connection list tree UI**: dashed tree guide lines for groups and tables, inline table search filter, click-to-expand connections
- **Command palette DB search**: debounced search across cached tables (300ms, 2+ chars)
- **Tab data caching**: sessionStorage cache for instant table data display on page reload, with background refresh
- **Reload button**: toolbar button to force-refresh table data bypassing cache
- **Cached tables API**: `?cached=1` param for instant sidebar table loads without re-querying the database

### Fixed
- **SQLite cell update**: adapter now uses actual PK column instead of hardcoded `rowid`
- **Breadcrumb wrong table**: fixed race condition where `fetchTables` auto-selected first table before `initialTable` jump
- **Auth header missing**: database API calls now use shared `api` client with Bearer token
- **Stale closure in cell update**: `updateCell`/`executeQuery` pass explicit table args to avoid stale React closure
- **Tool card crash**: TodoWrite/AskUserQuestion cards crashed when SDK sent non-array input fields
- **Effort level "max"**: removed unsupported effort level, auto-downgrades to "high" on config load
- **Provider ID mismatch**: fixed stale "claude-sdk" references across routes, hooks, and tests
- **Test suite**: fixed all 19 test failures (isolation, flaky assertions, missing cloudflared skip)

## [0.6.4] - 2026-03-19

### Fixed
- **Login infinite reload**: keybindings API call fired before auth check, causing 401 → token removal → reload loop after SQLite migration
- **ApiClient reload guard**: added sessionStorage-based guard to prevent infinite reload loops from any pre-auth 401 response

## [0.6.3] - 2026-03-19

### Added
- **Customizable keyboard shortcuts**: new settings section with click-to-record UI, synced to server (SQLite) across browsers
- **New shortcuts**: Open Chat (`Mod+Shift+L`), Open Terminal (`` Mod+` ``), Open Settings (`Mod+,`), Git Graph (`Mod+Shift+G`), Git Status sidebar (`Mod+Shift+E`), Switch Project 1-9 (`Mod+1..9`)
- Locked shortcuts shown with lock icon, browser-reserved warning banner

### Fixed
- **Chat picker Enter key**: pressing Enter now selects the slash/file picker item instead of also sending the message

## [0.6.2] - 2026-03-19

### Added
- **PostgreSQL viewer**: connect to any PostgreSQL database via connection string, browse tables, edit cells (double-click), run SQL queries with CodeMirror (PostgreSQL dialect), paginated results
- **Command palette**: "PostgreSQL" action to open a new database viewer tab

## [0.6.1] - 2026-03-19

### Added
- **SQLite viewer**: open `.db`/`.sqlite`/`.sqlite3` files in dedicated viewer with table sidebar, TanStack Table data grid (double-click to edit cells), CodeMirror SQL editor, and paginated results
- **SQLite backend API**: `bun:sqlite`-powered endpoints for tables, schema, data, query execution, and cell updates with connection caching and auto-close
- **Tab auto-redirect**: editor tabs for SQLite files automatically switch to the SQLite viewer

### Fixed
- **SQLite viewer**: support absolute file paths (e.g. `~/.ppm/ppm.db`) in addition to project-relative paths

## [0.6.0] - 2026-03-19

### Added
- **Storage migration**: migrated all file-based storage (config, sessions, usage) to SQLite

## [0.5.21] - 2026-03-18

### Added
- **Share: local network URL** — share popover now shows a "Local Network" link (device IP + port) for same-network access, always visible without starting a tunnel
- **Share: separate Cloudflare section** — public tunnel URL shown under "Public (Cloudflare)" label with QR code, only after user clicks "Start Sharing"

## [0.5.20] - 2026-03-18

### Fixed
- **Build: relative outDir for Monaco plugin** — use relative `outDir` path (`../../dist/web`) instead of `resolve(__dirname, ...)` to fix Monaco editor worker plugin on Windows builds
- **PWA: increase cache size limit** — set `maximumFileSizeToCacheInBytes` to 15MB so large Monaco/worker bundles are cached by the service worker

## [0.5.19] - 2026-03-18

### Fixed
- **Cloudflare tunnel: WS handshake** — FE now sends `{ type: "ready" }` after `onopen`, server responds with status. Through Cloudflare tunnels, the server's `open`-handler message may not arrive because the end-to-end data path isn't fully established when the local WS opens. The roundtrip handshake ensures the path is working before sending connected/status confirmation.

## [0.5.18] - 2026-03-18

### Fixed
- **Cloudflare tunnel: WebSocket events not reaching FE** — switch from protocol-level `ws.ping()` to application-level JSON pings (Cloudflare can intercept protocol pings, masking dead connections). Disable `perMessageDeflate` to prevent compressed frame issues through tunnel proxy. Add diagnostic logging to `safeSend` to detect dropped messages.

## [0.5.17] - 2026-03-18

### Fixed
- **Windows: resume sessions that exist on disk** — when no explicit mapping but `getSessionMessages()` finds messages, use PPM UUID for `--resume` (session was created with that ID). Prevents losing conversation context when resuming old sessions via CLI fallback

## [0.5.16] - 2026-03-18

### Fixed
- **Windows: fix `--resume` with non-existent session** — only pass `--resume` to CLI when a confirmed session mapping exists (from a previous `system/init` event). Previously, failed first messages (ENOENT, TypeError) incremented `messageCount` but never saved a mapping, causing subsequent messages to `--resume` with a PPM UUID the CLI doesn't recognize

## [0.5.15] - 2026-03-18

### Fixed
- **Windows: surface CLI errors to frontend** — read all stderr (not just first 500 chars), extract actual error message from end of output, yield as error event so frontend shows real crash reason instead of silent failure

## [0.5.14] - 2026-03-18

### Fixed
- **Windows: `claude` .cmd resolution** — `Bun.spawn` can't resolve `.cmd` wrapper scripts (npm globals) directly. Now spawns via `cmd /c claude` so Windows shell resolves PATH correctly

## [0.5.13] - 2026-03-18

### Fixed
- **Windows: simulated token streaming** — CLI `stream-json` only emits complete `assistant` messages (no per-token deltas). Now synthesizes `stream_event` / `content_block_delta` events in ~30-char chunks so FE gets smooth typing effect instead of all text appearing at once

## [0.5.12] - 2026-03-18

### Fixed
- **Windows: direct CLI fallback for chat** — on Windows, bypass SDK `query()` (broken due to Bun subprocess pipe buffering) and spawn `claude -p --verbose --output-format stream-json` directly. Same event format, same features — streaming, tools, session resume all work
- Removed SDK timeout/diagnostic code (no longer needed with direct CLI fallback)

## [0.5.11] - 2026-03-18

### Fixed
- **SDK 30s timeout with diagnostics** — if SDK query produces no events within 30s, auto-closes the query, runs a direct `claude -p` test, and shows a clear error to the user instead of hanging forever
- **Better error messages** — timeout error suggests using `ppm chat` (terminal) or Node.js as workaround for Bun+Windows SDK issue

## [0.5.10] - 2026-03-18

### Added
- **SDK diagnostic logging** — logs `claude --version` output, auth env var status (SET/unset) before each query; helps identify why SDK hangs on Windows

## [0.5.9] - 2026-03-18

### Fixed
- **Windows: SDK query hangs silently** — provide fallback `cwd` (home directory) when no project selected; undefined cwd caused SDK subprocess to fail on Windows daemons
- **Better SDK diagnostics** — log claude CLI path check, full error stack on failure; helps debug Windows daemon PATH issues

## [0.5.8] - 2026-03-18

### Fixed
- **Windows: Claude SDK chat not connecting** — stopped unconditionally clearing `ANTHROPIC_API_KEY` env var; now only neutralizes keys found in project `.env` files (prevents .env poisoning without breaking API key auth users)
- **Chat connection timeout** — added 120s timeout for SDK first response; shows clear error message instead of spinning forever

### Added
- **Share tunnel from UI** — Share button in project bar starts Cloudflare tunnel with QR code and copy URL
- **Tunnel API** — `GET/POST /api/tunnel` endpoints to check status, start, and stop tunnels

## [0.5.7] - 2026-03-18

### Fixed
- **Windows: PowerShell Start-Process rejects same file for stdout/stderr** — use separate `.err.log` for stderr redirect

## [0.5.6] - 2026-03-18

### Added
- All CLI commands now print PPM version before execution for easy version verification

## [0.5.5] - 2026-03-18

### Fixed
- **Windows: PowerShell Start-Process fails with empty config arg** — filter empty strings from daemon spawn arguments

## [0.5.4] - 2026-03-18

### Fixed
- **Windows: daemon process dies when parent exits** — use PowerShell `Start-Process` for truly detached daemon and tunnel processes on Windows
- **Windows: `ppm status -a` / `stop -a` crash** — replaced `pgrep` (Unix-only) with `wmic` on Windows
- Daemon startup now verifies child process is alive after 500ms — shows clear error + suggests `-f` if daemon fails

## [0.5.3] - 2026-03-18

### Added
- `ppm status -a` — list all PPM and cloudflared system processes (tracked + untracked)
- `ppm stop -a` — kill all PPM and cloudflared processes including orphan/zombie ones
- Terminal light theme support — xterm colors follow system/user theme setting
- Git status panel: dropdown actions, `onNavigate` callback for mobile drawer auto-close
- Diff viewer: force inline mode on mobile (<768px), ResizeObserver for dynamic height
- Cross-platform `basename()` utility in `@/lib/utils`

### Fixed
- Panel grid was column-major (`grid[col][row]`) — corrected to row-major (`grid[row][col]`)
- Panel split directions (horizontal adds column within row, vertical adds new row)
- Mobile textarea auto-resize using correct ref (`mobileTextareaRef`)
- Attachment chips moved inside input container for better alignment
- Resize handle thickness reduced (2→1) for cleaner look
- `init` command: use `path.basename()` instead of manual split
- Server daemon spawn: use `path.resolve()` for `import.meta.dir` path join
- Remove leftover SDK debug `console.log` statements

### Changed
- Config service: added diagnostic logging for config search path resolution
- `MAX_ROWS` increased from 2 to 3
- Panel layout orientations swapped: outer=vertical (rows), inner=horizontal (columns)

## [0.5.2] - 2026-03-18

### Added
- Context window usage percentage (Ctx:N%) in chat header bar
- SDK rate-limit and cost events write directly to backend cache

### Fixed
- Windows: path separator in project resolution (`/` → `path.sep`)
- Windows: session resume hangs when session not found in SDK history
- Usage detail panel shows "No data" even when badge has data (unified to single REST polling source)

### Changed
- Usage data flows through single backend cache instead of dual WS + REST paths
- Frontend only polls REST endpoint for usage (removed WebSocket mergeUsage path)

## [0.5.1] - 2026-03-18

### Added
- Sidebar tabs auto-hide text when width < 240px (icons only)
- Auto-refresh file tree on window focus (TODO: fs.watch for real-time)
- Drag-and-drop project reorder on desktop, move up/down on mobile
- Test notification button in settings
- Mobile drawer settings tab (replaces history), project sheet settings button works
- Push notification error feedback with 5s timeout on service worker

### Fixed
- Tab bar bottom border alignment with -mb-px overlap
- Close button on toast notifications
- Remove bug report icon from chat toolbar
- Push subscribe infinite loading in dev mode (service worker timeout)

## [0.5.0] - 2026-03-18

### Added
- **Thinking block**: Stream Claude's extended thinking in collapsible block (auto-collapse when done)
- **Fork/Rewind**: Retry from any user message — forks session, opens new tab with full history
- **Streaming status**: "Thinking... (5s)" with elapsed timer, adaptive warning threshold
- **Command palette "Ask AI"**: No results → Enter sends query to new chat tab
- **Usage auto-polling**: BE fetches every 60s with retry, FE reads cache with `lastFetchedAt` timestamp
- **Mobile bottom sheet**: Command palette as bottom sheet on mobile, + button opens it
- **Scroll to bottom**: Floating button when user scrolls up, auto-stick-to-bottom with use-stick-to-bottom
- **Prompt-kit input**: Rounded container with textarea + action bar, compact on mobile

### Fixed
- WS race condition: entry.ws null during reconnect → all stream events dropped
- Always send `done` from stream loop finally block (prevents infinite spinner)
- Child tool_results from subagent user messages now yielded correctly
- React re-render: new parent object on children update for shallow comparison
- ThinkingIndicator: show only after tool_result, not while tool running
- Settings button opens sidebar tab instead of creating new tab
- 429 rate limit on usage API handled gracefully
- Global BugReportPopup via custom event

## [0.4.5] - 2026-03-17

### Fixed
- Windows: graceful shutdown — Ctrl+C kills cloudflared + releases port
- Windows: `ppm stop` kills orphan cloudflared.exe via taskkill
- Windows: cloudflared tunnel uses 127.0.0.1 instead of localhost (IPv6 mismatch)
- npm package size reduced from 79MB to ~580KB

## [0.4.2] - 2026-03-17

### Added
- Subagent/tool hierarchy: Agent/Task tool cards show nested child tools (Bash, Read, etc.)
- Child events streamed with `parentToolUseId` and grouped under parent Agent card
- Collapsible subagent container with accent border and step counter
- Follow-up messages sent immediately (cancel + send) instead of queuing until done

### Fixed
- Tool status indicators (spinner/checkmark) now correctly reflect completion state
- `pendingToolCount` no longer incremented for subagent child tools
- Top-level tool_results extracted directly from SDK `user` messages
- Windows: cloudflared binary download (`.exe` support)
- Windows: static file serving replaced hono serveStatic with Bun.file() for path compatibility

## [0.4.1] - 2026-03-17

### Fixed
- Command palette crash when initialQuery is not a string (TypeError: q.startsWith)
- Reset paletteInitialQuery on all keyboard triggers (Shift+Shift, F1)
- Disable Monaco editor diagnostics (semantic, syntax, suggestions) for JS/TS
- Windows support for cloudflared binary download

## [0.4.0] - 2026-03-17

### Added
- Resizable sidebar (200-600px, persisted to localStorage)
- Settings tab in sidebar (replaces history tab)
- Command palette: F1, Shift+Shift, double-click/right-click tab bar
- Filesystem file browser: type `/` or `~/` in command palette to browse any file
- `/api/fs/list`, `/api/fs/read`, `/api/fs/write` endpoints (cross-platform, Node.js fs)
- Editor supports opening external files (absolute paths outside project)
- Shared MarkdownRenderer component with table scroll, link handling, file path detection
- Clickable inline code: file names like `config.ts` are underlined and open in editor
- Smart file open: 1 match opens directly, multiple matches open command palette
- Middle-click on tab closes it
- Chat toolbar: unified History, Config, Usage in single row with exclusive panels
- History panel search input + refresh button
- Compact AI settings for chat panel
- Cmd/Ctrl+S prevents browser save dialog

### Changed
- Sidebar tab: History replaced with Settings
- Tab bar: + button opens command palette instead of dropdown menu
- Tab bar: + button inside scroll area, sticky when overflow
- Settings removed from panel tabs (now in sidebar only)
- External links in markdown open in new browser tab (target=_blank)
- Tables in markdown auto-scroll horizontally on overflow
- Removed toolbar from code editor and diff viewer

### Fixed
- Text selection preserved on mouse up (onMouseDown for panel focus)
- Double-click text selection in chat (skip re-render if panel already focused)
- Inline code file detection: split around `<pre>` blocks for correct matching

## [0.3.0] - 2026-03-17

### Added
- Project Switcher Bar: 52px non-collapsible sidebar with project avatars and quick-access buttons
- Project color customization with 12-color palette + custom hex input
- Project drag-to-reorder (PATCH /api/projects/reorder endpoint)
- Mobile ProjectBottomSheet for project switching on touch devices
- Sidebar tab system: Explorer, Git, History (replaces dropdown)
- Chat history panel in sidebar
- Smart project initials with collision detection
- EmptyPanel quick-open buttons for new workspaces
- Device name badge on mobile

### Changed
- Migrated code editor from CodeMirror 6 to Monaco Editor (@monaco-editor/react)
- Migrated diff viewer to Monaco DiffEditor
- Thin scrollbar styling (5px webkit, scrollbar-width:thin Firefox)
- Removed obsolete tab types: projects, git-status (consolidated into sidebar)

### Fixed
- Keep-alive workspace switching: per-project grid snapshots preserve DOM and tab state
- Chat tab reads projectName from own metadata instead of global activeProject
- Chat provider ID default corrected: "claude-sdk" → "claude"

## [0.2.4] - 2026-03-17

### Added
- Project Switcher Bar: narrow 52px left sidebar with project avatars and quick-access buttons
- Project color customization with 12-color palette + custom hex input
- Project drag-to-reorder functionality (PATCH /api/projects/reorder endpoint)
- Mobile ProjectBottomSheet for project switching on touch devices
- Keep-alive workspace switching: hides/shows instead of unmounting, preserves xterm DOM across projects
- Sidebar tab system with Explorer, Git, and History tabs (replaces dropdown tabs)
- Chat history panel component for browsing past chat sessions from sidebar
- Smart project initials with collision detection (1-char, 2-char, or index fallback)

### Changed
- Migrated code editor from CodeMirror 6 to Monaco Editor (@monaco-editor/react)
- Upgraded diff viewer to Monaco diff viewer for better syntax highlighting
- Removed obsolete tab types: projects, git-status (consolidated into sidebar)
- Alt+Z keyboard shortcut for word wrap toggle in editor and diff viewer
- Improved editor performance on large files with Monaco's efficient rendering

### Technical
- New endpoints: PATCH /api/projects/reorder, PATCH /api/projects/:name/color
- Updated Project interface with optional color field
- New utility modules: project-avatar.ts (initials), project-palette.ts (color palette)
- UI components: ProjectBar, ProjectBottomSheet, ChatHistoryPanel

## [0.2.3] - 2026-03-16

### Changed
- Replace ccburn CLI with native OAuth API fetch for usage limits (700ms vs 3-5s)
- Health check uses WebSocket instead of HTTP polling (avoids browser 6-conn limit)
- Usage tracking separated into independent `useUsage` hook with auto-refresh

### Removed
- `ccburn` dependency (no longer needed)

## [0.2.2] - 2026-03-15

### Added
- Single source of truth for version (`src/version.ts` reads from `package.json`)
- Version shown in daemon start output

### Fixed
- Version no longer hardcoded in multiple files

## [0.2.1] - 2026-03-15

### Added
- `ppm logs` command — view daemon logs (`-n`, `-f`, `--clear`)
- `ppm report` command — open GitHub issue pre-filled with env info + logs
- Daemon stdout/stderr written to `~/.ppm/ppm.log`
- Frontend health check — detects server crash, prompts bug report
- Sensitive data (tokens, passwords, API keys) auto-redacted from logs
- `/api/logs/recent` public endpoint for bug reports

## [0.2.0] - 2026-03-15

### Added
- `--share` / `-s` flag — public URL via Cloudflare Quick Tunnel
- Default daemon mode — `ppm start` runs in background
- `--foreground` / `-f` flag — opt-in foreground mode
- `ppm status` command with `--json` flag and QR code
- `ppm init` — interactive setup (port, auth, password, share, AI settings)
- Auto-init on first `ppm start`
- Non-interactive init via flags (`-y`, `--port`, `--auth`, `--password`)
- `device_name` config — shown in sidebar, login screen, page title
- `/api/info` public endpoint (version + device name)
- QR code for share URL in terminal
- Auth warning when sharing with auth disabled
- Cloudflared auto-download (macOS .tgz + Linux binary)
- Tunnel runs as independent process — survives server crash
- `ppm start --share` reuses existing tunnel if alive

### Changed
- `ppm start` defaults to daemon mode (was opt-in)
- Status file `~/.ppm/status.json` replaces `ppm.pid` (with fallback)
- `ppm stop` kills both server and tunnel, cleans up files

## [0.1.6] - 2026-03-15

### Added
- Configurable AI provider settings via `ppm.yaml`, API, and UI
- Chat tool UI improvements, diff viewer, git panels, editor enhancements

### Fixed
- Global focus-visible outline causing blue ring on all inputs
- Unified input styles across app
