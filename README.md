# PPM — Personal Project Manager

Mobile-first web IDE running as a CLI daemon. Manage code projects from your phone or browser.

## Features

- **File Explorer + Editor** — Browse, edit, diff files (CodeMirror 6)
- **Web Terminal** — Full shell access via xterm.js
- **Git Integration** — Visual graph, status, diff, commit, push/pull
- **AI Chat** — Claude Code integration with tool approvals
- **Tab System** — VSCode-like tabs for everything
- **PWA** — Installable on phone, offline UI shell

## Quick Start

```bash
bun install
bun run src/index.ts init
bun run src/index.ts start
```

## Development

```bash
bun run dev:web    # Frontend dev server (Vite)
bun run dev        # Backend with hot reload
bun test           # Run tests
bun run typecheck  # Type check
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Bun 1.2+ |
| Backend | Hono 4.x + Commander.js |
| Frontend | React 19 + Vite 6 + Tailwind 4 + shadcn/ui |
| Editor | CodeMirror 6 |
| Terminal | xterm.js |
| Git | simple-git |
| AI | @anthropic-ai/claude-agent-sdk |
| State | zustand |

## License

MIT
