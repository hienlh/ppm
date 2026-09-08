# Phase 01 — Windows vertical slice (BUILD NOW)

## Context links
- Spike: `plans/reports/spike-260907-0048-remote-desktop-b-s1-windows.md`
- Research: `plans/reports/research-260905-1118-host-window-stream-control-in-ppm.md`
- Reuse: `src/services/media-transcode/transcode-stream.ts`, `ffmpeg-capabilities.ts`
- WS wiring: `src/server/index.ts:829-923`; window registry: `window-content-registry.ts:20`

## Overview
- Priority: P1 (proof of end-to-end pipe).
- Status: pending.
- Minimal end-to-end: primary display → ffmpeg gdigrab → H264 Annex-B → WS binary frames →
  frontend WebCodecs `VideoDecoder` → `<canvas>`; mouse click + key typed back over same WS →
  injected via a tiny input injector in the USER'S OWN session. NO SYSTEM service. NO lock/UAC.
- Runs in current interactive session only. Desktop-only; mobile polish deferred to phase 03/07.

## Key insights (validated)
- ffmpeg 8.0.1 present, `gdigrab` device present (verified `ffmpeg -devices`). gdigrab captures the
  whole primary display via `-i desktop`; region via `-offset_x/-offset_y -video_size`.
- Output H264 Annex-B to `pipe:1` (`-f h264`); split NAL units on Annex-B start codes; send
  binary WS frames. Send SPS/PPS + first keyframe to each new client (force with `-g`).
- MUST reuse the segfault-safe subprocess→stream pattern: wrap `proc.stdout.getReader()`, kill via
  `proc.kill()` on close; NEVER hand `proc.stdout` to a Response nor call `reader.cancel()`
  (`transcode-stream.ts:130-155`; guarded by `tests/integration/transcode-stream-client-disconnect.test.ts`).
- Encoder pick: reuse `encoderArgs()` (`ffmpeg-capabilities.ts:31`) — NVENC/QSV/AMF/libx264 with a
  zerolatency-oriented arg set (add `-tune zerolatency`/`-bf 0` for slice; keep encoder from caps).
- Input injector: SendInput on the normal desktop works from a Medium-integrity process
  (spike). Simplest path that works in user session: a tiny Rust helper binary (`windows` crate,
  `SendInput`) spawned by the service layer; Bun FFI to `user32` is an alternative but Rust helper
  is reused by phase 02+, so build it once here (KISS/DRY). Absolute coords via
  `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_MOVE` normalized to 0..65535 of virtual screen.
- `SetProcessDpiAwarenessContext` once per process (2nd call → E_ACCESSDENIED, spike gotcha).

## Data flow
```
[gdigrab primary display] --H264 Annex-B--> ffmpeg pipe:1
  --> remote-desktop-capture.ts (NAL split, keyframe cache)
  --> WS /ws/remote-desktop (binary frames)  ---> browser
      browser: VideoDecoder(H264) -> canvas
      pointer/key events --JSON--> WS
  --> remote-desktop-input.ts -> spawn/pipe rust injector -> SendInput (user session)
```

## Files to CREATE (backend, all <200 lines)
- `src/services/remote-desktop/remote-desktop-capture.ts` — build gdigrab argv (pure fn for tests),
  spawn ffmpeg via the wrapper pattern, expose an async iterator of NAL frames + cached SPS/PPS+IDR.
- `src/services/remote-desktop/nal-splitter.ts` — Annex-B start-code splitter; classify NAL type
  (SPS=7, PPS=8, IDR=5) so a late-joining client gets a decodable prefix.
- `src/services/remote-desktop/remote-desktop-encoder-args.ts` — thin wrapper over `encoderArgs()`
  adding low-latency flags; keeps gdigrab-specific args out of media-transcode.
- `src/services/remote-desktop/remote-desktop-input.ts` — spawn the Rust injector (one long-lived
  child, NOT per event — mirrors system-metrics powershell-session policy), send input commands over
  its stdin (JSON lines); map canvas coords→absolute. Guard: refuse if session not active.
- `src/services/remote-desktop/remote-desktop-session.ts` — per-connection session object (capture
  proc + injector ref + TTL timer + audit hook stub); one active session per host for the slice.
- `src/server/ws/remote-desktop.ts` — WS handler (open/message/close) mirroring `ws/terminal.ts`;
  binary out = video frames, text in = JSON `{type:"pointer"|"key"|"stop"}`.
- `src/server/routes/remote-desktop.ts` — `GET /api/remote-desktop/capabilities` (ffmpeg present?
  encoder? displays), `POST /api/remote-desktop/session` (re-auth gate → returns short-lived
  session token for the WS). Mirrors `named-tunnel.ts` guard style (`named-tunnel.ts:23-30`).

## Files to CREATE (native injector)
- `native/remote-desktop-helper/Cargo.toml` + `native/remote-desktop-helper/src/main.rs` — Rust
  binary: reads JSON-line input commands on stdin, calls `SendInput` (mouse abs move+click, key
  down/up by VK). Slice scope = normal desktop only. `SetProcessDpiAwarenessContext` once at start.
  Build script produces `bin/remote-desktop-helper-win-x64.exe` bundled into the package.

