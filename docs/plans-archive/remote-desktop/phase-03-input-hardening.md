# Phase 03 — Input hardening (scan-code / Unicode / coords / mobile)

## Context
- Research §3 input details; blocks on phase 01 input path.

## Overview
- Priority: P1.
- Make input reliable across app types (games/terminals via scan-code, IME/Vietnamese via Unicode),
  correct across DPI/multi-monitor, and usable from mobile touch.

## Scope
- Keyboard: map `KeyboardEvent.code` → VK + scan-code; send with `KEYEVENTF_SCANCODE` so
  RawInput/`GetKeyState` apps (Chrome/Electron/games/terminal) receive it (research §3). Composed
  characters (mobile keyboard, Unikey/IME) via `KEYEVENTF_UNICODE`. Modifier tracking (Ctrl/Alt/
  Shift/Win) with explicit down/up; auto-release on blur to avoid stuck keys.
- Mouse: absolute coords normalized to virtual-screen 0..65535 (`MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`),
  left/right/middle, wheel (`MOUSEEVENTF_WHEEL`), double-click timing.
- Coord mapping: canvas rect → source display rect accounting for `devicePixelRatio`, DPI scaling,
  and per-monitor offset; multi-monitor selection.
- Mobile (per `docs/design-guidelines.md`): tap=left click, long-press or 2-finger=right click,
  pinch=zoom canvas, drag with 1 finger after hold = drag; virtual key bar (Esc/Tab/Ctrl/Alt/Win/
  arrows/Enter). Full-screen sheet layout below `md:`.

## Files to CREATE / MODIFY
- MODIFY `native/remote-desktop-helper/src/*` — scan-code + Unicode + wheel + modifier release.
- CREATE `src/services/remote-desktop/input-command-schema.ts` — shared JSON schema
  (pointer/key/wheel/modifier) validated both sides; rate-limit hook.
- MODIFY `src/web/components/remote-desktop/use-remote-input-capture.ts` — code→scancode map, IME
  path, blur auto-release.
- CREATE `src/web/components/remote-desktop/use-touch-gestures.ts` — mobile gestures.
- CREATE `src/web/components/remote-desktop/virtual-key-bar.tsx` — on-screen modifier/special keys.

## Steps
1. Build `code`→VK/scan-code table; unit test round-trip for a representative key set.
2. Unicode path for `input`/composition events; ensure surrogate pairs handled.
3. Coord normalization util + tests (DPI + multi-monitor cases).
4. Touch gestures + virtual key bar; test on mobile viewport.
5. Rate-limit + input command validation server-side.

## Success criteria
- Ctrl+C/Ctrl+V, Alt+Tab, arrow keys work in a terminal and a browser.
- Vietnamese/emoji typed from mobile keyboard appears correctly.
- Click lands within 1px of target across 100%/150% DPI and on the secondary monitor.
- No stuck modifiers after window blur/close.

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| Scan-code map gaps for non-US layouts | M×M | Unicode fallback for printable chars; layout-independent scan-codes for control keys |
| Stuck modifiers | M×M | Auto-release on blur/close/heartbeat-loss |
| Touch gesture ambiguity | M×L | Explicit long-press threshold; virtual key bar for modifiers |

## Unresolved questions
1. Support non-US physical keyboard layouts in V1 or Unicode-only for printables?
2. Clipboard sync (paste large text) in scope, or type-through only?
