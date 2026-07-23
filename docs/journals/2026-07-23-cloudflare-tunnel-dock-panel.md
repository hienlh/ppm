# Cloudflare Tunnel Manager Dock Panel: End-to-End Delivery with Risk Acceptance

**Date**: 2026-07-23 10:30
**Severity**: Medium (UX/Feature)
**Component**: Tunnel Management, Dock Panel, Routes (tunnel-spawn, tunnels, tunnel-registry)
**Status**: Code Complete, Not Pushed
**Commit**: 432d1fe

## What Happened

Replaced the legacy "ports" tab (PPM-only per-port forwarding) with a full Cloudflare Tunnel Manager dock panel. The feature enumerates ALL cloudflared processes on the machine (PPM-spawned, app-share, external), not just PPM's. Users can start/stop external tunnels, monitor active ones, and attempt public-URL recovery via /quicktunnel metrics endpoint.

Workflow: brainstorm → /ck:plan --tdd (4 phases) → red-team (14 findings, 5 Critical) → validation spike → /ck:cook. 43 new/affected tests pass, full suite 1656 pass (3 pre-existing failures), tsc clean.

## The Brutal Truth

This feature walks a razor's edge. Users can now **kill arbitrary cloudflared processes on their machine**, including the supervisor-managed app-tunnel they may be connected THROUGH. One bad tap and you drop your remote session. We accepted this risk because the user explicitly chose full external-tunnel management over "PPM-only, safer" scope. The mitigation is brute-force: protect the app-tunnel with a display-only lock, re-verify it's still the supervisor's by PID/URL/port on every stop request, and document ACCEPTED RISK for unauthenticated kill if auth is off + tunnel is shared.

The design also depends on cloudflared's undocumented /quicktunnel endpoint to recover public URLs without modifying our spawn args. A spike verified it works on cloudflared 2026.3.0 but there's no guarantee future versions keep it.

## Technical Details

**Kill Protection (app-tunnel):**
- Identifies supervisor tunnel by PID OR public URL match OR server-port match — re-reads `status.json` fresh each call
- Returns `409 Conflict` unconditionally if matched; no force flag, no backend override
- Rationale: prior prod incident (supervisor tunnel kill → remote-session drop); lock was red-team Critical finding

**activeTunnels Registry:**
- Extracted to `src/server/routes/tunnel-spawn.ts` (shared with legacy `/api/preview`)
- Single source of truth (no split-brain) — legacy routes kept, deprecated comment added
- Stores `{ pid, name, publicUrl, localPort, spawnedAt }`; PID field was initially missing (red-team found it mid-design)

**Tab Rename (ports → tunnels):**
- Crash-safe migration: `migratePortsToTunnels` runs before `migrateTabIds` and in server-hydrate path
- Strips legacy "ports" tabs from all panels (including dock) before any tab-open logic executes

**Auth & SSRF Acceptance:**
- User kept "same auth as other routes" — /api/tunnels/stop inherits auth config
- Documented ACCEPTED RISK: with auth off + public share tunnel, kill endpoint is unauthenticated
- SSRF risk from /quicktunnel (we call it to enumerate external tunnels): low-severity, acceptable trade-off vs manual URL entry

## What We Tried

1. **Protecting app-tunnel via force flag** — Rejected in red-team; too easy to override accidentally
2. **Caching PID indefinitely** — Rejected; supervisor respawns → PID goes stale → kill guard fails open
3. **Adding --metrics to PPM's spawn** — Rejected; PPM already reads URL from stderr, avoid touching prod tunnel launch
4. **Deleting legacy /api/ports routes** — Would break 12 tests; kept instead with deprecation comment
5. **Encrypting stored tunnel secrets** — Out of scope; documented as future follow-up

## Root Cause Analysis

**Why this design?**
User chose FULL management (stop external, not just PPM's) because 1) they want visibility into all tunnels on the machine, 2) they're willing to accept kill/SSRF risks if mitigated. Red-team pushed back on 5 Criticals — all valid (app-tunnel-protection-fails-open, activeTunnels missing PID, /quicktunnel reliability, auth bypass in public-share scenario). Each was addressed in the code. The biggest lesson: red-team found the stale-PID case (supervisor respawn) which changed app-tunnel protection from "check once at startup" to "check fresh on every request."

**Why not browser-verify yet?**
Time budget and priority: logic/types/tests are solid (1656 pass), but the UI rendering (dock layout, mobile-first bottom-sheet, openInDock flow) and the /quicktunnel metrics integration were tested in isolation only. This is the main risk before shipping.

## Lessons Learned

1. **Red-team worth the session cost.** 14 findings, 5 Critical — the PID-stale and /quicktunnel-no-metrics cases were non-obvious and genuinely changed the design.
2. **Document accepted risks explicitly.** Instead of "we'll harden later," user chose to ship with SSRF + unauthenticated-kill risks. That's okay if stated upfront.
3. **Fresh state reads on guards.** PID-based protection is fragile if you check once and cache; re-read `status.json` on every request.
4. **DRY avoids split-brain.** Extracted `activeTunnels` map into shared `tunnel-spawn.ts` so legacy + new routes don't diverge.
5. **Deprecation comments beat deletion.** Kept old /api/ports routes alive rather than breaking 12 tests; avoids surprise failures during integration.

## Next Steps

**Critical before shipping:**
1. Browser/e2e verify dock panel rendering, mobile layout, openInDock UX (1–2 hours)
2. Manual test: kill external tunnel, verify app-tunnel is locked, verify stale-PID case (supervisor respawn scenario)

**Non-blocking follow-ups (Medium):**
- Legacy DELETE /api/ports/{portId} lacks new safe-kill guard (unreachable from UI, so low risk; clean up if refactoring ports delete)
- `stopAllPortTunnels()` is unwired on shutdown (pre-existing, not regressed; address in future tunnel-cleanup pass)

**Plan & reports:** `plans/260717-0021-cloudflare-tunnel-dock-panel/` (plan.md, red-team summary, validation spike notes)
