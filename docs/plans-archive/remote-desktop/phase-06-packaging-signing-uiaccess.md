# Phase 06 — Packaging / signing + uiAccess (UAC control, FUTURE)

## Context
- Spike conclusion: clicking UAC requires `uiAccess=true` — a flag separate from integrity, granted
  only to a code-SIGNED binary with a uiAccess manifest installed under Program Files. TeamViewer/
  AnyDesk have this; they still cannot stream UAC pixels (overlay instead). NOT in V1.
- Blocks on phase 02 (service/helper binaries exist to sign).

## Overview
- Priority: P3 (future). Two parts: (a) production packaging + code-signing of native binaries
  (needed anyway for AV trust + macOS TCC stability), (b) uiAccess-enabled helper to click UAC.

## Scope
- Packaging: bundle `remote-desktop-service` + `remote-desktop-helper` (+ mac/linux) with PPM;
  installer registers the Windows service (interactive install — spike: silent elevate is
  auto-cancelled from a non-interactive process).
- Code-signing: Authenticode (Win) + Developer ID/notarization (mac). Reduces AV/EDR flags and
  stabilizes macOS TCC across upgrades.
- uiAccess (future, opt-in): signed helper + `uiAccess="true"` manifest + install under
  `%ProgramFiles%` → allowed to `SetForegroundWindow`/SendInput onto higher-integrity/UAC. Still
  cannot capture UAC secure-desktop pixels → show an overlay + let user click "Yes" blind-mapped or
  via a confirmation button. Requires purchasing a code-signing cert.

## Files
- `native/**/build scripts` → signed artifacts under `bin/`.
- Installer integration (PPM install flow) — service register + binary placement in Program Files.
- `remote-desktop-service-control.ts` — production install path (vs dev `sc create`).

## Steps
1. Build + sign native binaries; verify AV no longer flags on a clean machine.
2. Installer: place binaries in Program Files, register service interactively.
3. (Future) uiAccess manifest + signed helper; UAC overlay UX; consent flow.

## Success criteria
- Clean-machine install without AV block; service auto-managed.
- (Future) uiAccess helper can click a UAC "Yes" (pixels remain overlay, not real).

## Risks
| Risk | L×I | Mitigation |
|------|-----|-----------|
| Code-signing cert cost/procurement | M×M | Business decision; required for AV + TCC + uiAccess |
| uiAccess still cannot show UAC pixels | — | Overlay UX; set expectation |
| Program Files install friction | M×L | Interactive installer, clear consent |

## Unresolved questions
1. Buy a code-signing cert now (helps AV + macOS even without uiAccess)? Business decision.
2. Is clicking-UAC-from-phone actually needed post-V1, or is "avoid UAC" (research option C) enough?
