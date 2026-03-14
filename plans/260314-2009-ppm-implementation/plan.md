---
status: pending
created: 2026-03-14
updated: 2026-03-14
slug: ppm-implementation
version: 2
---

# PPM Implementation Plan (v2)

## Overview

Build PPM (Personal Project Manager) — mobile-first web IDE running as CLI daemon.
Tech: Bun + Hono (backend), React 19 + Vite + Tailwind + shadcn/ui (frontend).

## Context

- [Final Tech Stack](../reports/brainstorm-260314-1938-final-techstack.md)
- [Tech Stack Research](../reports/research-260314-1911-ppm-tech-stack.md)
- [Claude Code Integration Research](../reports/research-260314-1930-claude-code-integration.md)

## V1 Lessons (MUST follow)

These were bugs/issues found during v1 browser E2E testing. V2 must build them in from the start:

1. **API envelope auto-unwrap:** `api-client.get<T>()` returns `T` directly, not `{ok, data: T}`. Backend wraps in `{ok, data}`, client unwraps.
2. **Project resolution by NAME:** All API routes accept project name (e.g. "ppm"), not filesystem path. Use `resolveProjectPath(name)` helper in every route.
3. **Terminal: no node-pty:** Use `Bun.spawn()` with raw pipes instead of node-pty. node-pty crashes Bun process via `posix_spawnp`. Wrap all PTY operations in try-catch.
4. **Git log: use simple-git built-in:** Don't parse `git log --format` manually. Use `simple-git`'s `.log()` method which handles parsing correctly.
5. **Metadata on all tab openers:** Both tab-bar AND mobile-nav must pass `{ projectName }` metadata when opening git/file tabs.
6. **Mobile sidebar = overlay drawer:** Don't use `hidden md:flex`. Use absolute positioned overlay with backdrop that slides in on hamburger click.

## Team

| Agent | Role | File Ownership |
|---|---|---|
| **Lead** (main) | Coordinator, shared types, config files | `src/types/**`, `package.json`, configs, `CLAUDE.md` |
| **backend-dev** | Server, CLI, services | `src/cli/**`, `src/server/**`, `src/services/**`, `src/providers/**` |
| **frontend-dev** | React UI, all components | `src/web/**`, `public/**`, `index.html` |
| **tester** | Unit + integration tests | `tests/**`, `*.test.ts` (read-only on src) |

## Phases

| # | Phase | Owner | Depends | Status |
|---|---|---|---|---|
| 1 | [Project Skeleton + Shared Types](phase-01-project-skeleton.md) | Lead | — | pending |
| 2 | [Backend Core (Server + CLI + Config)](phase-02-backend-core.md) | backend-dev | 1 | pending |
| 3 | [Frontend Shell (Tab System + Layout)](phase-03-frontend-shell.md) | frontend-dev | 1 | pending |
| 4 | [File Explorer + Editor](phase-04-file-explorer-editor.md) | backend-dev + frontend-dev | 2, 3 | pending |
| 5 | [Web Terminal](phase-05-web-terminal.md) | backend-dev + frontend-dev | 2, 3 | pending |
| 6 | [Git Integration](phase-06-git-integration.md) | backend-dev + frontend-dev | 4 | pending |
| 7 | [AI Chat](phase-07-ai-chat.md) | backend-dev + frontend-dev | 2, 3 | pending |
| 8 | [CLI Commands](phase-08-cli-commands.md) | backend-dev | 2, 6, 7 | pending |
| 9 | [PWA + Build + Deploy](phase-09-pwa-build-deploy.md) | Lead | all | pending |
| 10 | [Testing](phase-10-testing.md) | tester | per phase | pending |

## Parallel Execution Map

```
Phase 1 (Lead)
    ├── Phase 2 (backend-dev) ──┐
    │                           ├── Phase 4 (parallel) ──┐
    ├── Phase 3 (frontend-dev) ─┘                        ├── Phase 6 (parallel)
    │                                                     │
    ├── Phase 5 (parallel, after 2+3)                    │
    │                                                     │
    ├── Phase 7 (parallel, after 2+3)                    │
    │                                                     │
    └── Phase 8 (backend-dev, after 2+6+7) ──────────────┘
                                                          │
                                                     Phase 9 (Lead)
                                                          │
                                                     Phase 10 (tester, continuous)
```

## Project Structure

