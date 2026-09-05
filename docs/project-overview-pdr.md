# PPM Project Overview & Product Development Requirements

## Project Description

**PPM** (Personal Project Manager) is a full-stack, mobile-first web IDE designed for developers to manage code projects with AI-powered assistance. It combines a responsive web interface, real-time terminal access, AI chat with tool support, Git integration, database tooling and whole-machine file/process management into a cohesive development environment reachable from any browser.

Built on the **Bun runtime** for performance, PPM enables developers to:
- Browse and edit project files with Monaco Editor syntax highlighting, plus viewers for images, PDF, CSV and video
- Execute commands via xterm.js terminal with full PTY support on macOS, Linux and Windows
- Chat with multiple AI agents (Claude Agent SDK, OpenAI Codex, Cursor CLI) with file attachments, slash commands, skills, subagents and agent teams
- View Git status, diffs, and commit graphs in real-time, and resolve conflicts inline
- Query SQLite and PostgreSQL databases with an audit trail
- Browse the whole host filesystem and monitor every process on the machine
- Manage multiple projects via a project registry
- Access the IDE from mobile, tablet, or desktop browsers — including through a Cloudflare tunnel

## Target Users

- **Solo developers** managing multiple code projects
- **Teams** requiring lightweight project collaboration
- **Developers** seeking AI-assisted development workflow
- **Researchers** prototyping with terminal + editor + AI
- **DevOps/SRE** managing infrastructure code with AI guidance

## Key Features

For the user-facing feature list, see the [README](../README.md). For per-release detail, see
[`CHANGELOG.md`](../CHANGELOG.md). This section records only what the product *is committed to*.

### Implemented

**AI**
- Chat with streaming, tool use, file attachments, session history/search/branching, drafts, and durable replayable turns (an unmounted tab never loses output)
- Multi-provider registry — Claude Agent SDK built in; Cursor CLI and OpenAI Codex register when their binaries are present; provider, model, reasoning effort and permission mode are per-session
- Slash commands, skills and plugin items discovered from the user's `~/.claude` directory
- Agent teams (live member activity, session replay) and multi-agent group chat
- MCP server management, with auto-import from `~/.claude.json`
- Scheduled agents — cron jobs that wake a session to work unattended, with budgets and notifications
- Multi-account credential storage with rotation and usage tracking
- Anthropic- and OpenAI-compatible API proxy over the stored accounts, with its own auth key and request log

**Workspace**
- Project registry, project-scoped API, keep-alive workspace switching
- File explorer with upload (progress, collision prompts), download, and drag-and-drop
- OS File Explorer — a floating window browsing the whole host filesystem, with OS-native chrome, three view modes and full file actions
- Monaco editor with diff viewer and inline merge-conflict resolution
- Terminal — multiple PTY sessions per project plus a dock terminal on any folder
- Git — status, diff, stage, commit, push/pull, branches, merge, rebase, stash, worktrees, commit graph
- SQLite + PostgreSQL viewer with query editor, cell editing and a query audit log
- System Monitor — CPU/RAM/disk/network/GPU charts and per-app process control
- Floating windows, tab pop-out and Document Picture-in-Picture
- VSCode-compatible extension system running in isolated Bun workers

**Platform**
- Token-based auth, path-traversal protection, PPM-directory shield, single-use download tokens
- Supervisor with auto-restart, auto-upgrade and OS autostart registration
- Cloudflare tunnel for public access, plus per-port forwarding tunnels
- Optional PPM Cloud device registry; Telegram bot; Jira watchers; cloud push notifications
- Themes including VSCode theme import; command palette; PWA

### Not yet built (see [roadmap](project-roadmap.md))
- Lifecycle hooks system, and a stable *internal* AI-facing Skills API
- Gemini CLI / Tier-3 OpenAI-compatible providers as *consumers*
- Interactive-rebase UI, merge-strategy selection, cherry-pick UI (the REST route exists)
- Inline SQL in the editor, extension marketplace, self-hosted PPM Cloud
- Collaborative editing

## Product Decisions & Rationale

### Runtime: Bun v1.3.6+
- **Why:** Native TypeScript support, bundled HTTP server, PTY module, blazing-fast startup, `bun build --compile` for dependency-free binaries
- **Trade-off:** Smaller ecosystem vs Deno/Node; mitigated by npm compatibility
- **Impact:** Simplified tooling, single binary deployment

