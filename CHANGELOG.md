# Changelog

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
