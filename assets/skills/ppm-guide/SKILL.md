---
name: ppm-guide
description: PPM project structure, commands, config, and development workflow reference
argument-hint: "[topic]"
---

# PPM Guide

## Overview
# PPM Project Overview & Product Development Requirements
## Project Description
**PPM** (Personal Project Manager) is a full-stack, mobile-first web IDE designed for developers to manage code projects with AI-powered assistance. It combines a responsive web interface, real-time terminal access, AI chat with tool support, and Git integration into a cohesive development environment.
Built on the **Bun runtime** for performance, PPM enables developers to:
- Browse and edit project files with Monaco Editor syntax highlighting
- Execute commands via xterm.js terminal with full PTY support
- Chat with Claude AI with file attachments and slash commands
- View Git status, diffs, and commit graphs in real-time

## CLI Commands
```bash
bun dev:server    # Start backend dev (port 8081, uses ~/.ppm/ppm.dev.db)
bun dev:web       # Start Vite frontend (port 5173)
bun test          # Run all tests
bun test tests/integration/  # Integration tests only
```

## Dev Config
Config is stored in **SQLite** (`~/.ppm/ppm.db`). Dev uses a separate DB:

- **Dev**: `~/.ppm/ppm.dev.db` — port **8081**
- **Production**: `~/.ppm/ppm.db` — port **8080**

`bun dev:server` automatically uses the dev database. On a new machine, run `ppm init` to create default config, then `ppm config set port 8081` for dev.

## Architecture
- `src/providers/claude-agent-sdk.ts` — SDK integration, tool execution, streaming
- `src/server/ws/chat.ts` — WebSocket chat handler
- `src/web/hooks/use-chat.ts` — Frontend chat state management
- `src/services/config.service.ts` — Config from SQLite (`~/.ppm/ppm.db`)

## Code Standards
# PPM Code Standards & Conventions
## File Naming
| File Type | Convention | Example | Purpose |
|-----------|-----------|---------|---------|
| CLI commands | kebab-case | `start-cmd.ts`, `init.ts` | Descriptive command names |
| Services | kebab-case | `chat.service.ts`, `file.service.ts` | `{feature}.service.ts` pattern |
| Providers | kebab-case | `claude-agent-sdk.ts`, `mock-provider.ts` | `{name}-provider.ts` or `{name}.ts` |
| Routes | kebab-case | `chat.ts`, `project-scoped.ts` | Describe HTTP route group |
| WebSocket | kebab-case | `chat.ts`, `terminal.ts` | Match feature area |
| Components | PascalCase | `ChatTab.tsx`, `FileTree.tsx` | React convention |

## Slash Commands
Use `/skills` to list all available skills and commands.
Use `/help` for session help, `/status` for context usage, `/compact` to reduce context.

## Dev Workflow
1. `bun dev:server` — Start backend (port 8081, dev DB)
2. `bun dev:web` — Start Vite frontend (port 5173)
3. `bun test` — Run all tests
4. `bun run typecheck` — TypeScript type checking