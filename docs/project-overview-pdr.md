# PPM Project Overview & Product Development Requirements

## Project Description

**PPM** (Personal Project Manager) is a full-stack, mobile-first web IDE designed for developers to manage code projects with AI-powered assistance. It combines a responsive web interface, real-time terminal access, AI chat with tool support, and Git integration into a cohesive development environment.

Built on the **Bun runtime** for performance, PPM enables developers to:
- Browse and edit project files with CodeMirror syntax highlighting
- Execute commands via xterm.js terminal with full PTY support
- Chat with Claude AI with file attachments and slash commands
- View Git status, diffs, and commit graphs in real-time
- Manage multiple projects via a project registry
- Access the IDE from mobile, tablet, or desktop browsers

## Target Users

- **Solo developers** managing multiple code projects
- **Teams** requiring lightweight project collaboration
- **Developers** seeking AI-assisted development workflow
- **Researchers** prototyping with terminal + editor + AI
- **DevOps/SRE** managing infrastructure code with AI guidance

## Key Features

### Core Features (Implemented v2)
- **Project Management** — Create, switch, and manage multiple projects via CLI and web UI
- **File Explorer** — Browse directory trees, create/edit/delete files with path traversal protection
- **Code Editor** — CodeMirror 6 with syntax highlighting, line numbers, theme support (dark/light)
- **Terminal** — Full xterm.js with Bun PTY, resize handling, multiple terminal sessions per project
- **AI Chat** — Streaming Claude messages with tool use (file read/write, git commands), file attachments, slash command detection
- **Git Integration** — Status, diffs, commit graphs, branch management, staging/committing
- **PWA** — Installable web app with offline support
- **Authentication** — Token-based auth with auto-generated tokens in config
- **Multi-Session** — Independent terminal and chat sessions per project tab

### Planned Features (v3+)
- Collaborative editing (WebSocket sync)
- Custom tool registry for AI
- Plugin architecture for providers
- Mobile-optimized git graph
- Performance profiling UI

## Product Decisions & Rationale

### Runtime: Bun v1.3.6+
- **Why:** Native TypeScript support, bundled HTTP server, PTY module, blazing-fast startup
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

### UI Stack: Tailwind + Radix UI + shadcn/ui
- **Why:** Utility-first CSS (Tailwind), accessible components (Radix), pre-built New York style (shadcn)
- **Trade-off:** Larger CSS bundle; mitigated by tree-shaking, critical CSS extraction
- **Impact:** Consistent, accessible, maintainable UI with dark/light theme support

### Editor: CodeMirror 6 + Diff2HTML
- **Why:** Modular, extensible, supports syntax highlighting, merge views, live collaboration
- **Trade-off:** More complex API than Monaco; justified by Bun compatibility and flexibility
- **Impact:** Supports 50+ languages, diffing, real-time file changes

### Terminal: xterm.js + Bun PTY
- **Why:** xterm.js is industry-standard terminal emulator; Bun PTY avoids node-pty complexity
- **Trade-off:** Limited Windows support (PTY); justified by Linux/macOS target
- **Impact:** Full terminal experience, proper signal handling, resize support

### AI Provider: Anthropic Claude Agent SDK
- **Why:** Native async/await streaming, tool use, built-in token tracking, multi-turn context
- **Trade-off:** Anthropic-specific; can swap via provider registry pattern
- **Impact:** Rich conversation capabilities, reliable streaming, tool approval flow

### Database: None (Filesystem-based)
- **Why:** Single-machine design, YAML project registry, stateless server
- **Trade-off:** No persistence across server restarts for chat; mitigated by session IDs in URL
- **Impact:** Zero infrastructure, fast startup, git-friendly config

### Build: Vite 8.0
- **Why:** ESM-native, fast hot reload, TypeScript support, PWA plugin
- **Trade-off:** Requires modern JS support; justified by target audience
- **Impact:** <1s dev refresh, optimized bundles

## Non-Functional Requirements

| Requirement | Target | Implementation |
|---|---|---|
| **Performance** | Page load <2s, terminal <100ms latency | Vite code splitting, streaming APIs |
| **Availability** | 99.9% uptime for local deployments | Stateless server, git-based state |
| **Scalability** | Support 10+ concurrent projects | Stateless, horizontal if needed |
| **Security** | Token-based auth, path traversal protection | Middleware, filename validation |
| **Accessibility** | WCAG 2.1 AA | Radix UI primitives, semantic HTML |
| **Cross-platform** | macOS, Linux, Windows | Bun compatibility + PWA fallback |
| **Mobile** | iOS Safari, Android Chrome | Responsive design, touch-friendly UI |
| **Offline** | Basic file browsing, editor | Service worker caching (PWA) |

