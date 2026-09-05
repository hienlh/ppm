# PPM Project Roadmap

**Last Updated:** September 5, 2026 · **Current release:** v0.18.x

> `CHANGELOG.md` is the authoritative release history. This file tracks *direction* — what shipped,
> what is still open, and why. Where a version table below disagrees with the changelog, the
> changelog wins.

## Vision

PPM is the **lightest path from phone to code** — a self-hosted, BYOK, multi-device web IDE with AI. No desktop app install needed. No subscription. Everything on your machine, accessible from any browser.

---

## Completed Milestones

### v0.18 — Windows, floating windows, whole-machine tooling (Released)
- **Tab pop-out → floating window → Document Picture-in-Picture** — any desktop tab detaches into an
  in-app floating window and from there into an always-on-top browser PiP window; both directions
  reversible, terminal/editor/chat state survives every move (no tab remount). Radix
  dropdowns/tooltips/dialogs follow a popped-out tab into the PiP document. Desktop only.
  See `docs/architecture/workspace-and-ui.md` → "Tab-host windows".
- **System Monitor became a whole-machine task manager** — CPU per core, RAM, disk, network and
  NVIDIA GPU charts; every process grouped by app with live CPU/RAM/disk/GPU; end a process or a
  whole app group (PPM's own, its tunnel and OS-critical processes are refused). Works on Windows,
  where the previous monitor showed nothing. One long-lived PowerShell collector — never per tick.
- **Unified window chrome** — the macOS/Windows skin chosen for Explorer applies to every window.
- **File upload** — toolbar/mobile picker/OS drag-and-drop, per-file progress with cancel, queued
  collision prompts with "Apply to all", Replace routes the old file to Trash first.
- **Agent teams surfaced in chat** — live "who is working" bar under the conversation with step and
  elapsed time; tap to replay a teammate's whole session (floating window on desktop, sheet on mobile).
- **Media** — video player with rotate/flip, speed, volume and keyboard shortcuts; on-the-fly
  transcoding for unsupported formats, seek-safe over a tunnel.
- **Windows autostart** works for standard accounts (task-definition registration, no 72h run limit).

### v0.17–v0.18.0 — OS File Explorer Window (Released)
- Floating, OS-skinned file explorer window (Windows 11 / macOS Finder chrome, Linux → macOS skin) — drag, 8-way resize, multi-instance, persisted rect
- Browses the whole host filesystem via `/api/fs`, hardened to whole-disk scope (protected roots, PPM-dir shield, single-use path-bound download tokens)
- List / Icons (thumbnails) / Column (Miller) views; sidebar with drives, known folders, OS-pinned folders (Quick Access / Finder Favorites / GTK+KDE), PPM pins
- Double-click opens PPM-viewable files (incl. external `.db` via the host SQLite viewer) in the existing tab system; OS-style actions otherwise (Cut/Copy/Paste, Rename, Trash/Delete permanently, New, Properties)
- Mouse drag-and-drop of entries across explorer windows, sidebar, and the project tree (move / Ctrl-copy)
- Mobile: full-screen bottom-sheet variant of the same body (long-press menu, Select mode, single-column view)

### v0.1–v0.5 — Foundation (Released)
- Bun runtime, Hono server, React + Vite frontend
- File explorer, Monaco editor, xterm.js terminal
- AI chat (Claude Agent SDK), git integration, PWA
- Multi-project, project-scoped API, CLI commands
- Database management (SQLite/PostgreSQL)

### v0.6 — Polish (Released)
- Project Switcher Bar, keep-alive workspace switching
- Auto-generate chat session titles, inline rename
- Database adapters, connection UI, query execution

### v0.7 — Multi-Account & Mobile (Released)
- Multi-account credential management (OAuth + API key)
- Account routing (round-robin, fill-first)
- Usage tracking per account with visual dashboard
- Account import/export with encryption + clipboard fallback
- Mobile UX: horizontal tab scroll, long-press context menus, touch optimization
- Cloudflare tunnel, push notifications, Telegram alerts

### v0.8.0 — "Always On" (Released)

| Feature | Status | Notes |
|---------|--------|-------|
| **PPM Cloud** | ✅ Done | Device registry + tunnel URL sync, Google OAuth, phone dashboard, remote restart. `ppm cloud login/status/devices/alias/logout`. Stores email + machine names + tunnel URLs only. |
| **Auto-start** | ✅ Done | launchd / systemd / Windows Task Scheduler. `ppm autostart enable\|disable\|status`. Auto-enabled on first `ppm start`; stale systemd units are migrated. |
| **Auto-upgrade** | ✅ Done | Supervisor polls the npm registry, UI banner, one-click upgrade via API or CLI, supervisor self-replaces. (v0.8.54) |
| **Supervisor Always Alive** | ✅ Done | Soft stop (`ppm stop`) vs full shutdown (`ppm down`); `stopped` state keeps Cloud WS + tunnel alive. (v0.9.11) |
| **AI Chat enhancements** | ✅ Done | Provider/model selector, reasoning effort, permission mode, system prompt customization, collapsible tool calls, durable replayable streams. |
| **Scheduled Agents** | ✅ Done | Cron scheduler: persistent session per job + rotation >80% context, concurrency guard, budgets, CLI `ppm schedule`, REST `/api/schedules`, Settings UI, Telegram summary. |

### v0.9.0 — "Open Platform" (Released)

| Feature | Status | Notes |
|---------|--------|-------|
| **Multi-provider AI** | ✅ Done | ProviderInterface + registry; Claude Agent SDK built in, Cursor CLI and OpenAI Codex auto-register when their binaries exist. |
| **MCP Management** | ✅ Done | REST CRUD + import, SQLite storage, Settings UI, auto-import from `~/.claude.json`, SDK integration. |
| **Extension architecture** | ✅ Done | VSCode-compatible npm extensions, Bun Worker isolation, RPC protocol, state persistence, contribution registry, CLI + dev mode, `@ppm/vscode-compat` shim, StatusBar/TreeView/Webview/QuickPick/InputBox, WS bridge. First extension: `ext-database`. See `docs/extension-development-guide.md`. |

**v0.9.x polish (post-release):**
- File download (v0.9.2) — single-file + folder-as-zip with short-lived tokens
- Agent Team UI (v0.9.9) — team activity button, members + messages panel
- Git-Graph UI (v0.9.85+) — faithful SVG graph (vscode-git-graph port), interactive stage/unstage/commit/stash, branch filters, auto-fetch, mobile support
- Git Workflow (v0.9.86+) — stash management, rebase from context menu, conflict detection, inline Monaco conflict resolution, worktree CRUD

### v0.10.0 — "Enhanced Workflow" (Released)

| Feature | Status | Notes |
|---------|--------|-------|
| **Agent Team** | ✅ Done | Live member activity (status, current step, model, elapsed), Members/Messages tabs, both directions of the team conversation, replay any member's session. Teams are read from agent transcripts, not `~/.claude/teams` config — see `src/services/team-member-activity/`. |
| **Group chat** | ✅ Done | Multi-agent group conversation with turn engine, responder routing, context-window management and transcript archiving. |
| **Advanced Git Operations** | ◐ Partial | Rebase, stash, conflict resolution and worktrees shipped. Cherry-pick exists as `POST /git/cherry-pick` with **no UI**. Interactive-rebase UI and merge-strategy selection not started. |

---

## Upcoming Roadmap

### v0.11.0 — "Intelligence" (open)

| Feature | Priority | Status | Description |
|---------|----------|--------|-------------|
| **Telegram Bot (PPMBot Coordinator)** | High | ✅ Done (v0.9.11) | Coordinator session per chat delegates project tasks to subagents. Persistent identity in `~/.ppm/bot/coordinator.md`. CLI-driven delegation via `ppm bot`. Cross-provider. |
| **Hooks system** | High | — | Event hooks for PPM lifecycle (file save, git commit, chat message). Foundation for a Skills API and deeper extension integration. No implementation yet. |
| **PPM Skills API** | Medium | ◐ Redirected | Shipped as an *external* surface instead: `ppm export skill` generates a Claude Code skill that drives PPM through its CLI, HTTP API and SQLite config DB. A stable *internal* AI-facing API is still unbuilt — decide whether it is still wanted before scheduling. |
| **Built-in Clawbot** | Medium | — | Lightweight in-process agent on the Messages API. Superseded in practice by the multi-provider registry + PPMBot; keep only if the "AI authors extensions" story is still a goal. |
| **More providers** | Medium | ◐ Partial | Codex ✅, Cursor ✅. Gemini CLI and Tier-3 (any OpenAI-compatible API) not started — note PPM already *serves* an OpenAI-compatible endpoint via the proxy, it just does not *consume* one. |

### v1.0.0 — "Production Ready" (Q4 2026)

| Feature | Priority | Description |
|---------|----------|-------------|
| **Self-hosted PPM Cloud** | High | Docker image of PPM Cloud for enterprise/team. Same codebase, self-hosted config flag. LDAP/SSO. |
| **PPM Marketplace** | High | Publish/install/update extensions, browse community extensions. Today extensions install from npm only. |
| **Stability & hardening** | Critical | Security audit, performance work, test coverage, contributor docs, CI/CD. |
| **Inline SQL** | Medium | Select text in Monaco → run as SQL, connection picker in the editor context menu, results panel below the editor. Not started. |

---

## Post-v1.0 — Feature Backlog (To Be Prioritized)

Features to pick from after v1.0. Will be reviewed and scheduled based on user feedback and strategic priorities.

| Feature | Category | Description |
|---------|----------|-------------|
| **Collaborative viewing** | Social | Read-only live session sharing via tunnel. Others watch terminal/editor real-time. High demo value. |
| **Workspace snapshots** | UX | Save/restore full state (open files, terminals, chat). Critical for mobile where browser kills tabs. |
| **Ollama / local models** | AI | Run AI offline with local models. No API cost, privacy-first. |
| **Project templates** | DX | `ppm init --template react/nest/go`. Community templates from Marketplace. |
| **AI command palette** | AI | Natural language commands ("deploy production", "run tests"). |
| **Layout customization** | UX | User arranges panels freely. Save separate desktop vs mobile layouts. |
| **Performance profiling** | DevTools | Flamegraph viewer, memory tracking, network waterfall. |
| **Multi-user workspace** | Enterprise | Shared project access, role-based permissions, team features. |
| **Mobile terminal UX** | Mobile | Virtual keyboard shortcuts, gesture controls, better touch input. |
| **CI/CD integration** | DevOps | GitHub Actions / pipeline status in PPM, trigger builds from UI. |
| **OLED dark mode** | UX | True black background for OLED screens. |
| **Collaborative editing** | Social | Real-time multi-user file editing with CRDT (yjs/automerge). |
| **Custom domain** | Cloud | Map a custom domain to the PPM Cloud tunnel URL, so PPM answers at `code.yourdomain.com`. Named-tunnel-via-`cloudflared login` design is drafted; blocked on the user owning a zone. |

*(Shipped from this backlog: notification hub → cloud push + Telegram; git advanced → stash/rebase/conflicts; cross-platform binaries → `bun build --compile` + `ppm.sh/install`.)*

---

## Release Schedule

| Version | Theme | Key Features | Status |
|---------|-------|-------------|--------|
| **v0.7** | Multi-Account & Mobile | Account management, usage tracking, mobile UX | ✅ Released |
| **v0.8** | Always On | PPM Cloud, auto-start, auto-upgrade, scheduled agents | ✅ Released |
| **v0.9** | Open Platform | Multi-provider, extension architecture, MCP | ✅ Released |
| **v0.10** | Enhanced Workflow | Agent teams, group chat, git workflow | ✅ Released |
| **v0.17–v0.18** | Whole Machine | OS File Explorer, floating windows + PiP, system monitor, Windows parity | ✅ Released (current) |
| **v0.11 (renumbered — open)** | Intelligence | Hooks, internal Skills API, Gemini/Tier-3 providers | Open |
| **v1.0** | Production Ready | Self-hosted Cloud, Marketplace, stability, inline SQL | Q4 2026 |

> The v0.8–v0.11 themes were planned before the version line ran ahead of them. Numbering is kept
> for continuity; the *content* of v0.11 is the only forward-looking table left.

---

## Strategic Principles

1. **Own "phone to code"** — PPM wins on multi-device access. Don't chase Cursor/Windsurf feature parity.
2. **PPM Cloud stays razor-thin** — Device registry + tunnel URLs only. No code storage. No cloud execution.
3. **Multi-provider is tiered** — Claude SDK (Tier 1), Cursor + Codex (Tier 2), Tier 3 chat-only still open. Clean interface for future providers.
4. **Extensions keep core lightweight** — Features are opt-in. Core stays fast.
5. **Self-hosted first, always** — Cloud is optional convenience. PPM works 100% offline/local.
6. **Mobile is not a port** — every feature ships with its touch form (bottom sheet, long-press), not a shrunk desktop layout.

---

## Technical Debt

| Item | Priority | Notes |
|------|----------|-------|
| ~~Refactor ProviderInterface for multi-provider~~ | ~~High~~ | ✅ Done (v0.9.0-beta.5) |
| ~~Windows terminal support~~ | ~~Medium~~ | ✅ Done — `bun-pty` on Windows, Bun native PTY on macOS/Linux, behind one `PtyHandle` interface |
| Simplify ChatService streaming | Medium | Reduce async generator complexity |
| Extract WebSocket common logic | Low | DRY for chat/terminal WS |
| Round-robin cursor bug in AccountSelector | Medium | Positional cursor not advancing correctly |
| Deprecated port-forwarding routes | Low | `/api/preview/tunnel*` superseded by `/api/tunnels`; kept for compatibility, still owns the ghost-cleanup timer |

---

## Dependencies to Monitor

| Dependency | Version | Risk | Notes |
|-----------|---------|------|-------|
| Bun | 1.3.6+ | Medium | Check security advisories weekly |
| Claude Agent SDK | 0.3.251 | Medium | Pinned exactly — follow for API changes, new features |
| React | 19.2.4 | Low | Monitor breaking changes |
| Hono | 4.12.8 | Low | Server + WS |
| Vite | 8.0 | Low | Build + PWA plugin |
| Tailwind | 4.2.1 | Low | v4 engine |
| xterm.js | 6.1.0-beta.285 | Medium | Beta pin — terminal rendering bugs |
| Monaco Editor | 4.7.0+ | Low | Accessibility improvements |
