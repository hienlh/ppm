# CLAUDE.md

## Project

PPM (Project & Process Manager) — a web-based IDE/project manager with AI chat powered by Claude Agent SDK.

## Stack

- **Runtime**: Bun
- **Backend**: Hono (HTTP) + Bun WebSocket
- **Frontend**: React + Vite + Tailwind + shadcn/ui
- **AI**: @anthropic-ai/claude-agent-sdk
- **Tests**: bun:test

## Commands

```bash
bun dev:server    # Start backend dev (port 8081, uses ~/.ppm/config.dev.yaml)
bun dev:web       # Start Vite frontend (port 5173)
bun test          # Run all tests
bun test tests/integration/  # Integration tests only
```

## Dev Config

Local dev uses a **separate config file** from production:

- **Dev**: `~/.ppm/config.dev.yaml` — port **8081**
- **Production**: `~/.ppm/config.yaml` — port **8080**

`bun dev:server` automatically passes `-c ~/.ppm/config.dev.yaml`. Create this file on a new machine by copying `ppm.example.yaml` to `~/.ppm/config.dev.yaml` and setting `port: 8081`.

## Release Process

1. Commit feature/fix changes
2. Update `CHANGELOG.md` with all changes
3. Bump version in `package.json` — patch for small changes, minor/major for large ones
4. Commit: `chore: bump version to x.x.x`
5. Publish: `npm publish --access public`

## Quick SDK Tool Test

Use `test-tool.mjs` to verify SDK tool execution against any project cwd:

```bash
bun test-tool.mjs /path/to/project                    # default: echo test
bun test-tool.mjs /path/to/project "dùng thử tool bash"  # custom prompt
```

This uses `ClaudeAgentSdkProvider` directly — same env/settings overrides as production.

## Known Gotchas

- **SDK .env poisoning**: Projects with `ANTHROPIC_API_KEY` in `.env` break SDK tool execution. Provider neutralizes these vars. See `docs/lessons-learned.md`.
- **Project Claude settings**: `.claude/settings.local.json` can restrict tools even with `bypassPermissions`. Provider overrides with empty settings.

## Architecture

- `src/providers/claude-agent-sdk.ts` — SDK integration, tool execution, streaming
- `src/server/ws/chat.ts` — WebSocket chat handler
- `src/web/hooks/use-chat.ts` — Frontend chat state management
- `src/services/config.service.ts` — Config from `~/.ppm/config.yaml`