### Framework: Hono 4.12.8
- **Why:** Lightweight, Bun-compatible, edge-first HTTP framework, minimal overhead
- **Trade-off:** Less middleware ecosystem than Express; sufficient for needs
- **Impact:** Single-file server setup, WebSocket support built-in

### Frontend: React 19.2.4 + Zustand 5.0
- **Why:** React for component reusability, Zustand for simple state management (no Redux boilerplate)
- **Trade-off:** Client-side routing vs server-side; mitigated by URL sync hook
- **Impact:** Fast, responsive UI with minimal store complexity

### UI Stack: Tailwind 4 + Radix UI + shadcn/ui
- **Why:** Utility-first CSS (Tailwind), accessible components (Radix), pre-built New York style (shadcn)
- **Trade-off:** Larger CSS bundle; mitigated by tree-shaking, critical CSS extraction
- **Impact:** Consistent, accessible, maintainable UI with theming and dark/light support

### Editor: Monaco Editor (@monaco-editor/react)
- **Why:** Superior IntelliSense, syntax highlighting, built-in diff viewer, industry-standard code editor
- **Trade-off:** Larger bundle size; justified by feature richness and developer experience
- **Impact:** 50+ languages, IntelliSense, word wrap toggle (Alt+Z), Monaco diff viewer, conflict editor

### Terminal: xterm.js + PTY (Bun native / bun-pty)
- **Why:** xterm.js is the industry-standard terminal emulator; Bun's native PTY avoids node-pty build complexity on macOS/Linux
- **Trade-off:** Bun's PTY does not cover Windows, so a second backend (`bun-pty`) is needed there; both sit behind one `PtyHandle` interface in `terminal.service.ts`
- **Impact:** Full terminal experience with proper signal handling and resize on all three platforms

### AI: provider registry over a single vendor
- **Why:** The Claude Agent SDK gives native streaming, tool use, token tracking and multi-turn context; a registry in front of it keeps PPM from being welded to one vendor
- **Trade-off:** Every provider must be mapped onto one event shape, so provider-specific niceties are levelled down
- **Impact:** Claude (Tier 1, full agentic), Cursor and Codex (Tier 2, agentic CLIs) coexist; CLI providers are registered only when their binary is found, so a missing binary degrades to "provider absent", never an error

### Database: SQLite (`bun:sqlite`)
- **Why:** Richer persistence for config, sessions, accounts, usage, schedules, audit logs; single-file DB suits the single-machine design
- **Trade-off:** Added dependency; mitigated by Bun's built-in SQLite support
- **Impact:** All config lives in `~/.ppm/ppm.db` (dev uses `ppm.dev.db`); the YAML config path is fully retired. Access the directory through `getPpmDir()`, never a hand-built `~/.ppm` path, so tests can redirect via `PPM_HOME`

### Build: Vite 8.0
- **Why:** ESM-native, fast hot reload, TypeScript support, PWA plugin
- **Trade-off:** Requires modern JS support; justified by target audience
- **Impact:** <1s dev refresh, optimized bundles

### Notifications: cloud push, not local Web Push
- **Why:** Local Web Push needs a stable public origin and per-browser subscription bookkeeping; a machine behind a rotating quick-tunnel has neither
- **Trade-off:** Push requires the optional PPM Cloud link; Telegram covers the un-linked case
- **Impact:** One dispatch path in `notification.service.ts` fans out to both channels, but they are gated differently: cloud push always fires, while Telegram fires **only when no browser client is connected** — so an active user is not double-notified

## Non-Functional Requirements

| Requirement | Target | Implementation |
|---|---|---|
| **Performance** | Page load <2s, terminal <100ms latency | Vite code splitting, streaming APIs |
| **Availability** | Survives crash, logout and reboot | Supervisor + OS autostart, soft-stop state |
| **Scalability** | Support 10+ concurrent projects | Per-project session registries, lazy tabs |
| **Security** | Token auth on HTTP *and* WebSocket, path-traversal protection, PPM-dir shield, single-use download tokens, secret redaction in logs | Middleware, `fs-path-guard.service.ts`, `redact-secrets.ts` |
| **Accessibility** | WCAG 2.1 AA | Radix UI primitives, semantic HTML |
| **Cross-platform** | macOS, Linux, Windows | Bun + per-OS providers for PTY, metrics, host info, autostart |
| **Mobile** | iOS Safari, Android Chrome | Responsive design, bottom sheets, long-press menus, 44px touch targets |
| **Offline** | Basic file browsing, editor | Service worker caching (PWA) |
| **Resource safety** | No unbounded watches or spawns | Pruned watch tree (never recursive on a project root), one long-lived metrics collector, bounded transcode slots |

