# PPM Project Roadmap

**Last Updated:** March 27, 2026

## Vision

PPM is the **lightest path from phone to code** — a self-hosted, BYOK, multi-device web IDE with AI. No desktop app install needed. No subscription. Everything on your machine, accessible from any browser.

---

## Completed Milestones

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

### v0.7 — Multi-Account & Mobile (Current — v0.7.25)
- Multi-account credential management (OAuth + API key)
- Account routing (round-robin, fill-first)
- Usage tracking per account with visual dashboard
- Account import/export with encryption + clipboard fallback
- Mobile UX: horizontal tab scroll, long-press context menus, touch optimization
- Cloudflare tunnel, push notifications, Telegram alerts

---

## Upcoming Roadmap

### v0.8.0 — "Always On" (Q2 2026)

**Theme:** Multi-device access + AI chat improvements. Solve the "I can't reach my PPM from my phone" problem.

| Feature | Priority | Description |
|---------|----------|-------------|
| **PPM Cloud** | Critical | Separate cloud service for device registry + tunnel URL sync. Google OAuth login. CLI `ppm cloud link` syncs tunnel URL. Open cloud dashboard on any device → see machines → tap to connect. NO code/data through cloud — only URLs + metadata. |
| **Auto-start** | High | PPM starts on boot. macOS launchd, Linux systemd, Windows Task Scheduler. CLI: `ppm autostart enable/disable`. Required for "always accessible" story. |
| **Auto-upgrade** | High | Supervisor checks npm registry every 15min. UI banner shows when update available. One-click upgrade via API or CLI. Supervisor self-replaces after install (no OS autostart dependency). ✅ **Completed in v0.8.54** |
| **AI Chat enhancements** | High | Tool allow/deny config per session. Chat modes (plan/code/ask). Model selector (opus/sonnet/haiku). Effort level. Max turns. System prompt customization. Better streaming UX (collapsible tool calls). |

**PPM Cloud — scope guard:**
- Cloud is OPTIONAL convenience, never a dependency. PPM works 100% without it.
- Razor-thin: device registry + tunnel URL sync + heartbeat. Nothing more.
- Hosting: Cloudflare Workers or Fly.io
- CLI: `ppm cloud link`, `ppm cloud unlink`, `ppm cloud status`
- Dashboard: list machines, status (online/offline), click to open

---

### v0.9.0 — "Open Platform" (Q2–Q3 2026)

**Theme:** Multi-provider AI (Claude + Cursor) + extension system. Ship a focused release, expand providers later.

**Overall progress: 100%** (All 3 core features complete)

| Feature | Priority | Status | Description |
|---------|----------|--------|-------------|
| **Multi-provider AI** | Critical | ✅ Done | ProviderInterface, registry, Cursor CLI, CLI provider base, UI provider/model selector, permission mode selector, system prompt customization, comprehensive tests — all on beta branch. |
| **MCP Management** | Medium | ✅ Done | REST API (CRUD + import), SQLite storage, Settings UI, auto-import from `~/.claude.json`, validation, SDK integration. |
| **Extension architecture (Phase 1-6)** | High | ✅ Done | VSCode-compatible npm extensions, Bun Worker isolation, RPC protocol, state persistence, contribution registry, CLI support, dev mode. @ppm/vscode-compat API shim (commands, window, workspace). UI components (StatusBar, TreeView, WebviewPanel, QuickPick, InputBox). WS bridge for real-time ext↔browser communication. First extension: ext-database with tree view + SQL query panel. Unit tests + extension dev guide. |

**v0.9.x polish (post-release):**
- File download feature (v0.9.2) — Single-file + folder-as-zip downloads with short-lived tokens, context menu + toolbar UI

**Multi-provider — v0.9 scope (reduced):**
- Tier 1 (full agentic): Claude Agent SDK — file edit, terminal, git, full autonomy
- Tier 2 (agentic CLI): Cursor — agentic via its own tool system
- Provider interface is clean enough to add more providers later without refactor

**Deferred to v0.9.5+ (Multi-Provider Phase 2):**
- Gemini CLI (Tier 2)
- OpenAI Codex (Tier 2)
- Tier 3 (chat-only): Any OpenAI-compatible API
- Chinese providers (DeepSeek, Qwen) — v1.0+

