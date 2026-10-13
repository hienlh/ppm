# Script schedules

A script schedule runs JavaScript in a child process of the server, one child per schedule.
`harness-source.ts` is the child's whole program; `script-process.ts` is the server's side of
it; `instance-guard.ts` makes sure there is never a second one.

## Gotchas

- **Bun's IPC `disconnect` does not fire in the child when the parent is SIGKILLed** — measured
  with `Bun.spawn({ ipc })`, the child kept running as an orphan. The parent's death is seen
  through stdin instead: the server holds the child's stdin open and never writes to it, and the
  harness's `for await (Bun.stdin.stream())` ends the moment the server dies, however it dies.
- **A script that blocks its event loop never reads that EOF**, so a Worker in the child checks
  every 250 ms that the server is still its parent and SIGKILLs the child when it is not. It
  reads the parent from `/proc/self/stat`: inside a Worker, Bun's `process.ppid` is read once
  and cached — a watchdog that trusted it kept seeing the dead parent forever (measured, and it
  is what the busy-loop orphan test catches). Off Linux it asks `process.kill(parent, 0)`,
  which a zombie parent still answers until it is reaped. The harness waits for the Worker to
  report in before running the script: a Worker created right before a busy loop never starts.
- **A test of the watchdog must let it see the living parent first** (the orphan tests sleep
  700 ms before the SIGKILL). Kill the parent within the first 250 ms and the cached
  `process.ppid` is already the new one, so even a broken watchdog passes.
- **The harness is a `String.raw` string run with `--eval`**: a compiled `ppm` cannot spawn a
  file embedded in itself, but with `BUN_BE_BUN=1` it runs `--eval` like bun (as
  `db-driver-install.ts` does). Keep `${` and backticks out of it; the Worker's code is a
  function turned into source with `toString()` for the same reason.
- **Never let a child inherit `NOTIFY_SOCKET`** (`childEnv`): a child holding it once told
  systemd PPM was stopping.
- **Secrets are masked before a line is cut**, never after — a cut first can leave half a
  secret showing that the masker no longer recognises.
- **Recorded pids outlive reboots.** `reconcileLeftovers` therefore proves a leftover is ours
  (the token in `/proc/<pid>/environ`, or `ps -E` on macOS) before killing it; a process of
  someone else's at that pid is forgotten, and one it cannot judge blocks its schedule instead
  of risking a second instance.
- **`ctx.ai.chat` goes through the chat WebSocket handler, not `chatService.sendMessage`**
  (`chat-loopback.ts`): only the handler sets the session's phase, which is how a turn is busy,
  shows live, and rotates accounts like any chat. The loopback socket carries
  `data.origin = "scheduler"` so the trace and the cancel are not recorded as the browser's.
  It cannot close under the turn the way the bots' real socket could, so a turn that ends
  without `done` (session deleted, stream torn down) is caught when the phase returns to idle,
  and a message the handler dropped without starting anything (empty content, a failed resume)
  when `message()` returns with the phase never having moved.
- **The mock provider cannot take a second message while its last turn winds down**: it has
  no `pushMessage`, so a message arriving before its consumer loop ends is dropped and the turn
  "ends without a result". Tests give each failing turn its own session; Claude keeps its
  stream open between turns and is not affected.
- **A key is bound to its chat when the message goes out, not when the turn ends**: bound
  only at the end, two `wait: false` calls for a new key opened two chats. `settle` then names
  the chat or, when a new chat's first turn wrote nothing, deletes it and forgets the key.
- **`maxTurns` is refused on a script schedule**: the SDK's turn cap is per query, i.e. per
  chat process, which a script's turns share with whoever else chats there.
- **A script's `running` run row can be hours old and still be right**: it is the life of an
  always-on process. `cleanupScheduleRuns` (2 h orphan rule) therefore skips script schedules;
  `AlwaysOnSupervisor.prepare` closes their leftovers as `done` (ended with the server, not
  failed), and a graceful shutdown closes them itself with the log so far.
- **No script starts before `prepare()` has settled the previous server's children**: the
  scheduler chains tick fires and every `sync()` on that promise (`ready`). A change made in
  the first seconds after boot waits for it too.
- **Delete an always-on schedule in this order: turn it off, `await alwaysOnSupervisor.stop(id)`,
  then delete the row.** While it stops, any other route's `rearm()` runs `sync()`, which sees an
  enabled schedule and turns the stop into a restart.
- **A script tick keeps a run row only when it logged or failed**, and never a `skipped` row: a
  5-second tick would bury the history. Prompt schedules keep both, as before.
- **Every `/api/schedules` answer goes through `toScheduleView` (`scheduler-view.ts`)**: a raw
  row carries `secrets_enc` and `state_json`, and the state can hold a token. The route test
  scans every GET for the secret, its ciphertext and both keys; a new route must answer a view.
- **A save rewrites a secret or an input value only when it changed** (`scheduler-edit.ts`):
  encryption takes a fresh IV and a merged object can come out in another key order, and either
  changes the always-on fingerprint — every save of an untouched form restarted the process.
  Declarations are saved through `normalizeInputs` for the same reason.
- **PATCH checks the whole definition only when the body touches a definition field**, so an
  enable or a rename still works on a row saved before today's rules (a 6-field prompt cron, a
  timeout over 6 h).
- **Never show a JSON parser's message for a file that may hold a token**: it quotes the text
  it stopped at, whole when that text is one identifier (`Unexpected identifier "ghp_…"`). The
  template parser and `ppm schedule set-state` say only "not JSON".
- **The CLI changes a script schedule through the server** (`viaServer` in `schedule-cmd.ts`):
  only the server can stop its process before the row goes. With no server running there is no
  process, and the old database path is used.
- **The log ring's numbers restart with the server**: `/logs` answers `last`, and a client whose
  own number is higher reads again from 0.
