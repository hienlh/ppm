# PPM Project Changelog

All notable changes to PPM are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

**Current Version:** v0.8.53

---

## [0.8.54] — 2026-03-25

### Added
- **Auto-upgrade feature** — Full implementation with supervisor, API, CLI, and UI components
  - Supervisor checks npm registry every 15 minutes for new versions
  - UI banner displays when new version available with one-click upgrade button
  - `ppm upgrade` CLI command for headless systems (with `--check` flag to preview)
  - Self-replace mechanism: supervisor spawns new supervisor from updated code, waits for health, then exits old
  - Self-replace eliminates OS autostart dependency — upgrade works even on headless/containerized systems
  - GET `/api/upgrade/status` returns current version, available version, install method (npm/bun/binary)
  - POST `/api/upgrade/apply` installs new version and signals supervisor for restart
  - Compiled binary installs gracefully rejected with clear message (future: GitHub releases support)
  - Config option: `autoUpgrade` setting (default: true) allows opt-out
  - All upgrade routes require authentication

### Technical Details
- **Services**: `src/services/upgrade.service.ts` handles version checking, semver comparison, install method detection, and installation
- **Supervisor**: Enhanced with 15-minute version check timer, available version tracking in status.json, SIGUSR1-triggered self-replace
- **API Routes**: `src/server/routes/upgrade.ts` with status and apply endpoints
- **CLI**: `src/cli/commands/upgrade.ts` with interactive upgrade and check-only mode
- **UI**: `src/web/components/layout/upgrade-banner.tsx` fixed-position banner with dismiss/upgrade buttons, polling every 60s
- Install method detection: `isCompiledBinary()` → binary, `process.execPath.includes("bun")` → bun, else → npm
- Semver comparison: lightweight string split (no external lib)
- Self-replace implementation: saves `process.argv`, spawns new supervisor, polls status.json for new PID, waits up to 30s

---

## [0.8.53] — 2026-03-18

### Fixed
- Keybindings: prevent command palette false trigger during IME composition

---

## [0.8.52] — 2026-03-15

### Added
- Process supervisor with auto-restart and tunnel resilience
  - Supervisor spawns and monitors server + tunnel processes
  - Auto-restart on crash with exponential backoff
  - Health checks every 30 seconds
  - Cloudflare tunnel auto-reconnect on failure
  - Status file (~/.ppm/status.json) tracks PID, port, URL

---

## [0.7.x — v0.8.52] — Prior Releases

Multi-account credential management, usage tracking, mobile UX optimization, Cloudflare tunnel integration, push notifications, terminal output streaming.

---

## Categories

- **Added** — New features
- **Fixed** — Bug fixes
- **Changed** — Behavioral changes
- **Deprecated** — Features marked for removal
- **Removed** — Removed features
- **Security** — Security vulnerability fixes

---

## Version Scheme

PPM uses semantic versioning: MAJOR.MINOR.PATCH

- MAJOR: Breaking changes to API/CLI/config format
- MINOR: New features (backward compatible)
- PATCH: Bug fixes and small improvements
