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

## UI Rules

When creating or modifying any UI component, you MUST read and follow `docs/design-guidelines.md`, especially the **Mobile-First UI Rules** section. Key rules:
- Dialogs → bottom sheet on mobile (below `md:` breakpoint)
- No hover-only interactions — must have touch alternatives
- Touch targets minimum 44×44px
- Context menus → long-press on mobile, not tap
- Thumb zone: primary actions in bottom 1/3 of screen for one-handed use
- Always test both mobile and desktop layouts

## Roadmap & Context

Before planning or implementing a new feature, read `docs/project-roadmap.md` to understand:
- Which version the feature belongs to (v0.8, v0.9, v0.10, v1.0)
- The theme and scope of that version
- Dependencies between features
- Strategic principles (multi-device focus, extension architecture, tiered providers)

## Architecture

- `src/providers/claude-agent-sdk.ts` — SDK integration, tool execution, streaming
- `src/server/ws/chat.ts` — WebSocket chat handler
- `src/web/hooks/use-chat.ts` — Frontend chat state management
- `src/services/config.service.ts` — Config from SQLite (`~/.ppm/ppm.db`)
