---
name: ppm
description: Control PPM (Project & Process Manager) via its CLI, HTTP API, and SQLite config database. Use when the user wants to start/stop or check the PPM server, manage PPM projects, chat sessions, git in a project, schedules, database connections, extensions, config, logs, backups, or autostart.
---

# PPM Skill

PPM is a local-first web IDE + project manager. This skill describes how to control PPM from the terminal, over HTTP, and by inspecting its SQLite config database.

## Quick Reference

| What | Where |
|---|---|
| CLI binary | `ppm` |
| Server URL | `http://localhost:<port>` — `port` from `ppm status --json` (8080 unless configured otherwise) |
| PPM directory | `~/.ppm` (`$PPM_HOME` when set) |
| Config DB | `~/.ppm/ppm.db` (SQLite); `--profile <name>` uses `~/.ppm/ppm.<name>.db` |
| Skill root (user) | `~/.claude/skills/` (Claude), `~/.agents/skills/` (Codex), `~/.gemini/config/skills/` (Antigravity) |
| Skill root (project) | `<project>/.claude/skills/` (Claude), `<project>/.agents/skills/` (Codex, Antigravity) |

## When to Use This Skill

Invoke when the user asks to:
- Start, stop, restart, or check the PPM server (`start`, `stop`, `restart`, `down`, `status`)
- Manage registered projects (`projects list/add/remove`)
- Create, list, or message AI chat sessions from the terminal (`chat`)
- Run git in a registered project (`git status/log/diff/stage/commit/push/pull/branch`)
- Manage scheduled agents (`schedule list/add/enable/disable/run-now/runs`)
- Manage database connections stored in PPM config — PostgreSQL, MySQL / MariaDB, SQLite (`db list/add/test/remove`; MySQL and MariaDB need `db driver install mysql` once)
- Get or set PPM config values (`config get/set`)
- View PPM logs, status, or report a bug (`logs`, `report`)
- Snapshot or restore the config database (`backup`, `restore`)
- Install, upgrade, or inspect bundled skills / extensions (`skills`, `ext`, `upgrade`)
- Control the PPM daemon autostart registration (`autostart`)

## Top Tasks

1. **Is PPM running, and on which port?** → `ppm status --json` → `running`, `healthy`, `port`
2. **Start server** → `ppm start` (use `--port <n>` to override)
3. **List projects** → `ppm projects list`
4. **Add project** → `ppm projects add <path>`
5. **Ask a PPM chat to do something** → `ppm chat create -p <project>`, then `ppm chat send <session-id> "<message>"`
6. **Git status of a project** → `ppm git status -p <project>`
7. **List DB connections** → `PPM_AI_CHAT=1 ppm db list --json`
8. **Read or change data in a saved connection** → see Rules of Thumb
9. **Read config** → `ppm config get <key>` (e.g. `port`, `auth.enabled`)
10. **Tail logs** → `ppm logs --tail 100`, `ppm logs -f` to follow, `ppm logs -l error` for errors only
11. **Upgrade PPM** → `ppm upgrade` (or `--check` to only check)

## Rules of Thumb

- `ppm status` exits 0 whether or not PPM is up: read `running` and `healthy` from `ppm status --json`.
- Commands exit non-zero on failure and print the reason to stderr. Capture both streams.
- Many commands take `--json` (the CLI reference lists which); with it, stdout is the JSON alone. `projects list`, `chat list`, `schedule list` and `git` print text.
- `ppm restart`, `ppm stop`, `ppm down` and `ppm upgrade` cut every running PPM chat — including the one you may be running in. Ask the user first.
- Data in a saved database connection:
  - Inside a PPM chat (PPM sets `PPM_AI_CHAT=1` for Claude, Codex and Antigravity alike), `db tables/schema/data/query/run` refuse. A Claude or Codex chat has tools instead: `db_query` to read, `db_execute` to change; the user can switch those off in Settings → Tools, and approves each write. An Antigravity chat has neither tool, so ask the user to run the query, or to ask it in a Claude or Codex chat.
  - Outside PPM there are no such tools and `ppm db` runs, obeying neither. So run `PPM_AI_CHAT=1 ppm db list` first, leave alone any connection it hides (the user turned "Available to the AI chat" off for it), and ask before any write.
  - The connection commands (`list`, `add`, `test`, `remove`, `driver`) work in both.
- The HTTP API needs `Authorization: Bearer <token>` while auth is on (the default). The token is the access password the user signs in to PPM with: ask for it — `ppm config get auth.token` deliberately does not print it. Never turn auth off to get around this: PPM's tunnel can put it on the internet.
- The config DB is **SQLite**. You may open `~/.ppm/ppm.db` read-only for inspection — see [references/db-schema.md](references/db-schema.md). It holds secrets (the access token among them): never print or send them.
- Do NOT edit the config DB directly while the server is running; use `ppm config set` or the HTTP API.

## Links

- Complete CLI options, every subcommand → [references/cli-reference.md](references/cli-reference.md)
- HTTP API routes, authentication, WebSockets → [references/http-api.md](references/http-api.md)
- Config DB schema (written by `ppm export skill --install` from the user's own DB) → [references/db-schema.md](references/db-schema.md)
- Worked recipes for common tasks → [references/common-tasks.md](references/common-tasks.md)

## Error Handling

- Server not running → `ppm status --json` shows `"running": false`; start with `ppm start`, and read `ppm logs --tail 50` if it does not come up.
- Port conflict → `ppm config set port <n>` then `ppm restart`.
- `"state": "paused"` in `ppm status --json` (it crashed repeatedly) → read `ppm logs -l error`, then `ppm restart --force` to resume.
- Missing config DB → `ppm init` creates defaults.
- Upgrade failure → re-run `ppm upgrade` or `npm i -g @hienlh/ppm@latest`.

## Scope Boundaries

This skill covers the `ppm` CLI, its HTTP API, and its config DB. It does **not** cover:
- Projects managed by PPM (those are user code, outside skill scope).
- Third-party extensions (inspect via `ppm ext list`).
- The Claude Agent SDK internals (separate skill).

<!-- Generated for PPM v0.23.37 at build time. Re-run `ppm export skill --install` to refresh. -->
