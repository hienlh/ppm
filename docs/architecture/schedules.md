# Schedules (prompt and script)

> Part of the [PPM system architecture](../system-architecture.md). Gotchas live in
> `src/services/schedule-script/CLAUDE.md`.

A schedule is one row in `schedules`, of one of two kinds:

- **prompt** — the original kind: on a 5-field cron, send a prompt to an AI chat in a project.
- **script** — JavaScript that PPM runs in a child process, in one of two modes:
  - **tick**: a fresh process on every fire of a 6-field cron (seconds first), at least 5 s apart
    (`SCRIPT_MIN_INTERVAL_MS`). It ends when its `main` returns or at the schedule's timeout.
  - **always-on**: one long-lived process that PPM starts, restarts after a crash with backoff
    (5 s doubling to 5 min, reset after 10 min of uptime) and stops when the schedule is turned
    off or deleted.

A script is an ES module whose default export takes `ctx`:

```js
export default async function main(ctx) {
  const last = ctx.state.last ?? 0;
  ctx.log(`seen ${last}`);
  ctx.state = { last: Date.now() };          // kept after a tick ends, or now with ctx.save()
}
```

## The child process

```
scheduler (tick fire / always-on supervisor)
  └─ script-launch.ts ── ScriptProcess ──spawn──> <ppm binary> --eval HARNESS_SOURCE   (BUN_BE_BUN=1)
        ▲   IPC: call / result / hb / done            │  imports <PPM dir>/schedule-runs/<db>/<id>/script-<hash>.mjs
        └── ctx-host.ts answers save, notify, ai.*    └─ watchdog Worker: dies with the server
```

- One child per schedule, never two: `instance-guard.ts` records the pid and a token, and on boot
  `reconcileLeftovers` kills a leftover only after proving it is PPM's.
- The child dies with the server however the server dies: stdin EOF, plus a Worker that checks
  the parent every 250 ms for a script that blocks its event loop.
- `stop()` aborts `ctx.signal`, then SIGKILLs after 5 s. A tick past its timeout is stopped the
  same way and recorded as failed.
- The environment is the server's minus `NOTIFY_SOCKET`; the cwd is the project folder.

## `ctx`

| Member | What it does |
|---|---|
| `inputs` | The schedule's input values (frozen); a secret input arrives decrypted. |
| `state` / `save()` | One JSON value per schedule, at most 2 MB. A tick's state is kept when it ends, failed or not; always-on keeps it only through `save()`. |
| `log(...)` / `console.*` | Lines into the schedule's log: secrets masked first, cut at 4096 chars, a 1000-line ring for the UI plus the run row. |
| `notify({ title, body, sessionId? })` | PPM's notification fan-out (push, Telegram, ntfy). |
| `ai.ask(prompt, { model, effort, system, jsonSchema, timeoutMs })` | One stateless model call on PPM's accounts: no tools, no `CLAUDE.md`, no session left behind. Default model `haiku`, 2 min. Answers `{ ok, text, json?, error?, timedOut?, costUsd }` instead of throwing. |
| `ai.chat(key, prompt, { title, sessionId, timeoutMs, wait })` | A turn in a real PPM chat, one chat per `key` (or the given `sessionId`), shown live like any chat. Answers `{ ok, text, sessionId, busy?, error? }`; `busy` when someone else is mid-turn there. |
| `ai.finished()` | The results of `ai.chat` turns started with `wait: false` that have ended since the last call, each returned once. They are kept in `schedule_ai_turns`, so a later tick can collect a turn an earlier one started. |
| `signal` / `sleep(ms)` | Aborted when PPM stops the script; `sleep` rejects on abort. |

`ai.chat` goes through the chat WebSocket handler over a loopback socket (`chat-loopback.ts`,
`origin = "scheduler"`), so the turn sets the session's phase, rotates accounts and appears in
the chat list. A new chat with no transcript is deleted, and its key forgotten.

## Inputs and secrets

A script declares inputs (`text`, `number`, `boolean`, `secret`; label, default, `required`).
Values live in `input_values_json`; secret values are encrypted in `secrets_enc` and never leave
the server: every `/api/schedules` answer goes through `toScheduleView`, which drops
`secrets_enc` and `state_json`. A schedule with a required input left empty does not start.

## Templates

A template is a `<name>.ppm-schedule.json` file (`src/shared/schedule-template.ts`, format 1):
the definition, the inputs with their defaults, and the script. It never carries a secret's
value, ids, a session, state or a path of this machine.

- **Export** (`GET /api/schedules/:id/export`, `ppm schedule export <id>`) writes that file.
- **Import** (`POST /api/schedules/import`, `ppm schedule import <file> --project <name>`) parses
  strictly (an unknown field or format is refused), shows the whole script, and requires the
  user to state "I trust this code". The schedule is created **off**.

Example templates ship in `templates/schedules/` and are tested as PPM runs them.

## Surfaces

- REST: `src/server/routes/schedules.ts` (CRUD, `run-now`, `runs`) and `schedules-script.ts`
  (`logs`, `state`, `export`, `import`).
- CLI: `ppm schedule add|list|rm|enable|disable|run-now|runs|export|import|state|set-state`.
  Changes to a script schedule go through the running server, which owns the process.
- UI: Settings → Schedules (`src/web/components/settings/schedules/`): the form with its script
  editor and input declarations, the import sheet, the live log, and a status chip per row.
- DB: migration 58 adds `kind`, `mode`, `description`, `script`, `inputs_json`,
  `input_values_json`, `secrets_enc`, `state_json` to `schedules`, plus `schedule_runtime`
  (one process per schedule), `schedule_chats` (key → chat) and `schedule_ai_turns`.