## Files to CREATE (frontend, <200 lines each)
- `src/web/components/remote-desktop/remote-desktop-window-content.tsx` — window body: opens WS,
  wires decoder, renders `<canvas>`, captures pointer/keyboard.
- `src/web/components/remote-desktop/use-h264-canvas-decoder.ts` — `VideoDecoder({codec:'avc1...'})`
  with `optimizeForLatency`, feed EncodedVideoChunk from WS frames, draw to canvas; capability guard
  (Firefox lacks WebCodecs → show message).
- `src/web/components/remote-desktop/use-remote-input-capture.ts` — pointerdown/up/move + keydown/up
  → JSON over WS; map client coords → canvas/display coords via bounding rect + devicePixelRatio.
- `src/web/components/remote-desktop/open-remote-desktop.ts` — opens the floating window (mirror
  `src/web/components/system/use-open-system-monitor.ts`).

## Files to MODIFY
- `src/server/index.ts` — add `/ws/remote-desktop` branch to fetch upgrade (after line 863 block)
  and add `type === "remote-desktop"` cases to the `websocket.open/message/close` dispatch
  (`src/server/index.ts:902-922`). Add auth: it already blocks unauthenticated `/ws/` upgrades
  (`src/server/index.ts:845`), plus require the phase-01 session token in query.
- `src/server/index.ts` (hono app) — `app.route("/api/remote-desktop", remoteDesktopRoutes)` near
  the other `app.route` calls (`src/server/index.ts:150-176`).
- `src/web/components/floating-window/window-store-types.ts:10` — add `"remote-desktop"` to
  `WINDOW_KINDS`.
- `src/web/components/floating-window/window-content-registry.ts:20-25` — register lazy component;
  add title case in `windowTitle` (`window-content-registry.ts:28`).
- A UI entry point (e.g. explorer/system menu) to open the window — smallest: reuse the same place
  system-monitor is launched from (`src/web/components/system/resolve-open-system-monitor-action.ts`).

## Implementation steps
1. `nal-splitter.ts` + unit test (pure) — feed a captured H264 blob, assert SPS/PPS/IDR boundaries.
2. `remote-desktop-encoder-args.ts` + `remote-desktop-capture.ts` — build argv (pure, tested), then
   spawn with the wrapper pattern; smoke-run ffmpeg gdigrab and confirm NALs stream.
3. `remote-desktop-input.ts` + Rust injector — build injector, spawn long-lived child, pipe a click.
4. `ws/remote-desktop.ts` — glue capture→WS binary, WS text→input; one session per host.
5. `routes/remote-desktop.ts` — capabilities + session (re-auth) endpoints.
6. Wire `src/server/index.ts` (WS branch + dispatch + app.route).
7. Frontend decoder hook + canvas + input capture + window registration + open action.
8. Manual E2E in dev UI: open window, see desktop, click a button, type into Notepad.

## Todo
- [ ] nal-splitter + test
- [ ] capture argv + spawn (wrapper pattern)
- [ ] encoder-args wrapper
- [ ] Rust injector binary + build output
- [ ] input service (long-lived child)
- [ ] WS handler + index.ts wiring
- [ ] routes (capabilities + session re-auth)
- [ ] frontend decoder + canvas + input + window kind
- [ ] manual E2E click+type

## Success criteria
- Open "Remote Desktop" window in dev UI → live primary-display video in canvas (<300ms LAN).
- Click on canvas moves the real cursor and clicks at the mapped point (normal desktop).
- Typing focuses target app and inserts characters.
- Closing the window kills ffmpeg + injector (no orphan proc; verify with tasklist).
- Re-auth required before session token issued; WS rejects missing/expired token.

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| Bun subprocess→stream segfault on Win | H×H | Reuse wrapper+`proc.kill()` (`transcode-stream.ts:130`) — mandatory, not optional |
| gdigrab exposes overlapping windows / slow at 1080p | M×M | Acceptable for slice; DXGI (phase 02) replaces it |
| Coord mapping wrong across DPI / multi-monitor | M×M | Slice = primary display only; DPI-aware once; normalize to virtual screen |
| Injector spawned per event (leak) | M×M | One long-lived child, JSON-line stdin (system-metrics policy) |
| WebCodecs missing (Firefox) | L×M | Capability guard + message; Chrome/Edge/Safari16.4 supported |
| Orphan ffmpeg on abnormal close | M×M | Session owns PID; kill on WS close + TTL sweep |

## Security (slice-level, minimal — full in phase 07)
- Re-auth: `POST /api/remote-desktop/session` requires PPM auth enabled + same-origin (mirror
  `named-tunnel.ts:23-40`), issues a short-TTL session token consumed by the WS.
- Feature flag / config gate so the slice is never live before phase-07 hardening.
- One active session per host; WS closes previous on new session.

## Next steps / dependencies
- Blocks: none. Enables phase 02 (swap capture+input to SYSTEM helper) and 03 (input hardening).

## Unresolved questions
1. Injector: dedicated Rust binary now vs Bun FFI to user32 for the slice? Plan picks Rust (reused
   later); confirm acceptable to add a Rust build step to the slice.
2. Where to surface the "open Remote Desktop" entry in UI for the slice (system menu vs command)?
3. Multi-monitor: slice = primary only. OK?
