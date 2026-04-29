---
name: ppm
description: Control PPM (Project & Process Manager) via its CLI, HTTP API, and SQLite config database. Use when the user wants to manage PPM projects, query database connections, start/stop the PPM server, view logs, or read/write PPM config.
---

# PPM Skill

PPM is a local-first web IDE + project manager. This skill describes how to control PPM from the terminal, over HTTP, and by inspecting its SQLite config database.

## Quick Reference

| What | Where |
|---|---|
| CLI binary | `ppm` |
| Default server | `http://localhost:8080` |
| Config DB (prod) | `~/.ppm/ppm.db` (SQLite) |
| Config DB (dev) | `~/.ppm/ppm.dev.db` (port 8081) |
| Skill root (user) | `~/.claude/skills/` |
| Skill root (project) | `<project>/.claude/skills/` |

## When to Use This Skill

Invoke when the user asks to:
- Start, stop, restart, or check the PPM server
- Manage registered projects (`projects list/add/remove`)
- Manage database connections stored in PPM config (`db list/add/test/query`)
- Get or set PPM config values (`config get/set`)
- View PPM logs, status, or report a bug
- Install, upgrade, or inspect bundled skills / extensions
- Control the PPM daemon autostart registration

## Top Tasks

1. **Check if PPM is running** → `ppm status`
2. **Start server** → `ppm start` (use `--port <n>` to override, `--profile dev` for dev DB)
3. **List projects** → `ppm projects list`
4. **Add project** → `ppm projects add <path>`
5. **List DB connections** → `ppm db list`
6. **Query a saved DB connection** → `ppm db query <connection-name> "<sql>"`
7. **Read config** → `ppm config get <key>` (e.g. `port`, `auth.enabled`)
8. **Tail logs** → `ppm logs --tail 100` or `ppm logs -f` to follow
9. **Upgrade PPM** → `ppm upgrade` (or `--check` to only check)
10. **Open in browser** → `ppm open`

## Rules of Thumb

- Always run `ppm status` before assuming the server is up.
- Commands exit non-zero on failure and print to stderr. Capture both streams.
- Most listing commands accept `--json` for structured output; prefer JSON when parsing. Check `--help` if unsure.
- The config DB is **SQLite**. You may open `~/.ppm/ppm.db` read-only for inspection — see [references/db-schema.md](references/db-schema.md).
- Do NOT edit the config DB directly while the server is running; use `ppm config set` or the HTTP API.

## Links

- Complete CLI options, every subcommand → [references/cli-reference.md](references/cli-reference.md)
- HTTP API routes (25+) → [references/http-api.md](references/http-api.md)
- Config DB schema (runtime-generated from user's DB) → [references/db-schema.md](references/db-schema.md)
- Worked recipes for common tasks → [references/common-tasks.md](references/common-tasks.md)

## Error Handling

- Server not running → `ppm status` exits non-zero; start with `ppm start`.
- Port conflict → `ppm config set port <n>` then `ppm restart`.
- Missing config DB → `ppm init` creates defaults.
- Upgrade failure → re-run `ppm upgrade` or `npm i -g @hienlh/ppm@latest`.

## Scope Boundaries

This skill covers the `ppm` CLI, its HTTP API, and its config DB. It does **not** cover:
- Projects managed by PPM (those are user code, outside skill scope).
- Third-party extensions (inspect via `ppm ext list`).
- The Claude Agent SDK internals (separate skill).

<!-- Generated for PPM v0.13.54 at build time. Re-run `ppm export skill --install` to refresh. -->