**Extension System — remaining for v0.10+:**
- Settings UI auto-generation from manifest
- Hot reload during dev (`ppm ext dev --watch`)
- Extension template scaffold (`ppm ext create <name>`)
- Extension marketplace (v1.0)

**Extension architecture — design principles:**
- Extensions are npm packages: `ppm ext install @ppm/ext-database`
- Extension manifest defines: skills, UI panels, sidebar tabs, routes, settings schema
- DB viewer = first official extension, proves the architecture
- Keep PPM core lightweight, features are opt-in via extensions
- No marketplace yet (just npm), marketplace comes in v1.0

---

### v0.10.0 — "Enhanced Workflow" (Q3 2026)

**Theme:** Agent collaboration + git workflow. High-impact, independent features that ship fast.

| Feature | Priority | Description |
|---------|----------|-------------|
| **Agent Team** | High | Multi-agent collaboration within PPM. Spawn agent teams for parallel task execution — lead agent delegates to specialist agents (coder, tester, reviewer). Task coordination, file ownership, progress tracking. |
| **Worktree management** | Medium | UI to create/switch/delete git worktrees. Use different providers on different branches. Integrated with project switcher. |

---

### v0.11.0 — "Intelligence" (Q3–Q4 2026)

**Theme:** Event system + PPM's own AI layer. Hooks → Skills API → Clawbot dependency chain.

| Feature | Priority | Description |
|---------|----------|-------------|
| **Hooks system** | High | Event hooks for PPM lifecycle (file save, git commit, chat message, etc.). Foundation for Skills API and deeper extension integration. |
| **PPM Skills API** | High | Stable internal API for AI to control PPM: file.read/write/search, terminal.run, git.status/commit/diff, db.query, editor.open/goto, project.switch. Skills are the bridge between AI and PPM features. |
| **Built-in Clawbot** | High | Lightweight AI agent built into PPM using Anthropic Messages API (not Agent SDK). Uses Skills API + MCP tools. Instant response, no external CLI deps. For quick tasks: file search, code explanation, simple refactors. |
| **More providers** | Medium | Gemini CLI (Tier 2), OpenAI Codex (Tier 2), Tier 3 chat-only (any OpenAI-compatible API). Provider interface already clean from v0.9. |

**Built-in Clawbot — why it matters:**
- Claude Agent SDK spawns subprocess — heavy, slow startup, requires CLI installed
- Clawbot = instant, lightweight, works with any LLM via Messages API
- Users can use Clawbot to create extensions → zero-friction extension authoring
- Foundation for "AI creates extensions on demand" vision

---

### v1.0.0 — "Production Ready" (Q4 2026)

**Theme:** Enterprise, marketplace, stability.

| Feature | Priority | Description |
|---------|----------|-------------|
| **Self-hosted PPM Cloud** | High | Docker image of PPM Cloud for enterprise/team. Same codebase, self-hosted config flag. `docker-compose up` and it works. LDAP/SSO integration. |
| **PPM Marketplace** | High | Publish/install/update extensions. Browse community extensions. Revenue sharing for paid extensions. Clawbot can create extension → test → publish in minutes. |
| **Stability & hardening** | Critical | Security audit, performance optimization, comprehensive test coverage (>80%), documentation for contributors, CI/CD pipeline. |
| **Inline SQL** | Medium | Select text in Monaco → run as SQL. Connection picker in editor context menu. Results panel below editor. Leverages existing DB service. |

---

## Post-v1.0 — Feature Backlog (To Be Prioritized)

Features to pick from after v1.0. Will be reviewed and scheduled based on user feedback and strategic priorities.

