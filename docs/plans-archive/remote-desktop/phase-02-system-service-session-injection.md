# Phase 02 — SYSTEM service + session injection (Windows)

## Context
- Spike proof: `plans/reports/spike-260907-0048-remote-desktop-b-s1-windows.md` (mốc 1-2 ✅).
- Blocks on: phase 01 (transport + WS + frontend already exist; this phase swaps the capture/input
  source from user-session ffmpeg gdigrab to a SYSTEM helper using DXGI + SendInput).

## Overview
- Priority: P1 for "works when locked".
- Goal: a Windows service running as SYSTEM, resident; on demand it launches a capture/input HELPER
  into the active interactive session so capture + input work on the NORMAL desktop even when the
  machine is LOCKED. UAC secure desktop still black/blocked — deferred to phase 06.

## Architecture / data flow
```
[PPM Bun server] --localhost/named-pipe--> [remote-desktop-service (SYSTEM, Rust)]
   service: WTSEnumerateSessionsW -> pick WTSActive session
            OpenProcessToken(winlogon/explorer) OR use SYSTEM token
            DuplicateTokenEx + SetTokenInformation(TokenSessionId)
            CreateProcessAsUserW(helper.exe, desktop="winsta0\\default")
   [helper (SYSTEM, in session)]: DXGI Desktop Duplication (fresh dup per frame to survive
            ACCESS_LOST on desktop switch) -> H264 (NVENC/QSV/VT/libx264) -> stdout/pipe
            SendInput (abs coords + scan-code/Unicode)
   service <-> helper: named pipe (frames + input cmds)
   PPM server bridges helper pipe <-> existing /ws/remote-desktop
```

## Validated mechanism (spike, cite)
- Session select: `WTSEnumerateSessionsW` + `WTSActive`; NOT `WTSGetActiveConsoleSessionId`
  (returns console-disconnected over RDP) — spike mốc 2.
- `DuplicateTokenEx` SYSTEM token + `SetTokenInformation(TokenSessionId)` +
  `CreateProcessAsUserW` places helper at SID S-1-5-18, integrity System, correct session (spike ✅).
- DXGI Desktop Duplication captures normal desktop as SYSTEM (~8MB/frame BGRA); UAC secure desktop
  returns BLACK — do not attempt UAC here (spike mốc 3 ❌).
- Fresh duplication each frame to survive `DXGI_ERROR_ACCESS_LOST` on desktop switch.

## Files to CREATE
- `native/remote-desktop-service/` (Rust, `windows` crate): service main (SCM handlers), session
  picker, token duplication, CreateProcessAsUserW, named-pipe server.
- `native/remote-desktop-helper/` extend from phase 01: add DXGI capture module + H264 encode
  (or pipe raw BGRA to a bundled ffmpeg — decide below); keep input module.
- `src/services/remote-desktop/remote-desktop-service-control.ts` — install/start/stop/query the
  service (dev: `sc create`; prod: PPM installer). Mirrors supervisor spawn discipline
  (`src/services/supervisor.ts:542`) and `ppm-dir` isolation (`ppm-dir.ts:22` — service is machine-
  global, must bail under `isIsolatedPpmHome()` like other machine-global ops).
- `src/services/remote-desktop/remote-desktop-pipe-bridge.ts` — bridge named-pipe frames/input to
  the existing WS session object.

## Files to MODIFY
- `src/services/remote-desktop/remote-desktop-capture.ts` / `remote-desktop-input.ts` — add a
  "service" source alongside the phase-01 "user-session" source; pick by capability/config.
- Packaging: bundle the two native binaries (phase 06 signs them).

## Implementation steps
1. Port spike service+helper into `native/` as maintainable crates (throwaway → real).
2. Named-pipe protocol: framed video (len-prefixed NAL) + input command channel.
3. `remote-desktop-service-control.ts`: dev install via `sc create ... type=own start=demand`,
   query state, stop; guard machine-global ops under `isIsolatedPpmHome()`.
4. Bridge pipe ↔ WS; switch frontend to service source transparently.
5. Verify capture + input while machine LOCKED and over RDP.
6. Encoder decision: DXGI→ffmpeg stdin (reuse `encoderArgs`) vs native NVENC in helper.

## Success criteria
- Service installs (one admin UAC at install), runs as SYSTEM, survives logoff/lock.
- With machine LOCKED: client sees live normal desktop (not black) and can move/click/type
  (e.g. type the Windows login password field is out-of-scope — that's secure desktop; but an app
  left on the normal desktop before lock is controllable). Document exact lock-screen behavior.
- No orphan helper after WS close; desktop-switch does not crash duplication (fresh-dup handles it).

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| AV/EDR flags CreateProcessAsUser/service as RAT | H×H | Sign binaries (phase 06); document; allowlist in dev; user consent at install |
| Public URL now drives a SYSTEM component | H×H | Phase 07 gates: re-auth, TTL, audit, per-session token, kill switch |
| DXGI ACCESS_LOST on secure-desktop switch destabilizes dup | M×M | Fresh duplication per frame; reinit on error (spike) |
| Service ↔ session token/lifetime bugs | M×H | Explicit SCM stop = kill helper; single active helper; heartbeat |
| Lock screen itself IS secure desktop (black) | M×M | Set expectation: normal desktop only; login screen not captured in V1 |

## Security
- Named pipe ACL restricted to SYSTEM + the PPM server principal; no network listener in service.
- Service exposes NOTHING to the network directly — only the PPM server (already authed) talks to it.

## Unresolved questions
1. "Machine locked" nuance: the lock screen is the secure desktop (black per spike). Confirm V1
   value = "control apps on the normal desktop when the session is disconnected/RDP", not "unlock
   Windows from phone". If unlock-from-phone is required, that needs uiAccess (phase 06) — bigger.
2. Encoder in helper (native NVENC) vs pipe BGRA to bundled ffmpeg? Latency vs bundle size.
3. Bundle & ship a second ffmpeg for SYSTEM context, or require system ffmpeg?

---
## REVISED 2026-09-07 (after research + live e2e) — see synthesis-260907-1039-phase2-remote-desktop.md
- **Success criterion "live normal desktop when LOCKED" is WRONG** — corrected. Live evidence: RDP-disconnected = NO framebuffer (gdigrab error 5); lock screen = secure desktop (black). Neither SYSTEM nor DXGI alone fixes it.
- **Disconnected (unlocked)** IS achievable by bundling a **virtual display driver** (VirtualDrivers/Virtual-Display-Driver, MIT, pre-signed) + DXGI DDA on it. Add this to phase-2 scope.
- **Input fix (was missing):** helper input thread must `OpenInputDesktop(GENERIC_ALL|DESKTOP_JOURNALPLAYBACK)`+`SetThreadDesktop` before SendInput and re-attach on every desktop switch. This is why phase-01 SendInput no-op'd.
- **Signing:** Azure Trusted Signing (~$10/mo) for exes; VDD already signed. Lock screen + UAC stay OUT of V1 (overlay).
- **Do a VDD validation spike (1-2 days) BEFORE cooking** the native service.
