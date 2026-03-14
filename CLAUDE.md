# PPM — Claude Code Conventions

## Runtime & Tools
- **Bun** — use `bun` instead of node/npm/npx
- `bun run src/index.ts` for CLI
- `bun run dev:web` for frontend dev server (Vite)
- `bun run build:web` for frontend build
- `bun test` for tests
- `bun run typecheck` for type checking

## Project Structure
- `src/index.ts` — CLI entry point (Commander.js)
- `src/server/` — Hono HTTP + WebSocket server
- `src/services/` — Business logic (config, project, file, git, terminal, chat)
- `src/providers/` — AI provider adapters (claude-agent-sdk, cli-subprocess)
- `src/cli/` — CLI commands
- `src/types/` — Shared TypeScript types
- `src/web/` — React SPA (Vite + Tailwind + shadcn/ui)
- `tests/` — Unit + integration tests

## Conventions
- TypeScript strict mode, kebab-case file names
- Hono for HTTP, Bun built-in WebSocket (no Socket.IO)
- shadcn/ui components in `src/web/components/ui/`
- zustand for state management
- Path alias: `@/` → `src/web/`
- Service layer pattern: CLI + API routes both call services
- AI provider interface pattern: generic, multi-provider ready