| Feature | Category | Description |
|---------|----------|-------------|
| **Collaborative viewing** | Social | Read-only live session sharing via tunnel. Others watch terminal/editor real-time. High demo value. |
| **Workspace snapshots** | UX | Save/restore full state (open files, terminals, chat). Critical for mobile where browser kills tabs. |
| **Ollama / local models** | AI | Run AI offline with local models. No API cost, privacy-first. Plugs into Clawbot as a provider. |
| **Project templates** | DX | `ppm init --template react/nest/go`. Community templates from Marketplace. |
| **AI command palette** | AI | Natural language commands ("deploy production", "run tests") → Skills API. |
| **Notification hub** | UX | Push notification "AI task finished" on mobile. Webhook integrations (Slack, Discord). |
| **Layout customization** | UX | User arranges panels freely. Save separate desktop vs mobile layouts. |
| **Git advanced** | Git | Interactive rebase UI, cherry-pick, stash management, conflict resolution. |
| **Performance profiling** | DevTools | Flamegraph viewer, memory tracking, network waterfall. |
| **Multi-user workspace** | Enterprise | Shared project access, role-based permissions, team features. |
| **Mobile terminal UX** | Mobile | Virtual keyboard shortcuts, gesture controls, better touch input. |
| **CI/CD integration** | DevOps | GitHub Actions / pipeline status in PPM, trigger builds from UI. |
| **Cross-platform binaries** | Distribution | Compile macOS/Linux/Windows binaries via `bun build --compile`. `npx ppm` without Bun. |
| **OLED dark mode** | UX | True black background for OLED screens. |
| **Collaborative editing** | Social | Real-time multi-user file editing with CRDT (yjs/automerge). |
| **Custom domain** | Cloud | Map custom domain to PPM Cloud tunnel URL. DNS CNAME + SSL via Let's Encrypt or Cloudflare. Access PPM at `code.yourdomain.com`. |

---

## Release Schedule

| Version | Theme | Key Features | Target |
|---------|-------|-------------|--------|
| **v0.7** | Multi-Account & Mobile | Account management, usage tracking, mobile UX | ✅ Current |
| **v0.8** | Always On | PPM Cloud, auto-start, AI chat enhancements | Q2 2026 |
| **v0.9** | Open Platform | Multi-provider (Claude + Cursor), extension architecture, MCP | Q2–Q3 2026 |
| **v0.10** | Enhanced Workflow | Agent Team, worktree management | Q3 2026 |
| **v0.11** | Intelligence | Hooks, Skills API, Clawbot, more providers (Gemini/Codex/Tier 3) | Q3–Q4 2026 |
| **v1.0** | Production Ready | Self-hosted Cloud, Marketplace, stability, inline SQL | Q4 2026 |

---

## Strategic Principles

1. **Own "phone to code"** — PPM wins on multi-device access. Don't chase Cursor/Windsurf feature parity.
2. **PPM Cloud stays razor-thin** — Device registry + tunnel URLs only. No code storage. No cloud execution.
3. **Multi-provider is tiered** — v0.9: Claude SDK (Tier 1) + Cursor (Tier 2). v0.11: Gemini, Codex, Tier 3. Clean interface for future providers.
4. **Extensions keep core lightweight** — Features are opt-in. DB viewer, future tools = extensions. Core stays fast.
5. **Clawbot enables the ecosystem** — Users create extensions with AI, publish to Marketplace. Zero-friction.
6. **Self-hosted first, always** — Cloud is optional convenience. PPM works 100% offline/local.

---

## Technical Debt

| Item | Priority | Notes |
|------|----------|-------|
| ~~Refactor ProviderInterface for multi-provider~~ | ~~High~~ | ✅ Done on beta branch (v0.9.0-beta.5) |
| Simplify ChatService streaming | Medium | Reduce async generator complexity |
| Extract WebSocket common logic | Low | DRY for chat/terminal WS |
| Round-robin cursor bug in AccountSelector | Medium | Positional cursor not advancing correctly |
| Windows terminal support | Medium | Evaluate node-pty or WSL fallback |

---

## Dependencies to Monitor

| Dependency | Version | Risk | Notes |
|-----------|---------|------|-------|
| Bun | 1.3.6+ | Medium | Check security advisories weekly |
| Claude Agent SDK | 0.2.76+ | Medium | Follow for API changes, new features |
| React | 19.2.4 | Low | Monitor breaking changes |
| TypeScript | 5.9.3+ | Low | Quarterly upgrades |
| xterm.js | 6.0 | Low | Terminal rendering bugs |
| Monaco Editor | 4.7.0+ | Low | Accessibility improvements |
