# Live verification — Remote Desktop V1 phase-01 (Windows vertical slice)

**Date:** 2026-09-07 · **Branch:** `feat/remote-desktop-slice` · **Commit:** `0c4c1a66`
**Plan:** `plans/260907-0100-remote-desktop-v1/phase-01-windows-vertical-slice.md`
**Red-team:** `plans/reports/redteam-260907-0100-remote-desktop-v1.md`

## Result

**A real host-desktop frame rendered inside PPM's Remote Desktop window.** Confirmed both
visually (screenshot below shows live desktop icons, an open PowerShell with real command
history, an Explorer window, taskbar clock) and via pixel sampling of the decoded canvas:

- `mean=33.34`, `variance=2170.47`, size `1148x720` — a black/blank canvas would read
  `mean≈0, variance≈0`; a flat color would read `variance≈0`. This is a genuine, changing
  desktop image (two consecutive screenshots ~1s apart show CPU/MEM readouts tick over).

1b (synthetic input round trip) did **not** move the real host cursor — see "1b input result"
below; root-caused to an environment constraint independent of the remote-desktop code.

## Screenshots

- `plans/reports/screenshots/remote-desktop-01-initial-window.png` — window opens from the
  status bar, "Connecting…" overlay, before the WS config message arrives.
- `plans/reports/screenshots/remote-desktop-02-live-frame.png` — **live host desktop
  rendering inside the PPM window** (first real frame).
- `plans/reports/screenshots/remote-desktop-03-after-input.png` — same live stream ~1s later
  (CPU/MEM readout changed 31%/26.2G → 25%/27.1G, confirming continuous streaming), taken
  right after the 1b input attempt.

## Environment blocker that delayed this (now resolved by the user)

