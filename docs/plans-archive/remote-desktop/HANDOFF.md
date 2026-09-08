# Remote Desktop — handoff (2026-09-08, Windows V1 shipped → next: macOS)

Written on HIEN-PC before moving to the MacBook. Everything below is in main as of v0.18.16.
Plan files: `plan.md` + `phase-0X-*.md` in this folder; supporting reports in `../reports/`
(when read from `docs/plans-archive/remote-desktop/`, reports sit in `reports/`).

## 1. What exists (code map)

Backend `src/services/remote-desktop/` (all Windows-only today):
- `remote-desktop-capture.ts` — `buildCaptureArgs(ffmpeg, encoder)`: **`gdigrab` hard-coded**,
  `-fflags nobuffer -flags low_delay -flush_packets 1`, Annex-B H.264 to `pipe:1`.
- `remote-desktop-encoder-args.ts` — `captureEncoderArgs(encoder)` per encoder (NVENC/QSV/AMF/
  libx264), 30 fps, GOP 30, `-bf 0`, one slice per frame. **Add `h264_videotoolbox` here.**
- `remote-desktop-session.ts` — one WS session: spawns ffmpeg, NAL split → access units → binary
  frames; handles `pointer`/`wheel`/`key`/`releaseAll`/`ping`; heartbeat 30 s; backpressure drops
  to next keyframe.
- `remote-desktop-input.ts` — **Bun FFI to user32** (`SendInput`, `OpenInputDesktop` mask `0x1A1`,
  `SetProcessWindowStation`). No native helper binary. `remote-desktop-vk-map.ts` maps KeyboardEvent
  `code` → VK (client never sends `key`, layout-independent).
- `remote-desktop-flag.ts` — ON by default; `REMOTE_DESKTOP_ENABLED=0` opts a host out.
- `remote-desktop-nonce.ts`, `nal-splitter.ts`, `access-unit-assembler.ts`, `avc1-codec-string.ts`.

Routes/WS: `src/server/routes/remote-desktop.ts` (`/capabilities`, `/session` → nonce),
`src/server/ws/remote-desktop.ts` (upgrade + origin check + nonce), wiring in `src/server/index.ts`.
**`videoAvailable = platform === "win32" && ffmpeg`** at `routes/remote-desktop.ts:54` — the UI
entry hides on anything else. This is the first line to change for macOS.

Frontend `src/web/components/remote-desktop/`:
- `use-remote-desktop-connection.ts` — shared WS/nonce/ping/decoder hook (desktop + mobile).
- `use-h264-canvas-decoder.ts` — WebCodecs; **strictly monotonic timestamps** via
  `remote-desktop-frame-timestamp.ts`; auto-recreates decoder on error and resumes at next keyframe.
- `remote-desktop-window-content.tsx` (floating window) / `remote-desktop-mobile-view.tsx`
  (full-screen; touch + trackpad modes, pinch-zoom, 2-finger scroll/right-click, virtual keyboard +
  sticky-modifier key bar). Both behind `remote-desktop-warning-gate.tsx`.
- `use-remote-input-capture.ts` (desktop pointer/keys, rAF-coalesced moves),
  `use-remote-desktop-touch.ts` + `remote-desktop-touch-gesture-tracker.ts` +
  `remote-desktop-gesture-classifiers.ts` + `remote-desktop-coords.ts` (letterbox mapping).
- Entry: `open-remote-desktop.ts`; nav rail footer (desktop) / drawer "Remote" tile (mobile);
  `use-remote-desktop-available.ts` polls `/capabilities`.
- Prefs: `remoteDesktopStatsVisible`, `remoteDesktopWarningDismissed` (settings-store + server
  validator in `src/server/routes/settings.ts`).

Tests: `tests/unit/services/remote-desktop/*`, `tests/unit/web/remote-desktop-*`, e2e harness
`tests/e2e/remote-desktop-e2e.mjs` (starts 8082/5174, Chrome via CDP, checks a real non-black frame
and a cursor round-trip; `PPM_E2E_NO_SERVERS=1` to reuse your own stack).

## 2. Hard-won lessons (do not relearn)

1. **Input only reaches the live desktop from the user's own interactive session.** On Windows a
   server spawned by Claude tools (PowerShell/Bash) lands on a phantom desktop: SendInput and even
   SetCursorPos no-op while video still streams. Test input only from a server *you* start in your
   own terminal. Expect the same shape on macOS (TCC is per-process/per-binary; a helper spawned by
   an agent may not hold the grants) and Linux (`DISPLAY`/`XAUTHORITY` of the process).
