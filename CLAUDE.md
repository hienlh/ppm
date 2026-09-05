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

## PPM Directory

**Never** use `resolve(homedir(), ".ppm")`, `join(homedir(), ".ppm")`, or `process.env.PPM_HOME || resolve(homedir(), ".ppm")` directly in service code.
Always import `getPpmDir()` from `src/services/ppm-dir.ts`. This ensures test isolation via `PPM_HOME` env var.

Exceptions (intentionally use real `homedir()`):
- `autostart-generator.ts` / `autostart-register.ts` — system service paths (launchd, systemd)
- `claude-usage.service.ts` — reads `~/.claude/` credentials (different dir)
- `fs-browse.service.ts`, `git-dirs.service.ts` — file browser starting from real home
- `ppmbot/` — bot files in real home
- `slash-discovery/` — discovers skills from real home
- `named-tunnel/cloudflared-cert.ts` — `~/.cloudflared` is where `cloudflared` itself writes `cert.pem`, not PPM's directory
- `fs-credential-path-guard.ts` — refuses `~/.cloudflared` (alongside the PPM dir) on every fs read/write/transfer door

## Known Gotchas

- **SDK .env poisoning**: Projects with `ANTHROPIC_API_KEY` in `.env` break SDK tool execution. Provider neutralizes these vars. See `docs/lessons-learned.md`.
- **File watching**: never `fs.watch(dir, { recursive: true })` on a project root — on Linux that is one inotify watch per subdirectory, `node_modules` included (it once cost 359k watches). Ignored dirs must be pruned at registration time via `src/services/file-watcher/watch-tree.ts`.
- **Project Claude settings**: `.claude/settings.local.json` can restrict tools even with `bypassPermissions`. Provider overrides with empty settings.
- **Transcript images live in two places**: the base64 payload sits at `message.content[].content[]` inside a tool result, but Claude Code also writes an image-shaped record at the top-level `toolUseResult` field carrying no payload. An assertion like "no `"type":"image"` remains" must be scoped to the former, or it fails against correct code.
- **Plugin items are named by location, not frontmatter**: Claude Code registers a plugin's skills and commands as `<plugin>:<path>` (`ak-engineer:ak-debug`) and only honours the frontmatter `name` for agents. Kits that self-namespace instead — AgentKit ships `name: ak:debug` — publish a name nothing can resolve. `slash-discovery` mirrors that rule and keeps the declared name as an alias; `src/server/ws/chat.ts` rewrites the alias to the canonical name before the message reaches the SDK.
- **Agent teams are implicit and mostly not in `~/.claude/teams/`**: there is no `TeamCreate` tool any more. A team appears as `~/.claude/teams/<sessionId>/inboxes/*.json` with **no `config.json`**, so anything that requires a config sees no team at all. The inboxes only hold what was sent *to* each handle — in practice just the lead's task assignments — so they can neither say who is working nor show a teammate's replies. Both live in the agent transcripts under `~/.claude/projects/<slug>/<sessionId>/subagents/`: `agent-<id>.meta.json` maps the teammate `name` to its transcript, a transcript being appended to means that teammate is running, and its replies are `SendMessage` tool calls inside it. See `src/services/team-member-activity/`.

## UI Rules

When creating or modifying any UI component, you MUST read and follow `docs/design-guidelines.md`, especially the **Mobile-First UI Rules** section. Key rules:
- Dialogs → bottom sheet on mobile (below `md:` breakpoint)
- No hover-only interactions — must have touch alternatives
- Touch targets minimum 44×44px
- Context menus → long-press on mobile, not tap
- Thumb zone: primary actions in bottom 1/3 of screen for one-handed use
- Always test both mobile and desktop layouts

### Reusable Adaptive Components

- **Context menus**: Always use `@/components/ui/adaptive-context-menu` instead of `@/components/ui/context-menu`. It auto-detects mobile (< 768px) and renders a bottom sheet with long-press trigger instead of radix right-click menu. Same API — just swap the import path. Sub-menus are flattened inline on mobile.
- **Mobile detection**: Use `useIsMobile()` from `@/hooks/use-is-mobile` for reactive mobile breakpoint checks.

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
- `src/web/components/floating-window/` — Desktop window manager (drag/resize/z-band/persistence), OS-agnostic
- `src/web/components/os-explorer/` — OS File Explorer window body: views (List/Icons/Column), skins, mobile sheet, actions, drag-and-drop
- `src/services/fs-ops/` — Guarded whole-disk filesystem operations (`/api/fs/*`) behind PPM auth
- `src/services/host-info/` — Per-OS drives/known-folders/pinned-folders providers (`/api/system/host`)
- `src/services/system-metrics/` — Task Manager backend (`/api/system/resources*`): per-OS collectors, one long-lived PowerShell child on Windows (never spawn per tick — 32 MiB commit leak each), light/full SSE tiers with leases, guarded kill. UI in `src/web/components/system/` (floating window on desktop, tab on mobile)
- `src/services/named-tunnel/` — Named tunnel (stable `https://<prefix>.<zone>` URL via Cloudflare login), orchestrated from `src/server/routes/named-tunnel.ts`, spawned/probed by the supervisor; UI in `src/web/components/tunnels/named-tunnel/`
