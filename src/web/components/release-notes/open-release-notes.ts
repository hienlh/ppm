/**
 * Opening the release notes as a floating window. There is one set of notes, so a second open
 * focuses the window already there. Desktop only: `WindowLayer` renders nothing below `md`, so
 * a phone shows the same view in a bottom sheet instead (the caller's job — see
 * `UpgradeButton`).
 */
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";

/** Wide enough for a changelog line to read as prose, tall enough for a few releases. */
const RELEASE_NOTES_WINDOW_SIZE = { w: 760, h: 720 } as const;

export function openReleaseNotesWindow(): void {
  const store = useWindowStore.getState();
  const existing = Object.values(store.windows).find((w) => w.kind === "release-notes");
  if (existing) {
    store.focus(existing.id);
    return;
  }
  const rect = cascadeSpawnRect(Object.values(store.windows).map((w) => w.rect), store.bounds, RELEASE_NOTES_WINDOW_SIZE);
  store.open("release-notes", undefined, rect);
}