## CLI Commands (v2+)

### ppm start
Start the server in **background daemon mode** (default) or foreground. Supports optional public URL sharing via Cloudflare Quick Tunnel.

**Syntax:**
```bash
ppm start [options]
```

**Options:**
- `-p, --port <port>` — Port to listen on (default: from config.yaml)
- `-f, --foreground` — Run in foreground (blocking, shows logs). Default: background daemon.
- `-d, --daemon` — Explicit daemon flag (kept for compatibility, no-op since daemon is default)
- `-s, --share` — Enable public URL sharing via Cloudflare tunnel
- `-c, --config <path>` — Path to config file (default: ~/.ppm/config.yaml)

**Behavior:**
- **Background (default):** Process exits immediately. Daemon runs with output to null. Status saved to `~/.ppm/status.json`. Parent polls for status (up to 30s).
- **Foreground:** Blocks with logs displayed. All WebSocket and tunnel features work normally.
- **--share flag:** Downloads cloudflared binary to `~/.ppm/bin/` if missing (shows progress). Spawns tunnel in separate child. URL extracted from stderr and saved to status.json.
- **Auth warning:** If `--share` is used without auth enabled, warns user that IDE is publicly accessible.

**Example:**
```bash
ppm start --share              # Daemon + tunnel
ppm start --foreground         # Foreground for debugging
ppm start -p 3000 -f           # Custom port + foreground
```

### ppm stop
Stop the background daemon gracefully.

**Syntax:**
```bash
ppm stop
```

**Behavior:**
- Reads `~/.ppm/status.json` (new format) or falls back to `~/.ppm/ppm.pid` (legacy)
- Sends SIGTERM to process
- Cleans up status.json and ppm.pid files
- Tunnel process (if running) killed via signal handler

**Example:**
```bash
ppm stop                       # Stop daemon
```

## Architecture Highlights

```
┌─────────────────────────────────────┐
│         CLI (Commander.js)          │  Start/stop daemon, manage projects
│  ├─ ppm start [--foreground --share]│
│  └─ ppm stop                        │
├─────────────────────────────────────┤
│  Hono Server (Bun.serve + WebSocket)│  REST API, WS for terminal/chat
│  ├─ Tunnel Service (Cloudflare)     │  Optional public URL
│  └─ Daemon Mode (background process)│
├────────────────────┬────────────────┤
│  Services Layer    │  Providers      │  Business logic, AI adapters
├────────────────────┴────────────────┤
│  Filesystem + Git  + Config          │  Project data, auth tokens
├─────────────────────────────────────┤
│   React UI (Vite)                   │  Frontend, installed as PWA
└─────────────────────────────────────┘
```

## Success Metrics

- **Adoption:** 10+ active users, 100+ GitHub stars
- **Performance:** Server startup <500ms, API response <200ms
- **Reliability:** <0.1% error rate in chat/git operations
- **Developer Velocity:** New developers productive in <30 minutes
- **Code Quality:** >80% test coverage, zero security vulnerabilities

## Project Constraints

- **Team Size:** Solo developer (open source, community contributions)
- **Deployment:** Local/single-machine only (no cloud infrastructure required)
- **State:** Stateless server (config stored locally on disk)
- **Compatibility:** Linux/macOS primary, Windows secondary
- **Scope:** Project IDE, not CI/CD platform or cloud collaboration

## Version History

| Version | Status | Focus | Date |
|---------|--------|-------|------|
| **v1** | Complete | Initial prototype (single project, basic chat, terminal) | Feb 2025 |
| **v2** | In Progress | Multi-project, project-scoped APIs, improved UI/UX, daemon mode, --share flag | Mar 2025 |
| **v3** | Planned | Collaborative editing, plugin architecture | Q2 2025 |

### v2 Changes (Mar 2025)
- **Daemon Mode as Default:** `ppm start` now runs background daemon by default. `--foreground/-f` flag for debugging.
- **Public URL Sharing:** `ppm start --share` creates Cloudflare Quick Tunnel public URL. Auto-downloads cloudflared binary.
- **Status File:** `~/.ppm/status.json` (new format) replaces `ppm.pid` with backward compatibility.
- **Auth Warning:** Warns if `--share` used without auth enabled.
- **New Services:** `cloudflared.service.ts` (binary download), `tunnel.service.ts` (tunnel lifecycle).

