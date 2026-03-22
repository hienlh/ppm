# PPM Project Roadmap

**Last Updated:** March 22, 2026

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
| **AI Chat enhancements** | High | Tool allow/deny config per session. Chat modes (plan/code/ask). Model selector (opus/sonnet/haiku). Effort level. Max turns. System prompt customization. Better streaming UX (collapsible tool calls). |

**PPM Cloud — scope guard:**
- Cloud is OPTIONAL convenience, never a dependency. PPM works 100% without it.
- Razor-thin: device registry + tunnel URL sync + heartbeat. Nothing more.
- Hosting: Cloudflare Workers or Fly.io
- CLI: `ppm cloud link`, `ppm cloud unlink`, `ppm cloud status`
- Dashboard: list machines, status (online/offline), click to open

---

### v0.9.0 — "Open Platform" (Q2–Q3 2026)

**Theme:** Multi-provider AI + extension system. Expand user base beyond Claude-only developers.

| Feature | Priority | Description |
|---------|----------|-------------|
| **Multi-provider AI** | Critical | Refactor `ProviderInterface` for clean provider abstraction. Tiered support: Tier 1 (full agentic) = Claude Agent SDK; Tier 2 (chat + tools) = Gemini CLI, OpenAI Codex; Tier 3 (chat-only) = any OpenAI-compatible API. Clean base code for future Chinese providers (DeepSeek, Qwen). |
| **Extension architecture** | High | Dynamic extension loading system. Extensions = npm packages exporting skills + optional UI panels. First extension: extract DB viewer from core. Extension API: register routes, UI panels, sidebar tabs, skills. Config: `"extensions": ["@ppm/ext-database", "@ppm/ext-docker"]`. |
| **MCP Management** | Medium | UI to add/remove/configure MCP servers. Test connection. Per-project MCP overrides. Store in SQLite. Pass to Agent SDK via `mcpServers`. |

**Multi-provider — tiered approach:**
- Tier 1 (full agentic): Claude Agent SDK — file edit, terminal, git, full autonomy
- Tier 2 (chat + tools): Provider-specific CLIs (Gemini CLI, Codex) — agentic via their own tool system
- Tier 3 (chat-only): Any OpenAI-compatible API — conversation only, no tools
- Provider interface refactor is foundation work — do it clean now, avoid painful refactor later

**Extension architecture — design principles:**
- Extensions are npm packages: `ppm ext install @ppm/ext-database`
- Extension manifest defines: skills, UI panels, sidebar tabs, routes, settings schema
- DB viewer = first official extension, proves the architecture
- Keep PPM core lightweight, features are opt-in via extensions
- No marketplace yet (just npm), marketplace comes in v1.0

---

### v0.10.0 — "Intelligence" (Q3 2026)

**Theme:** PPM's own AI layer. Built-in bot + programmable skills.

| Feature | Priority | Description |
|---------|----------|-------------|
| **PPM Skills API** | High | Stable internal API for AI to control PPM: file.read/write/search, terminal.run, git.status/commit/diff, db.query, editor.open/goto, project.switch. Skills are the bridge between AI and PPM features. |
| **Built-in Clawbot** | High | Lightweight AI agent built into PPM using Anthropic Messages API (not Agent SDK). Uses Skills API + MCP tools. Instant response, no external CLI deps. For quick tasks: file search, code explanation, simple refactors. |
| **Inline SQL** | Medium | Select text in Monaco → run as SQL. Connection picker in editor context menu. Results panel below editor. Leverages existing DB service. |

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

---

## Release Schedule

| Version | Theme | Key Features | Target |
|---------|-------|-------------|--------|
| **v0.7** | Multi-Account & Mobile | Account management, usage tracking, mobile UX | ✅ Current |
| **v0.8** | Always On | PPM Cloud, auto-start, AI chat enhancements | Q2 2026 |
| **v0.9** | Open Platform | Multi-provider AI, extension architecture, MCP | Q2–Q3 2026 |
| **v0.10** | Intelligence | Skills API, built-in Clawbot, inline SQL | Q3 2026 |
| **v1.0** | Production Ready | Self-hosted Cloud, Marketplace, stability | Q4 2026 |

---

## Strategic Principles

1. **Own "phone to code"** — PPM wins on multi-device access. Don't chase Cursor/Windsurf feature parity.
2. **PPM Cloud stays razor-thin** — Device registry + tunnel URLs only. No code storage. No cloud execution.
3. **Multi-provider is tiered** — Full agentic = Claude SDK. Other providers get appropriate tier. Clean interface for future providers.
4. **Extensions keep core lightweight** — Features are opt-in. DB viewer, future tools = extensions. Core stays fast.
5. **Clawbot enables the ecosystem** — Users create extensions with AI, publish to Marketplace. Zero-friction.
6. **Self-hosted first, always** — Cloud is optional convenience. PPM works 100% offline/local.

---

## Technical Debt

| Item | Priority | Notes |
|------|----------|-------|
| Refactor ProviderInterface for multi-provider | High | Foundation for v0.9 |
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
