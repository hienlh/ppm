# Changelog

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