2. `OpenInputDesktop` needs a valid DESKTOP_* mask — a bogus bit makes it return NULL silently.
3. WebCodecs on mobile HW decoders dies after ~1 GOP if timestamps collide within a millisecond →
   derive from frame index, not `performance.now()`.
4. A `<canvas>` flex item keeps its intrinsic capture size despite `max-*`; needs
   `min-h-0 min-w-0 object-contain`. Coordinate mapping must use the letterboxed content rect.
5. Latency: cloudflared relay adds ~200–260 ms; Tailscale direct is fast. Pipeline fixes that
   mattered: HW encoder, `-fflags nobuffer`, `-flush_packets 1`, rAF move coalescing.
6. "Yield to local mouse" via GetCursorPos was reverted — cursor lags SendInput so it false-fires
   and locks control out. Proper fix = low-level mouse hook checking `LLMHF_INJECTED`.
7. Two PPM instances: never blanket-kill cloudflared/bun; the e2e harness kills by PID only.
8. Locked screen / disconnected RDP: gdigrab returns error 5 (no framebuffer). Phase-2 research
   (`reports/synthesis-260907-1039-phase2-remote-desktop.md`) says: bundle a virtual display driver
   for disconnected capture; secure desktop (UAC/Winlogon) stays out of scope without uiAccess.

## 3. Phase 04 (macOS) — what is stale in the outline, and where to start

Stale assumptions in `phase-04-macos.md` (written before the slice):
- Says "Rust/Swift helper" for input. Prefer **Bun FFI to CoreGraphics** (`CGEventCreateMouseEvent`,
  `CGEventPost`, `CGEventCreateKeyboardEvent`, `CGWarpMouseCursorPosition`) to match the Windows
  path — no bundled binary, no signing question for the helper.
- Says "reuse `encoderArgs()` from media-transcode"; the slice has its own
  `remote-desktop-encoder-args.ts` — add a `h264_videotoolbox` branch there (`-realtime 1`,
  `-allow_sw 1`, `-bf 0`, keyframes every 30).
- Capture selector doesn't exist yet: `remote-desktop-capture.ts` hard-codes gdigrab. Split into a
  per-platform input-args function (`gdigrab` / `avfoundation -i "<screen index>"` / `x11grab`)
  and keep the shared low-latency flags.
- Key mapping is VK-based (`remote-desktop-vk-map.ts`). macOS needs `code` → CGKeyCode (ANSI
  virtual keycodes); same shape, new table. Unicode text entry (phase 03 leftover) could use
  `CGEventKeyboardSetUnicodeString` and would solve the mobile typing gap too.

Suggested first session on the MacBook (half-day spike, report-only, then cook):
1. `brew install ffmpeg`; `ffmpeg -f avfoundation -list_devices true -i ""` → find the screen index;
   check `ffmpeg -encoders | grep videotoolbox`.
2. Pipe `avfoundation → h264_videotoolbox` Annex-B into the existing session by temporarily
   returning macOS args from `buildCaptureArgs`; flip `videoAvailable` for `darwin`; confirm frames
   decode in the current viewer (Retina: capture is 2× logical — coords are fractions, so fine).
3. Grant **Screen Recording** to the terminal/bun binary; note whether the prompt appears and what
   it names. Then **Accessibility** for CGEventPost. Record which binary macOS attributes the grant
   to (bun? Terminal? the PPM binary?) — this decides the upgrade-revocation story in the plan.
4. FFI probe: does `CGWarpMouseCursorPosition` from a bun process started in your own terminal move
   the pointer? Then from an agent-spawned process? (Mirror of lesson 1.)
5. Write findings to `reports/spike-<date>-remote-desktop-macos.md`, then rewrite phase-04 as a
   cookable plan (files, steps, tests) and implement.

Open decisions carried over: avfoundation-only MVP vs ScreenCaptureKit; signing/notarization for a
stable TCC identity (ties to phase 06); whether to show the entry on hosts lacking ffmpeg with an
"install ffmpeg" message instead of hiding it.

## 4. Running locally (any OS)

```
bun src/server/index.ts __serve__ 8082 127.0.0.1 dev      # your own terminal, not an agent tool
PPM_DEV_API=http://localhost:8082 VITE_DEV_API_PORT=8082 bun run vite --port 5174
```
Auth must be enabled (`/session` returns 403 otherwise). Phone testing: kill the PWA and reopen
after each build (service worker caches the bundle). Screenshots from the Windows e2e runs are in
`plans/reports/screenshots/remote-desktop-0*.png` on HIEN-PC (not archived — binary).