## CLI

The command surface is defined in `src/index.ts` and `src/cli/commands/*.ts` — that Commander tree is
the single source of truth and is what `scripts/generate-ppm-skill.ts` introspects to generate the
exported skill. The [README](../README.md#cli) lists the commands for humans.

Two behaviours worth stating here because they are product decisions, not implementation detail:

### ppm start
Starts the server as a **background daemon** under a supervisor, and always brings up a Cloudflare
Quick Tunnel. There is no foreground flag: the daemon is the only mode. The command blocks until the
tunnel URL is known (up to 35s), prints `➜  Local` / `➜  Share` plus a QR code, and exits 0. Scripts
read the URL back from `ppm status --json` → `shareUrl`.

- Options: `-p/--port`, `--profile <name>` (DB profile, e.g. `dev` → `ppm.dev.db`), `-s/--share` (deprecated no-op — the tunnel is always on)
- If no config exists, the setup wizard runs first
- If auth is disabled while the tunnel is up, it warns that the IDE is publicly reachable
- On first start it also registers OS autostart, so PPM survives a terminal close and a reboot

### ppm stop / ppm down
`stop` shuts the server down but **leaves the supervisor alive** — the tunnel URL and Cloud link
survive, and `ppm start` resumes without a new supervisor. `down` (or `stop --kill`) is the full
shutdown. This split exists so a restart does not rotate the public URL.

## Architecture Highlights

```
┌─────────────────────────────────────┐
│         CLI (Commander.js)          │  Daemon control, projects, git, db,
│                                     │  chat, schedules, extensions, cloud
├─────────────────────────────────────┤
│  Supervisor (own process)           │  Restart, upgrade, soft-stop state
├─────────────────────────────────────┤
│  Hono Server (Bun.serve + WebSocket)│  REST API, WS for chat/terminal/global
│  ├─ Tunnel Service (Cloudflare)     │  Always-on public URL + port forwarding
│  └─ Extension Host (Bun Workers)    │  Isolated VSCode-compatible extensions
├────────────────────┬────────────────┤
│  Services Layer    │  Provider       │  Business logic │ Claude / Codex /
│                    │  Registry       │                 │ Cursor adapters
├────────────────────┴────────────────┤
│  SQLite (~/.ppm/ppm.db) + Filesystem + Git             │
├─────────────────────────────────────┤
│   React UI (Vite)                   │  Tabs, floating windows, PWA
└─────────────────────────────────────┘
```

See [`system-architecture.md`](system-architecture.md) for layers, protocols and data flows.

## Success Metrics

- **Adoption:** 10+ active users, 100+ GitHub stars
- **Performance:** Server startup <500ms, API response <200ms
- **Reliability:** <0.1% error rate in chat/git operations
- **Developer Velocity:** New developers productive in <30 minutes
- **Code Quality:** >80% test coverage, zero security vulnerabilities

## Project Constraints

- **Team Size:** Solo developer (open source, community contributions)
- **Deployment:** Local/single-machine only (no cloud infrastructure required)
- **State:** All state on the local machine — PPM Cloud never receives code or chats
- **Compatibility:** macOS, Linux and Windows are all supported targets
- **Scope:** Project IDE, not a CI/CD platform or a cloud collaboration service

## Version History

| Version | Status | Focus | Date |
|---------|--------|-------|------|
| **v1** | Complete | Initial prototype (single project, basic chat, terminal) | Feb 2025 |
| **v2** | Complete (v0.5.21) | Multi-project, Monaco Editor, auto-title sessions, daemon mode, Cloudflare tunnel, SQLite migration | Mar 2026 |
| **v0.7** | Complete | Multi-account credentials, usage tracking, mobile UX | — |
| **v0.8** | Complete | PPM Cloud, autostart, auto-upgrade, supervisor, scheduled agents | — |
| **v0.9** | Complete | Multi-provider AI, MCP management, extension architecture | — |
| **v0.10** | Complete | Agent teams, group chat, git workflow depth | — |
| **v0.17–v0.18** | Complete (current) | OS File Explorer, floating windows + PiP, whole-machine system monitor, Windows parity | Sep 2026 |

Per-release detail lives in [`CHANGELOG.md`](../CHANGELOG.md); forward-looking scope lives in
[`project-roadmap.md`](project-roadmap.md).
