# Phase 07 — Security hardening

## Context
- Research §4 + spike §Bảo mật. This is remote control over a PUBLIC URL (Cloudflare tunnel) — the
  highest-risk feature in PPM. Blocks on phases 01 + 02 (things to protect exist).

## Overview
- Priority: P1 before any broad enablement. Slice ships gated (feature flag) until this lands.

## Controls
1. Re-auth on open: `POST /api/remote-desktop/session` requires PPM auth ENABLED + same-origin
   (mirror `named-tunnel.ts:23-40`); user re-supplies the PPM token/password; issues a short-TTL,
   single-use session token consumed at WS upgrade. PPM auth is a static Bearer token
   (`src/server/middleware/auth.ts:20-24`) — re-auth = re-enter it, do not cache silently.
2. Session TTL + idle timeout: server auto-closes session; WS heartbeat; explicit `stop`.
3. "Being controlled" badge on host: a visible always-on-top indicator + one-click KILL on the host
   (tray/notification/floating badge), independent of the controlling client.
4. Audit log: append session start/stop, controller identity, input-event counts (not payloads) to a
   log service (reuse pattern of `src/services/session-log.service.ts`); queryable.
5. Block paired-device/bot control: only the human owner may start a session; refuse SDK/bot-issued
   starts; rate-limit input WS.
6. Self-protection: refuse to inject into PPM's own / supervisor windows (reuse
   `src/services/system-metrics/ppm-protected-pids.ts` concept) to avoid self-sabotage.
7. UAC/secure-desktop overlay: detect `consent.exe` via EnumWindows (spike: not a foreground
   window) → show overlay "UAC open, cannot stream/control — handle at the machine" instead of a
   black frame; disable input while secure desktop active.
8. Refuse-when-locked messaging (pre-service) / clear state (post-service): explicit status, never a
   silent black screen.

## Files to CREATE / MODIFY
- CREATE `src/services/remote-desktop/session-token.ts` — mint/verify short-TTL single-use tokens.
- CREATE `src/services/remote-desktop/remote-desktop-audit.ts` — audit entries.
- CREATE `src/services/remote-desktop/secure-desktop-detect.ts` — consent.exe/secure-desktop probe
  (native helper reports it; server decides overlay).
- CREATE `src/web/components/remote-desktop/being-controlled-badge.tsx` + host kill control.
- CREATE `src/web/components/remote-desktop/uac-overlay.tsx`.
- MODIFY `routes/remote-desktop.ts`, `ws/remote-desktop.ts`, session object — enforce all controls.

## Steps
1. Session-token mint/verify + WS enforcement + TTL/idle.
2. Same-origin + auth-enabled guard on session creation.
3. Audit logging + input rate-limit.
4. Host badge + kill switch (works even if client is gone).
5. consent.exe detection → overlay + input disable.
6. Self-protection PID guard.

## Success criteria
- Cannot start a session without re-auth; expired/replayed token rejected by WS.
- Host always shows a badge while controlled; host-side kill ends it immediately.
- Audit log records every session + counts; bot/SDK start attempts refused.
- UAC open → overlay (not black), input disabled; normal desktop resumes cleanly after.

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| Token replay / theft over tunnel | M×H | Single-use short TTL, same-origin, TLS via tunnel, idle close |
| Silent control (no host awareness) | M×H | Mandatory badge + host kill switch |
| Injecting into PPM/system windows | M×M | Protected-PID guard |
| Audit gaps for forensics | M×M | Log start/stop/identity/counts before enabling broadly |

## Unresolved questions
1. Host badge surface: tray icon, OS notification, or an always-on-top helper window?
2. Should re-auth require the password every session, or a per-device confirmation with TTL?
3. Consent flow when starting: notify + require host-side accept, or owner-token only?
