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
bun dev:server    # Start backend (port from ~/.ppm/config.yaml)
bun dev:web       # Start Vite frontend (port 5173)
bun test          # Run all tests
bun test tests/integration/  # Integration tests only
```

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
