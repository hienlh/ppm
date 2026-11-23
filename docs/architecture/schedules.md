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

A script schedule may read its cron in a zone of its own (`timezone`, IANA, as a session schedule
does), so a watch kept to UK working hours fires on the UK clock; POST takes it for script kinds
only, and a row without one (every schedule saved before) reads the machine's zone. The Settings
form keeps a stored zone but does not edit it.

## Script schedules an AI proposes

A chat's AI and the PPM Assistant can propose a script schedule; it exists only once the user has
allowed a card. Code in `src/services/schedule-proposals/`.

- **Tools.** A chat (an ordinary or a manager chat) has `session_schedule_propose_script` on the
  `ppm-sessions` server (`collab-schedule-proposals.ts`); the Assistant has
  `schedule_propose_script` (`assistant-schedule-propose-tool.ts`). Both take the template's fields
  (`name`, `description`, `mode`, `cron`, `script`, `inputs`, `timeoutMinutes`, `permissionMode`) or
  `file`, the absolute path of a `.ppm-schedule.json`, plus `timezone` and `inputValues` either
  way. A chat's schedule always runs in its own project's folder and its `file` must be inside
  that folder; the Assistant names a registered project and may read a file in any of them.
- **Checked first, by the route's own rules** (`parseScriptProposal`): the template is parsed
  strictly as on import, except that a proposal file may carry `values` (this machine's input
  values, which a shared template never holds and import still refuses); the tool's `inputValues`
  override them and both pass the same checks (declared, not secret, not null, the right type, no
  vault value) and show on the card alike. Then
  `newScheduleFrom` runs dry, so a card never shows a schedule the save would refuse. A secret's
  value never comes from an AI: a secret in `inputValues` is refused, and so is a script with a
  required secret input (the user imports that one in Settings → Schedules).
- **The card** (`scriptProposalSummary`) is the server's reading of the checked proposal: the whole
  script as the body, the folder it runs in, cron, zone (or "this machine's") and the next three
  runs, the timeout, every input's value or default, the mode its `ctx.ai.chat` turns run in, the
  default provider it snapshots, the file and its SHA-256, and the chats it sends to — every chat
  id found in the script and the input values, by title, flagged when in another project. The
  description is labelled as the AI's own words. The card never guesses from the script's text what
  it calls: it says that any script can reach any chat (`ctx.ai.chat`), notifications and whatever
  the user can reach, and that only the script says which. A warning says nobody watches the runs.
- **Off until asked.** The chat tool is its own question in the tour
  (`script-schedule-proposals-2026-11` in `src/shared/feature-intros.ts`): an install that turned
  scheduled prompts on did not agree to code. A vault value is refused in a proposal whichever way
  it arrives, a file's contents included.
- **Allowed only in PPM.** The card carries `reviewInPpm`, which `decidingInput` reads as
  incomplete: Telegram shows it with Deny only, the Assistant's mirror shows no Allow, and
  `chat_answer_approval` refuses to allow it — the existing "Allow only when the whole deciding
  input fits" rule, applied whatever the script's length. `settleCollabApprovalFromServer` also
  refuses an Allow press for such a card, whatever a surface drew.
- **What is created is what was shown.** The schedule is saved from the same frozen proposal the
  card was built from (`proposalRouteBody`, created on). After the answer, a `file` hashing
  differently, or a default provider that changed, creates nothing (`stale`); after the save the
  stored row is compared with the proposal (`proposalMismatch`) and removed again if any field
  differs.
- **Pause and resume.** `session_schedule_set_enabled` (chat) turns a schedule off or on without
  deleting it. Pausing only stops something, so it is done at once with no card — the chat's own
  reminders and any script or prompt schedule of its project — and the answer names the schedule
  it paused. Turning on is done at once for the chat's own reminders (as they are created and
  deleted) and only after a card for the project's other schedules (`schedule-toggle.ts`), refused
  as `stale` if the schedule changed while the card waited. A turn PPM started with nobody in it
  (`isUnattendedTurn`) still pauses none of the project's schedules unasked: it takes the card
  path, which such a turn cannot show. The Assistant's `schedule_save` likewise pauses with no card
  only in a clean turn the user started (`isCleanTurn`, as `chat_organize` decides), and asks in
  any other. Every pause, resume and creation an AI makes is logged (`scheduler` in `ppm.log`, the
  Logs window) beside the session trace's record of the call. Turning a script on shows the script
  and is allowed only in PPM; so is any Assistant card that runs a script now (`schedule_run_now`) or changes one
  other than renaming or pausing it (`schedule_save`), which shows its code and input values
  (`withStoredScript`). A card is stale when inputs or secrets changed while it waited, read raw or
  through the routes' view. Anything else —
  another project's schedule, another chat's reminder — reads as missing.
  `session_schedule_list` lists the project's script and prompt schedules under `projectSchedules`.
