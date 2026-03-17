# Changelog

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
