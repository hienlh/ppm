# Schedules (prompt, script and session)

> Part of the [PPM system architecture](../system-architecture.md). Gotchas live in
> `src/services/schedule-script/CLAUDE.md`.

A schedule is one row in `schedules`, of one of three kinds:

- **prompt** — the original kind: on a 5-field cron, send a prompt to an AI chat in a project.
- **script** — JavaScript that PPM runs in a child process, in one of two modes:
  - **tick**: a fresh process on every fire of a 6-field cron (seconds first), at least 5 s apart
    (`SCRIPT_MIN_INTERVAL_MS`). It ends when its `main` returns or at the schedule's timeout.
  - **always-on**: one long-lived process that PPM starts, restarts after a crash with backoff
    (5 s doubling to 5 min, reset after 10 min of uptime) and stops when the schedule is turned
    off or deleted.
- **session** — a prompt delivered into one existing Claude or Codex chat, as a turn of that chat
  (see [Session schedules](#session-schedules)).

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
| `log(...)` / `console.*` | Lines into the schedule's log: secrets masked first, cut at 4096 chars, a 1000-line ring for the UI plus the run row. A line that still has no newline after 64 K chars is passed on cut there and the rest of it dropped, so a script printing without one cannot fill the server's memory. |
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

## Session schedules

A session schedule sends its prompt into the chat it names (`target_session_id`) and nowhere
else: it never creates a chat. Code in `src/services/session-schedules/`.

- **Firing is not running.** When its time comes the scheduler only records the fire as pending
  (`pending_since`) and hands the id to the deliverer (`session-schedule-firing.ts` →
  `session-schedule-due.ts`). The deliverer (`session-schedule-dispatcher.ts`) sends it through
  `chatControl().sendUserMessage` with origin `schedule` once the chat is **idle**: no turn
  running, no card on screen or queued behind it. It waits on the chat's own `turn_ended` and
  `approval_resolved` events rather than polling, one schedule turn per chat at a time. A
  schedule's message never cancels a card or steers a turn (`waitsForQuiet` in
  `src/server/ws/chat.ts`), and only one watch report or scheduled message may be on its way in at
  a time, so the two never land in one turn. If a turn starts between the quiet check and the
  send, the message goes in as `priority: "later"`. It counts as run only on the `turn_started`
  that names its own message id, never on the end of the turn ahead of it: Stop can kill the
  provider with the queued message in it. When that turn ends PPM asks the provider whether the
  message is still queued (`chatControl().messageQueued`, backed by Claude's turn binder and
  Codex's pending turns); one the chat no longer holds, with nothing running, is sent again with
  its fire still pending. A `turn_ended` marked `turnStillRunning` (a PPM builtin answered inside
  a running turn) ends nothing.
- **Nothing it misses holds a chat forever.** A message in flight is checked against the chat's
  live state every minute (`session-schedule-flight-watch.ts`): a started turn whose chat is idle
  ended unheard and its run is closed as an error; a queued message an idle chat no longer holds
  is sent again.
- **Coalescing.** Fires that come due while one is already pending fold into it: one turn, marked
  `coalesced` in its run block.
- **Catch-up, session kind only.** A fire missed while PPM was off is delivered **once** at start
  (`catchUpSessionSchedule`, marked `catchUp`); prompt and script schedules still skip missed
  fires. A fire counts as run only once its turn has started (`recordRunStarted`), so a restart in
  between sends it again: a rare double run rather than a lost reminder.
- **Time zone and one-shot.** `timezone` (IANA, canonicalised; null is the machine's own) is the
  zone the 5-field cron is read in, both for firing and for the "never fires" check.
  `recurring = 0` fires at the next match. Its fire stays pending through its turn, and the
  schedule deletes itself once that turn has ended without failing (a turn the user stopped, or
  one that hit Max Turns, counts as run).
- **A failed turn.** A turn the provider ended with an error is sent again only if it did nothing
  anyone could see: no text of its answer and no tool call (`worked` on the flight, set from the
  chat's `stream` events). Such a failure records the run as an error, tells the user once, and the
  fire goes again on the backoff below, for a one-shot and a recurring schedule alike. A turn that
  failed after it had started working is never sent again, since its tools may already have
  acted: the run is recorded as an error, one notification goes out, and a one-shot is paused
  ("failed partway; resume it to try again") while a recurring one stays on and waits for its
  next fire.
  A name is stored on one line with single spaces, as the run block carries it.
- **The chat's own settings.** The turn runs in the chat's permission mode, model and account.
  `chatControl` refuses a `permissionMode` with origin `schedule`, because a mode sent with a
  server message becomes the one that chat's subprocess keeps. The turn's approvals wait for the
  user like any other.
- **Unreachable chat → paused.** A chat that is gone, in an unregistered project, an Assistant or
  design session, on another provider, or a Claude chat whose transcript left the disk pauses its
  schedules (`paused_reason`, the pending fire dropped) with one notification for the chat naming
  them all. Turning one back on clears the pause and is refused while the chat still cannot take
  it. Deleting the chat deletes its schedules, and a provider rename (`migrated`) carries them to
  the new id.
- **A failure that may pass → tried again.** A send the chat refuses for any other reason (the
  session would not resume, the push failed) keeps the fire pending and tries the chat again
  after 1, 5 and 15 minutes (`session-schedule-retry-backoff.ts`, in memory). The count and the
  wait are the chat's, not one schedule's: every schedule pending for that chat waits out the same
  wait, failed sends and failed turns of any of them add to one count, and the fourth failure in a
  row pauses all of the chat's pending schedules together with one notification naming them. A schedule turned off with a fire still waiting (the
  chip's Pause) sends that fire as soon as it is turned on again. If the scheduler cannot record
  a fire at all, its timer waits 30 seconds before trying again.
- **Limits.** At most 20 per chat (`MAX_SCHEDULES_PER_SESSION`), checked through
  `assertCanAddSessionSchedule`; REST, CLI and the AI's tool all save through
  `session-schedule-save.ts`, so no door accepts what another refuses.
- **Notifications.** The turn notifies like any chat turn. The schedule itself sends a `schedule`
  notification only when it is held up behind a pending card (once per pending period, dropped if
  the card is answered first), when a turn failed before doing anything (once), when a turn
  failed partway, and when it is paused.
- **Open PPMs follow along.** Whatever delivery changes on its own — a fire coming due, a turn
  taking it, a run ending, a one-shot going, a pause, a renamed or deleted chat — broadcasts
  `schedules:changed` on `/ws/global` (`broadcastSchedulesChanged`, coalesced over 50 ms), so the
  chip and Settings never show a fire already sent.
- **In the chat.** The prompt is preceded by a `<ppm-schedule-run-v1>` block
  (`src/shared/chat-schedule-run.ts`), which only the server writes; the chat draws it as one
  "Schedule … ran" line that opens to the prompt (`schedule-run-line.tsx`), and a footer chip
  lists the chat's schedules with pause, resume and delete (`session-schedules-chip.tsx`).

## Surfaces

- REST: `src/server/routes/schedules.ts` (CRUD, `run-now`, `runs`; `?session=<id>` lists one
  chat's session schedules, each with `target_title`) and `schedules-script.ts` (`logs`, `state`,
  `export`, `import`).
- CLI: `ppm schedule add|list|rm|enable|disable|run-now|runs|export|import|state|set-state`;
  `add --session <id> --prompt … --cron … [--tz <zone>] [--once]` makes a session schedule;
  `edit` on one names the flags it does not use (`--project`, `--permission-mode`, `--max-turns`,
  `--timeout`: it runs on its chat's settings).
  Changes to a script schedule go through the running server, which owns the process.
- UI: Settings → Schedules (`src/web/components/settings/schedules/`): the form with its script
  editor and input declarations, the import sheet, the live log, and a status chip per row. A
  session schedule's row names its chat in the Session column; the form's kind *Chat* picks one.
- DB: migration 58 adds `kind`, `mode`, `description`, `script`, `inputs_json`,
  `input_values_json`, `secrets_enc`, `state_json` to `schedules`, plus `schedule_runtime`
  (one process per schedule), `schedule_chats` (key → chat) and `schedule_ai_turns`.
  Migration 72 adds `target_session_id`, `timezone`, `recurring`, `pending_since` and
  `paused_reason`, and rebuilds the `kind` CHECK to accept `session`.