- **Cards in a chat** are a session-tool card of kind `schedule` (`SessionCollabScheduleApproval`)
  carrying the same `ApprovalSummary` the Assistant's cards carry, answered once or not at all
  over `POST /api/sessions-collab/approvals/:id`; an unattended turn cannot ask one.

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
  its fire still pending (after a Stop, only once the hold below ends). A `turn_ended` marked
  `turnStillRunning` (a PPM builtin answered inside a running turn) ends nothing.
- **Stop holds what is pending.** A turn stopped on request (`turn_ended.cancelledBy`: Stop in a
  browser, `/stop`, Telegram, the Assistant) holds that chat's pending schedules, a scheduled
  message queued behind the stopped turn included: it is not sent again a few seconds later into
  the chat the user just quieted. It stays pending and goes at the first of: the end of any later
  turn in that chat that was not itself stopped (a user turn or any other), or a fire of one of
  the chat's schedules coming due (its next cron time, which coalesces into the pending fire, or
  Run now). The hold lives in the deliverer's memory, so a restart of PPM releases it and the
  stored pending fire goes at start. A Stop with nothing pending holds nothing. A held schedule
  says so: the REST view carries `held_after_stop` (asked of the deliverer through
  `session-schedule-due.ts`), the chip and Settings read "Held after Stop", the AI's
  `session_schedule_list` gives the same reason, and holding or releasing broadcasts
  `schedules:changed`.
