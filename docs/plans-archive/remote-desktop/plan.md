---
title: "Remote Desktop in PPM (approach B)"
description: "Stream + control the host desktop from phone/other machine over PPM auth + Cloudflare tunnel; works when locked via a SYSTEM service."
status: in-progress
priority: P2
effort: ~10-14d (Win V1: slice ~2d + service ~3d + hardening ~3d)
branch: main
tags: [remote-desktop, windows, macos, linux, ffmpeg, webcodecs, websocket, security]
created: 2026-09-07
updated: 2026-09-08
---

> **Status 2026-09-08:** Windows V1 shipped in 0.18.15/0.18.16 (on by default behind a warning
> gate). Next: phase 04 (macOS) — see `HANDOFF.md` next to this file for the current code map,
> what in phases 04/05 is stale, and where to start on the MacBook.

# Remote Desktop in PPM — approach B (phased, Windows first)

Stream whole desktop → H264 over WS → WebCodecs canvas in a PPM window; inject mouse/keyboard
back. Works on the NORMAL desktop even when the machine is LOCKED (via a Windows SYSTEM service
that places a helper into the active interactive session). NOT clicking UAC (deferred, phase-06).

Built on validated spike facts: `plans/reports/spike-260907-0048-remote-desktop-b-s1-windows.md`
and research `plans/reports/research-260905-1118-host-window-stream-control-in-ppm.md`.

## Core decisions (from spike)
- Transport = WS + WebCodecs H264 Annex-B (NOT WebRTC — CF tunnel is HTTP/WS, no UDP).
- Capture: slice uses ffmpeg `gdigrab` (installed, 8.0.1); service phase uses Rust DXGI Desktop
  Duplication as SYSTEM (captures normal desktop even when locked; UAC secure desktop = black).
- Session placement (service): `WTSEnumerateSessionsW`+WTSActive → DuplicateTokenEx +
  SetTokenInformation(TokenSessionId) + CreateProcessAsUserW. NOT `WTSGetActiveConsoleSessionId`.
- Input: SendInput absolute coords + scan-code/Unicode. Blocked on UAC secure desktop (deferred).
- Encoder selection reuses `src/services/media-transcode/ffmpeg-capabilities.ts` (`encoderArgs`).
- Bun subprocess→stream MUST use the wrapper+`proc.kill()` pattern
  (`src/services/media-transcode/transcode-stream.ts:130-155`) — raw `proc.stdout` segfaults on Win.

## Phases
| # | Phase | Status | Blocks |
|---|-------|--------|--------|
| 01 | [Windows vertical slice](phase-01-windows-vertical-slice.md) | **done** (0.18.15) | — |
| 02 | [SYSTEM service + session injection (Win)](phase-02-system-service-session-injection.md) | pending — research says use a virtual display driver for disconnected capture, see `reports/synthesis-…-phase2` | 01 |
| 03 | [Input hardening (scan-code/Unicode/coords)](phase-03-input-hardening.md) | **partial** — scan-code keys, wheel, modifier release, mobile touch/mouse modes shipped; Unicode text + local-input yield (needs LL mouse hook) open | 01 |
| 04 | [macOS (avfoundation/SCK + CGEvent, TCC)](phase-04-macos.md) | **next** — outline only, see HANDOFF | 01,03 |
| 05 | [Linux X11 (x11grab + XTest)](phase-05-linux-x11.md) | pending — outline only, spike S2 not run | 01,03 |
| 06 | [Packaging/signing + uiAccess/UAC (future)](phase-06-packaging-signing-uiaccess.md) | pending | 02 |
| 07 | [Security hardening](phase-07-security-hardening.md) | **partial** — nonce session, origin check, auth required, warning gate; TTL/re-auth/audit log/host badge open | 01,02 |
| 08 | [Tests](phase-08-tests.md) | partial — unit (args/flag/coords/gestures) + e2e harness `tests/e2e/remote-desktop-e2e.mjs` | all |

## Cross-cutting file ownership
- Backend service module: `src/services/remote-desktop/` (new; files <200 lines, kebab-case).
- Backend route: `src/server/routes/remote-desktop.ts` (mirrors `named-tunnel.ts`).
- WS wiring: `src/server/index.ts` (add `/ws/remote-desktop` upgrade + open/message/close dispatch,
  next to existing branches at `src/server/index.ts:849-923`).
- Frontend window kind `remote-desktop`: `src/web/components/remote-desktop/` +
  register in `src/web/components/floating-window/window-content-registry.ts:20-25` and
  `WINDOW_KINDS` at `src/web/components/floating-window/window-store-types.ts:10`.
- Native helper (phase 02+): `native/remote-desktop-helper/` (Rust, `windows` crate), bundled binary.

## Key risks (see phases for mitigation)
- SYSTEM service = large attack surface over a public URL → gated behind re-auth + TTL + audit (07).
- AV/EDR may flag CreateProcessAsUser/service install as RAT behavior (spike observed risk).
- Latency over CF tunnel (+RTT). WebCodecs unsupported on Firefox → capability gate + message.

## Unresolved questions
See end of each phase file; consolidated in phase-08.