```
ppm/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── vite.config.ts
├── ppm.example.yaml
├── .env.example
├── LICENSE (MIT)
├── README.md
├── CLAUDE.md
├── src/
│   ├── index.ts                    # Entry point (CLI)
│   ├── types/
│   │   ├── config.ts               # Config types
│   │   ├── project.ts              # Project types
│   │   ├── git.ts                  # Git types (commit, branch, graph)
│   │   ├── chat.ts                 # Chat/AI types (ChatEvent, AIProvider)
│   │   ├── terminal.ts             # Terminal session types
│   │   └── api.ts                  # API request/response types
│   ├── cli/
│   │   ├── index.ts                # Commander.js setup
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── start.ts
│   │   │   ├── stop.ts
│   │   │   ├── open.ts
│   │   │   ├── projects.ts
│   │   │   ├── config.ts
│   │   │   ├── git.ts
│   │   │   └── chat.ts
│   │   └── utils/
│   │       └── project-resolver.ts # CWD auto-detect + -p flag
│   ├── server/
│   │   ├── index.ts                # Hono app + Bun.serve + WS upgrade
│   │   ├── middleware/
│   │   │   └── auth.ts             # Token auth middleware
│   │   ├── routes/
│   │   │   ├── projects.ts
│   │   │   ├── files.ts
│   │   │   ├── git.ts
│   │   │   └── static.ts          # Serve embedded SPA
│   │   ├── ws/
│   │   │   ├── terminal.ts         # WS /ws/terminal/:id
│   │   │   └── chat.ts             # WS /ws/chat/:id
│   │   └── helpers/
│   │       └── resolve-project.ts  # Shared: name → path resolver
│   ├── services/
│   │   ├── config.service.ts
│   │   ├── project.service.ts
│   │   ├── file.service.ts
│   │   ├── git.service.ts
│   │   ├── terminal.service.ts     # Uses Bun.spawn (NOT node-pty)
│   │   └── chat.service.ts
│   ├── providers/
│   │   ├── provider.interface.ts
│   │   ├── claude-agent-sdk.ts
│   │   ├── cli-subprocess.ts       # Future generic CLI provider
│   │   └── registry.ts
│   └── web/                        # React SPA (Vite)
│       ├── index.html
│       ├── main.tsx
│       ├── app.tsx
│       ├── vite-env.d.ts
│       ├── components/
│       │   ├── layout/
│       │   │   ├── tab-bar.tsx
│       │   │   ├── tab-content.tsx
│       │   │   ├── sidebar.tsx          # Desktop sidebar
│       │   │   ├── mobile-drawer.tsx    # Mobile overlay sidebar
│       │   │   └── mobile-nav.tsx
│       │   ├── projects/
│       │   │   ├── project-list.tsx
│       │   │   └── project-card.tsx
│       │   ├── explorer/
│       │   │   ├── file-tree.tsx
│       │   │   └── file-actions.tsx
│       │   ├── editor/
│       │   │   ├── code-editor.tsx
│       │   │   └── diff-viewer.tsx
│       │   ├── terminal/
│       │   │   └── terminal-tab.tsx
│       │   ├── chat/
│       │   │   ├── chat-tab.tsx
│       │   │   ├── message-list.tsx
│       │   │   ├── message-input.tsx
│       │   │   ├── tool-approval.tsx
│       │   │   └── session-picker.tsx
│       │   ├── git/
│       │   │   ├── git-graph.tsx
│       │   │   ├── git-graph-renderer.tsx
│       │   │   ├── git-status-panel.tsx
│       │   │   ├── git-diff-tab.tsx
│       │   │   └── commit-context-menu.tsx
│       │   └── ui/                 # shadcn/ui components
│       │       └── ...
│       ├── stores/
│       │   ├── tab.store.ts
│       │   ├── project.store.ts
│       │   └── settings.store.ts
│       ├── hooks/
│       │   ├── use-websocket.ts
│       │   ├── use-terminal.ts
│       │   └── use-chat.ts
│       ├── lib/
│       │   ├── api-client.ts       # Auto-unwraps {ok, data} envelope
│       │   ├── ws-client.ts        # WebSocket client with reconnect
│       │   └── git-graph-layout.ts
│       └── styles/
│           └── globals.css
├── tests/
│   ├── unit/
│   │   ├── services/
│   │   └── providers/
│   ├── integration/
│   │   ├── api/
│   │   └── ws/
│   └── setup.ts
├── scripts/
│   └── build.ts
└── docs/
    ├── project-overview-pdr.md
    ├── code-standards.md
    └── system-architecture.md
```