- **Nothing it misses holds a chat forever.** A message in flight is checked against the chat's
  live state every minute (`session-schedule-flight-watch.ts`): a started turn whose chat is idle
  ended unheard and its run is closed as an error; a queued message an idle chat no longer holds
  is sent again (unless a Stop holds it).
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
  row pauses all of the chat's pending schedules together with one notification naming them.
  Run now during that wait is refused with 409 and the time of the next attempt
  (`SessionScheduleRetryWaitError`, asked of the deliverer through `session-schedule-due.ts`),
  which `ppm schedule run-now` prints, rather than being accepted and folded into the waiting fire. A schedule turned off with a fire still waiting (the
  chip's Pause) sends that fire as soon as it is turned on again. If the scheduler cannot record
  a fire at all, its timer waits 30 seconds before trying again.
- **Limits.** At most 20 per chat (`MAX_SCHEDULES_PER_SESSION`), checked through
  `assertCanAddSessionSchedule`; REST, CLI and the AI's tool all save through
  `session-schedule-save.ts`, so no door accepts what another refuses.
- **Notifications.** The turn notifies like any chat turn. The schedule itself sends a `schedule`
  notification only when it is held up behind a pending card (once per pending period, dropped if
  the card is answered first), when a turn failed before doing anything (once), when a turn
  failed partway, and when it is paused. A schedule a chat's AI creates (`session_schedule_create`)
  needs no approval, so each one sends a `schedule_created` notification ("AI scheduled a prompt",
  on by default, switched in Settings → Notifications): its name, the chat and project, when it
  runs (cron in words, time zone, next run) and the prompt on one line cut to 120 characters,
  linked to the chat (`collab-schedule-created-notice.ts`). It is sent only if the schedule still
  exists when the notification delay ends, and a chat sends at most five an hour
  (`collab-schedule-notice-limit.ts`): past that it sends one notice saying further ones are muted
  and until when, and the rest are only logged, so an AI looping on create and delete cannot flood
  the user. Schedules saved from Settings, REST or the CLI send none.
- **Open PPMs follow along.** Whatever delivery changes on its own — a fire coming due, a turn
  taking it, a run ending, a one-shot going, a pause, a renamed or deleted chat — broadcasts
  `schedules:changed` on `/ws/global` (`broadcastSchedulesChanged`, coalesced over 50 ms), so the
  chip and Settings never show a fire already sent.
- **In the chat.** The prompt is preceded by a `<ppm-schedule-run-v1>` block
  (`src/shared/chat-schedule-run.ts`), which only the server writes; the chat draws it as one
  "Schedule … ran" line that opens to the prompt (`schedule-run-line.tsx`), and a footer chip
  lists the chat's schedules with open, pause, resume and delete (`session-schedules-chip.tsx`).
  The chip asks `GET /api/schedules?session=<id>` (`chatSchedulesOf`), which answers the session
  schedules aimed at the chat *and* every schedule its AI created, script and prompt ones
  included: `schedules.created_by_session_id` (migration 80) is set by the session tools
  (`session_schedule_create`, `session_schedule_propose_script`) and by the PPM Assistant's
  `schedule_save` / `schedule_propose_script`, which pass it in the route body. A schedule a person
  makes in Settings or the CLI has none. Migration 80 fills it for older script and prompt
  schedules from `session-trace.db` where the trace names the schedule's id and name within 15
  minutes of its creation (`schedule-creator-backfill.ts`); older than the trace's retention, a
  schedule stays unlinked.
- **A prompt that is a slash command.** A scheduled `/skill args` goes through the same alias
  rewrite as a typed one. In a Claude chat it then stays the message's first characters, since
  Claude Code runs a leading `/name` as that command or skill: the block goes after it
  (`/skill args`, a blank line, the block, whose header says the command is above;
  `scheduleRunPlacement`), and like any slash command it gets no shared-context prefix. Claude
  Code records the command as `<command-name>`/`<command-args>` tags with the block inside the
  args, which the bubble's parser reads back (`decodeScheduleRunInCommandArgs`), so the run line
  still shows `/skill args` after a reload. It reads them only from the message exactly as
  stored, and only when the message starts with Claude's own `<command-message>`/`<command-name>`
  tags: the display strips other tags (`<local-command-stdout>` among them) first, and a sentinel
  typed in two halves around such a tag would join up after stripping. A literal
  `</command-args>` in the prompt is broken with a zero-width space when the message is built,
  since Claude Code writes the args verbatim and would otherwise end them there.
  The block therefore **is part of the command's arguments**: the CLI cuts the name at the first
  whitespace and passes the rest, so a command or skill reads `42`, a blank line and PPM's note as
  its `$ARGUMENTS` (the note alone for a command sent with none). A command that expects one
  strict value (a PR number, a model name) may need to ignore what follows the first line. A
  PPM builtin (`/skills`, `/version`…) scheduled in a Claude chat is answered by PPM as when typed,
  and its run still recorded; in a Codex chat the same prompt reaches the model as text. Anything
  that starts with a slash and a non-slash counts as a command, a path such as `/tmp/x.log check
  this` included: the block goes after it and the CLI, finding no such command, passes it on as
  text, so only the header's "command above" wording is off. Codex runs no slash commands from a message (its own
  `/…` commands belong to its terminal UI): PPM rewrites a known skill to its `$name` mention,
  which Codex finds anywhere in the message, so there the block stays in front as for any prompt,
  and any other `/…` (PPM's own `/compact` included) reaches Codex as plain text.

## The Schedules window

Every schedule of every project in one place, from the rail's footer (between the Assistant and
Logs) on a desktop and from a tile in the drawer's tool row on a phone (`open-schedules.ts`: a
floating window, or the `schedules` tab below `md`). The button carries two marks, both computed by
`src/shared/schedule-attention.ts` so the server and every view agree:

- **the count**: schedules that go out within 24 hours (on, not paused, a tick schedule whose next
  fire falls inside the window or that is due and waiting). A schedule firing every five minutes
  counts once; an always-on script never does.
- **the red dot**: a schedule that needs a look — its newest run failed, a run is still `running`
  past its `timeout_ms` (stuck), or a session schedule is paused or has waited for its chat more
  than ten minutes. A problem has a key naming that one occurrence (`failed:<run id>`,
  `stuck:<run id>`, `paused:<reason>@<updated_at>`, `waiting:<since>`); Dismiss stores the key in
  `attention_dismissed`, so the dot comes back only for a different problem, and a later run that
  succeeds clears it with no dismiss at all. Run rows stamp `started_at` in SQLite's zone-less
  `YYYY-MM-DD HH:MM:SS` (UTC); `parseStamp` reads it as UTC, where `Date.parse` would read it on
  the device's clock.

