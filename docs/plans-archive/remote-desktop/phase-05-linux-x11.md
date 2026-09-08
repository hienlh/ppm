# Phase 05 — Linux X11 (x11grab + XTest)

## Context
- Research §"Hệ quả 3"; spike S2 (Linux) not yet run — needs a real Linux VM (NOT WSL, per user).
- Blocks on phases 01 + 03. X11 first; Wayland deferred (hardest — PipeWire portal + libei).

## Overview
- Priority: P3.
- Capture X11 display and inject input via XTest, reusing WS+WebCodecs + input schema.

## Architecture
- Capture: `ffmpeg -f x11grab -i :0.0` → H264 (reuse `encoderArgs`; NVENC/QSV/libx264).
- Input: XTest (`XTestFakeMotionEvent`/`XTestFakeButtonEvent`/`XTestFakeKeyEvent`) via `xdotool`
  spawn (MVP) or Rust FFI to libXtst (preferred, reused pattern).
- No secure-context/lock-screen control (greeter/polkit on separate display) in V1.

## Files to CREATE
- `src/services/remote-desktop/remote-desktop-capture-linux.ts` — x11grab argv + spawn (wrapper).
- `native/remote-desktop-helper-linux/` (Rust libXtst) OR `linux-input-xdotool.ts` (MVP spawn).

## Steps
1. x11grab capture → existing viewer.
2. XTest injection (abs motion + buttons + keys + Unicode via keysym remap).
3. Detect X11 vs Wayland session; Wayland → clear "X11 only in V1" message.

## Success criteria
- On an X11 desktop: live screen + working mouse/keyboard.
- Wayland detected → graceful unsupported message (no black screen).

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| Wayland common on modern distros | H×M | Detect + message; Wayland is a later phase |
| XTest keysym mapping gaps | M×M | Unicode/keysym remap; xdotool fallback |
| Spike S2 not yet run | M×M | Run S2 on a real Linux VM before committing native code |

## Unresolved questions
1. Run Linux spike S2 (real VM) before this phase? (Recommended.)
2. xdotool spawn MVP acceptable, or go straight to libXtst FFI?