The harness's own Windows session (session 2, user `PC`) was `Disc` (Terminal-Services
disconnected) for most of this run. gdigrab's BitBlt capture returned `Failed to capture
image (error 5)` (`ERROR_ACCESS_DENIED`) against that disconnected session — reproduced
directly with the service's own `buildCaptureArgs()` output, independent of PPM (ffmpeg exit
code 234, same stderr). This is a documented Windows limitation (GDI screen capture is
blocked against a disconnected RDP-style session), not a code bug — nothing in the capture
service could route around it. No admin rights were available to force a reconnect
(`tscon`), and obtaining/using Windows login credentials to force a loopback RDP connection
was correctly out of scope. Once the user reconnected an RDP client to session 2 (`query
session` → `Active`), the exact same code path produced a real frame within seconds — this
confirms the capture pipeline itself was correct all along; the only precondition was an
attached interactive session, which the plan already assumed ("current interactive session
only").

## Bugs found and fixed while getting to a live frame (all in this commit)

1. **`remote-desktop-encoder-args.ts`** — `-tune zerolatency` turns on x264's sliced-threads,
   splitting one picture into multiple slice NALs; `access-unit-assembler.ts` treats every
   VCL NAL as a new access-unit boundary, so a multi-slice picture would become several
   partial-picture "access units" WebCodecs can't decode. Fixed by forcing
   `-x264-params sliced-threads=0:slices=1` (flagged by code review before this was hit live).
2. **`remote-desktop-session.ts`** — `releaseAll`/`close()` only force-released the fixed
   modifier VK list, never the arbitrary keys tracked in `heldKeyCodes` — a held letter/digit
   key stayed logically down on the host after a lost keyup (blur, WS drop). Added
   `releaseHeldKeys()` which injects a real keyup for every tracked code, then still runs the
   modifier backstop.
3. **`remote-desktop-capture.ts`** — the ffmpeg-crash warning (and now the client-facing error
   message) was gated on `!proc.killed`, intended to mean "we didn't call `stop()`
   ourselves." Verified empirically that Bun sets `proc.killed = true` even when ffmpeg exits
   on its own with a nonzero code (the gdigrab access-denied crash: exit code 234,
   `killed: true`, `stop()` never called) — this silently swallowed the exact diagnostic
   needed to root-cause the blocker above. Replaced with the service's own `stopped` flag,
   read *before* it gets set for this exit, which correctly distinguishes "we asked it to die"
   from "it died on its own."
4. **`remote-desktop-session.ts`** — wired that `reason` through: a capture crash after
   startup previously closed the WS with no explanation (client saw a bare "Disconnected"); it
   now sends `{type:"error", message:"Capture failed: ..."}` first, which the frontend already
   knew how to render (`remote-desktop-window-content.tsx`'s existing `error` handling) but
   never received.
5. **`remote-desktop-ws-url.ts` + `remote-desktop-window-content.tsx`** — the dev-mode WS
   bypass hardcoded port 8081; a second dev stack on an alt port (needed here since 8081/5173
   already belonged to another running dev session) would silently connect its WS to the
   *wrong* backend. Added a `devPort` parameter (default `8081`, preserves current behavior)
   driven by `import.meta.env.VITE_DEV_API_PORT`.
6. **`remote-desktop.ts` (routes)** — `POST /api/remote-desktop/session`'s same-origin guard
   compared the full `host` (hostname:port) of `Origin` vs the request URL. This rejects
   *every* request in the standard two-process dev topology (`bun dev:web` proxying to `bun
   dev:server` on a different port): Vite's dev proxy rewrites the `Host` header to the proxy
   target's port without adding `X-Forwarded-Host`, so the backend never sees the browser's
   real port. Verified with a temporary diagnostic log (`origin=…:5174`, `hostHeader=…:8082`,
   no `x-forwarded-host`) before fixing. Relaxed the comparison to hostname-only — a
   cross-origin attacker cannot spoof `Origin` to say `localhost` in the first place, so this
   does not weaken the actual protection. **Note:** `named-tunnel.ts` has an apparently
   identical full-host comparison (same guard style this file was told to mirror) — not fixed
   here (different file, out of this task's ownership), but likely has the same standard-dev
   breakage and is worth a follow-up look.

## 1b input result — best-effort, root-caused as environmental (not a code bug)

Sending a real pointer click (both via the actual browser UI path and via a raw WS message
bypassing the browser entirely) did not move the host's real cursor
(`GetCursorPos`/`Cursor.Position` read the identical coordinate before and after in every
trial). Isolated with a standalone script calling `user32!SendInput` directly (no PPM
involved): `SendInput` returns `1` (success, one event accepted) but the cursor genuinely
never moves. This points to the harness's own process tree (and therefore the PPM
server/ffmpeg it spawns) not being attached to the interactive input desktop/window station
for `SendInput` purposes, even though the session itself is active and GDI *reads* (gdigrab)
now succeed — a `SendInput`-specific restriction distinct from the gdigrab blocker above. No
further attempts were made to force this (would require elevation or window-station changes
outside this task's scope); flagging as a known gap for phase-02/03 (SYSTEM-service input
path) rather than something fixed here.

## Harness

`tests/e2e/remote-desktop-e2e.mjs` (new, committed) — adapts
`tests/e2e/system-monitor-e2e.mjs`'s raw-CDP-headless-Chrome pattern. Runs its own stack on
8082 (`REMOTE_DESKTOP_ENABLED=1`) + 5174 so it never touches the 8081/5173 dev stack already
running. Verifies: capabilities → status-bar button → window opens → WS reaches
`streaming` → canvas pixel stats clear a non-black/non-flat threshold → best-effort input
round trip via the host's actual cursor position (not just DOM state, since this harness runs
on the same machine gdigrab captures).

Final run (session active): **4/5 scenarios passed** — only the 1b input scenario failed, for
the environmental reason above.

## Teardown

Own stack (server PID on :8082, vite PID on :5174) killed by exact PID via `taskkill /T /F`
after the run; confirmed both ports free and no orphan `ffmpeg.exe` process left running.
Did not touch the pre-existing 8081/5173 stack.

## Uncommitted / follow-up

- Nothing uncommitted from this session (all 7 files in `0c4c1a66`).
- Follow-up worth a separate look: `named-tunnel.ts`'s same-origin check likely has the same
  full-host-vs-hostname bug fixed here for remote-desktop.
- 1b (`SendInput` not reaching the desktop from this process tree) is unresolved and
  environmental — flag for phase-02/03 design (SYSTEM-service input path may sidestep it, or
  may hit the identical restriction and need explicit handling).
