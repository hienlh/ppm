# Phase 04 — macOS (ScreenCaptureKit + CGEvent, TCC)

## Context
- Research §"Hệ quả 3" table; blocks on phases 01 + 03 (transport/input abstractions exist).
- macOS "service→session" model differs (launchd + loginwindow); no locked-screen control in V1.

## Overview
- Priority: P2.
- Capture the display and inject input on macOS, reusing the WS+WebCodecs transport and the
  input-command schema from phases 01/03. No SYSTEM-service equivalent for lock screen (deferred).

## Architecture
- Capture: ScreenCaptureKit (`SCStream`, modern, GPU) → BGRA/NV12 → H264. MVP fallback:
  `ffmpeg -f avfoundation -i "Capture screen 0"` (simpler, no native code) if SCK integration slips.
- Input: `CGEventPost` (CoreGraphics) via a small Rust/Swift helper or Bun FFI.
- Permissions (TCC): Screen Recording (capture) + Accessibility (input) prompts on first use;
  binary identity change on PPM upgrade can revoke → must re-grant. Detect + guide user.

## Files to CREATE
- `native/remote-desktop-helper-macos/` — SCK capture + CGEvent input (or thin ffmpeg wrapper for
  MVP capture + Rust CGEvent injector).
- `src/services/remote-desktop/remote-desktop-capture-macos.ts` — avfoundation/SCK argv + spawn
  (wrapper pattern; reuse `encoderArgs()` → `h264_videotoolbox`).
- `src/services/remote-desktop/macos-permissions.ts` — check/prompt TCC (Screen Recording,
  Accessibility); surface status to UI.

## Files to MODIFY
- Capture/input source selectors add a `darwin` branch.
- Frontend: permissions pre-flight panel (like Windows "prepare" screen).

## Steps
1. MVP capture via avfoundation + videotoolbox; verify frames decode in existing viewer.
2. CGEvent injector (abs coords, keyboard incl. Unicode); reuse input schema.
3. TCC detection + guided prompts; handle upgrade-revocation.
4. Optional: replace avfoundation with ScreenCaptureKit for perf/window filtering.

## Success criteria
- With Screen Recording + Accessibility granted: live screen + working mouse/keyboard.
- Clear UI when permissions missing or revoked after upgrade.

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| TCC revoked on binary change (upgrade) | H×M | Detect + re-prompt; document; stable code-signing identity |
| SCK native complexity | M×M | Ship avfoundation MVP first |
| No lock-screen control (loginwindow) | — | Out of scope V1; document |

## Unresolved questions
1. Ship SCK native in V1 or avfoundation-only MVP?
2. Code-signing/notarization needed for TCC stability — coordinate with phase 06.