`GET /api/schedules` answers overviews (`src/services/schedules-overview.ts`): each view plus its
newest run that did something (a skipped tick is not one, and it is one indexed lookup per
schedule, since the list is polled), its registered project's name, the task it belongs to, its
next three fires as the host computes them (`next_fires`: a browser in another zone must show the
instants the host fires at, not ones it works out on its own clock), and `effective_permission_mode`
(the routes resolve it with the chat socket's own `chatTargetMode`). A session schedule's turn is an ordinary turn
of its chat, so its mode is the chat's (`session_metadata.permission_mode`, else the provider's
default) — the row's own `permission_mode` column is unused for those and reads `bypassPermissions`
by default, which is why the window never shows that column for a reminder.

The browser keeps one shared list (`src/web/stores/schedules-overview-store.ts`) that the rail,
the drawer, the window and a task's page all read: one read on mount, again on every
`schedules:changed`, a 30 s poll while the page is visible, and `now` moved on every 30 s so the
count and "in 8h 10m" stay true between reads. The pure rules of the window (filters, groups,
the words for next and last runs) are `src/web/lib/schedules/schedules-view.ts`. Times are shown
on the clock of the zone the cron is read in: a reminder kept in UK time reads "18:30 London".

## Task reminders

A reminder is a session schedule a task owns (`schedules.task_id`, migration 76). The task page's
Remind… (`task-reminder-button.tsx`) offers an hour from now, this evening, tomorrow morning or a
time of your own on a clock you pick, and posts `POST /api/tasks/:id/reminders`
(`task-reminders.service.ts`): a one-shot cron pinning minute, hour, day and month in that zone,
delivered into the project's manager chat (else the chat working on the task), refused for a time
already passed, more than a year ahead (the cron has no year) or one a DST change skips. The AI's
`session_schedule_create` links one with its `task` argument (`ppm/12`, `#12` or an id), which
must name an open task of the chat's own project (`task-reminder-link.ts`). Closing or deleting the
task deletes its reminders (`task-reminder-cleanup.ts`, on every task store change and once at
start). The task page shows them as cards (`task-reminders-card.tsx`) read from the same shared
list; the Schedules window shows each with its task's reference and opens the task from it.

## Surfaces

- REST: `src/server/routes/schedules.ts` (CRUD, `run-now`, `runs`, `dismiss`; every answer is an
  overview; `?session=<id>` lists one chat's session schedules, each with `target_title`, and
  `?task=<id>` a task's reminders), `task-reminders.ts` (`POST /api/tasks/:id/reminders`) and
  `schedules-script.ts` (`logs`, `state`, `export`, `import`).
- CLI: `ppm schedule add|list|rm|enable|disable|run-now|runs|export|import|state|set-state`;
  `add --session <id> --prompt … --cron … [--tz <zone>] [--once]` makes a session schedule;
  `edit` on one names the flags it does not use (`--project`, `--permission-mode`, `--max-turns`,
  `--timeout`: it runs on its chat's settings).
  Changes to a script schedule go through the running server, which owns the process.
- UI: Settings → Schedules (`src/web/components/settings/schedules/`): the form with its script
  editor and input declarations, the import sheet, the live log, and a status chip per row. A
  session schedule's row names its chat in the Session column; the form's kind *Chat* picks one.
  The Schedules window is `src/web/components/schedules/` (it reuses that form for New and Edit).
- AI tools: a chat's `session_schedule_create|list|delete|set_enabled|propose_script` and the
  Assistant's `schedule_propose_script` (see [Script schedules an AI proposes](#script-schedules-an-ai-proposes)).
- PPM Assistant: `schedules_list` and `schedule_get` give each schedule's own `timeZone` (marked
  `timeZoneIsMachineLocal` when it has none), `kind` and `recurring`, plus `machineTimeZone`;
  `nextFireAt` is UTC and reads right only against that zone.
- DB: migration 58 adds `kind`, `mode`, `description`, `script`, `inputs_json`,
  `input_values_json`, `secrets_enc`, `state_json` to `schedules`, plus `schedule_runtime`
  (one process per schedule), `schedule_chats` (key → chat) and `schedule_ai_turns`.
  Migration 72 adds `target_session_id`, `timezone`, `recurring`, `pending_since` and
  `paused_reason`, and rebuilds the `kind` CHECK to accept `session`. Migration 76 adds `task_id`
  (indexed) and `attention_dismissed`.
