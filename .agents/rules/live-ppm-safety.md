---
trigger: always_on
---

# The live PPM on this machine

PPM runs here as `ppm.service` (`dist/ppm`, port 3210), and the chats in it (Claude, Codex, Antigravity) are the user's work in progress.

## Restart only when the user asked for it

Do not run `ppm restart`, `ppm stop`, `systemctl --user restart|stop ppm.service`, or signal the supervisor unless the user asked for a restart in this conversation. A restart cuts every chat running in PPM mid-turn, yours too when you run inside PPM.

- Never stop PPM to build: `bun run build` can overwrite the running `dist/ppm`.
- A frontend-only change needs no restart: the web bundle is served from disk. New server code does.
- Never `stop` from a chat started in PPM: that chat runs inside `ppm.service`, so the stop kills your own shell and PPM stays down.
- When a restart is asked for, make it your last step, then check it (see `build-ppm.md`).

Why: on 2026-11-06 PPM was restarted about ten times in one day from a chat, and every restart closed every open chat.

## Never write to `~/.ppm` from a script

Do not change `~/.ppm/ppm.db`, or any file in `~/.ppm`, with `bun -e`, `sqlite3`, a script, or anything that imports `src/`. Go through the `ppm` CLI or PPM's HTTP API. Experiments get a scratch home: `PPM_HOME=$(mktemp -d) bun my-script.ts`.

`src/services/prod-db-guard.ts` only stops code that imports `src/`; opening the file with `bun:sqlite` or `sqlite3` bypasses it. A throwaway script once blanked the auth token and deleted every project (`docs/lessons-learned.md`).

Why: on 2026-11-06 a chat ran `UPDATE session_metadata …` on the live database through `bun -e`.
