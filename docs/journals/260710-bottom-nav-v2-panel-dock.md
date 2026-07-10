# Bottom Nav v2 + Generalized Panel Dock — 0.15.0

**Date:** 2026-07-10 · **Plan:** `plans/260708-2055-bottom-nav-v2-panel-dock/` · **Released:** `@hienlh/ppm@0.15.0`

## What shipped
Redesigned two coupled areas from a high-fidelity design handoff, delivered as one release (8 planned phases, TDD where a DOM-free unit could carry the logic).

- **Mobile bottom nav v2** — scrolling tab strip → single current-tab button opening a searchable tab-switcher bottom sheet grouped by split panel (activate/close per row, long-press → existing tab action menu). `+` opens the command palette (reused, not the handoff float-top). Terminal button with running-session green dot toggles the dock sheet (expand/collapse 60↔92%, `^C` added to the existing terminal key toolbar).
- **Generalized panel dock** — the terminal dock became position-configurable (left/bottom/right, persisted per-user in settings-store) with a pill header (type icons, `+N` overflow on vertical layouts, position dropdown, maximize/hide, per-pill close). Position/maximize state (`dockExpanded`) is session-only.
- **Desktop status bar** — a 22px bar that was *defined but never mounted*; now the sole panel toggle (`PanelBottom` + count) + CPU/MEM (moved from sidebar) + version. Sidebar/rail/tab-bar dropped their toggles + resource strip + version line.

## Key decisions
- Logic extracted into DOM-free pure helpers (`dock-layout`, `dock-pills`, `dock-tabs`, `tab-switcher-groups`) so it's unit-testable — the repo has **no DOM/render harness**, so component behavior was verified in a real browser (headless Puppeteer) instead.
- `dock.position` lives per-user (settings-store); `visible`/`height` stay per-project (no regression). `dockExpanded` session-only.

## Hard-won fixes (all root-caused via headless-browser + localStorage inspection)
1. **Black screen on dock toggle** — the maximize `useEffect` called `Panel.resize()` on dock-open before react-resizable-panels registered the layout → threw `"Layout not found"` → crashed the tree. Dropped imperative resize; **key the outer `<Group>` on `position-expanded`** so maximize/position re-apply the mount-only `defaultSize` via a clean remount. Live xterm survives (it lives in TabPool, only reparented).
2. **Re-dock into empty dock stuck** (pre-existing bug) — `closeTab`'s empty-panel auto-close lacked a `!== DOCK_PANEL_ID` guard, so closing the last dock terminal *deleted* the reserved `__dock__` panel; a later grid re-dock then `moveTab`'d into a missing panel (silent no-op) while an empty dock opened. Added the guard (mirrors `moveTab`).
3. **UX:** dock never shows an empty state — opening empty auto-opens a terminal; closing the last terminal auto-hides the dock.

## Lessons
- **react-resizable-panels v4:** `defaultSize` is mount-only; bare-number sizes = pixels (use `%` strings); calling `resize()` mid-commit before layout registration throws. Keyed remount is the reliable way to re-apply size.
- Store-singleton unit tests must reset shared state (`__dock__`) in `beforeEach` — pollution across tests gave false failures.
- Importing a store that reads `localStorage` at module-init breaks unstubbed tests; used `get().currentProject` instead of importing project-store into dock-actions.

## Verification
- 1589/1589 unit tests pass; `tsc --noEmit` clean.
- Headless browser e2e: toggle/maximize/restore, left↔bottom↔right position flips (PTY survives), status-bar toggle, mobile nav/switcher, dock pill close, empty-dock auto-open/close — all 0 page errors.

## Open follow-ups
- Minor: mobile green-dot count uses panel-store `currentProject`; desktop dock header uses project-store `activeProject.name` — equal in practice, unify later.
- Desktop dock left/right + xterm across real long-running sessions verified via headless PTY continuity, but not on a physical multi-monitor setup.
