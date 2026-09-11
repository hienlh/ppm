/**
 * Turns the host's raw mode list into the menu RustDesk's `_ResolutionsMenu` shows.
 *
 * The raw list is per *timing*, not per resolution: this dev host advertises 37 modes across 15
 * distinct sizes (seven separate 1920x1080 entries alone). A menu of 37 rows is unusable and
 * says nothing a remote user wants to decide, so they collapse to one row per size.
 *
 * Which one survives the collapse is the part that is easy to get wrong. Keeping the highest
 * refresh looks obviously right — and then a host sitting on 3440x1440@60 while it also
 * advertises @100 has *nothing* ticked in the menu, because the id that is live was dropped.
 * So `current` wins within a group and the refresh only breaks the remaining ties.
 */
import type { HostMode } from "./use-remote-desktop-readiness";

/** One row of the resolution menu. */
export interface ResolutionChoice {
  /** The mode id to ask the host for. */
  id: string;
  width: number;
  height: number;
  refresh: number;
  current: boolean;
  preferred: boolean;
}

/** One row per distinct size, largest first. */
export function resolutionChoices(modes: readonly HostMode[]): ResolutionChoice[] {
  const bySize = new Map<string, HostMode>();
  for (const mode of modes) {
    if (mode.width <= 0 || mode.height <= 0) continue;
    const key = `${mode.width}x${mode.height}`;
    const held = bySize.get(key);
    if (!held || beats(mode, held)) bySize.set(key, mode);
  }
  return [...bySize.values()]
    .sort((a, b) => b.width * b.height - a.width * a.height || b.refresh - a.refresh)
    .map((m) => ({
      id: m.id, width: m.width, height: m.height, refresh: m.refresh,
      // `preferred` is kept per *group*: whichever timing survived, the size is still the
      // display's native one and that is what the badge means to a user.
      current: m.current, preferred: m.preferred,
    }));
}

function beats(candidate: HostMode, held: HostMode): boolean {
  if (candidate.current !== held.current) return candidate.current;
  if (candidate.preferred !== held.preferred) return candidate.preferred;
  return candidate.refresh > held.refresh;
}

/** The client's own screen, in the units the host reports its modes in. */
export interface LocalScreen {
  width: number;
  height: number;
}

/**
 * RustDesk's `_getBestFitResolution` and `_isRemoteResolutionFitLocal` as one decision: the mode
 * to switch to so the host matches this client's screen, or null when the item must not be shown.
 *
 * The match is **exact** — no nearest, no letterboxed approximation. That reads like a missing
 * feature and is the opposite: offering 1920x1080 to a 1366x768 client puts the picture back on
 * the scaler the item exists to avoid, so RustDesk returns null and hides the button instead.
 * On most client/host pairs it is therefore never visible, which is correct.
 */
export function fitLocalMode(
  modes: readonly HostMode[],
  local: LocalScreen | null,
  currentModeId: string | null,
): HostMode | null {
  if (!local || local.width <= 0 || local.height <= 0) return null;
  const group = modes.filter((m) => m.width === local.width && m.height === local.height);
  if (group.length === 0) return null;
  // Compared by *size*, the way RustDesk compares against the display rect rather than a mode id:
  // the host may be on another timing of the size the client already has, and switching between
  // two refresh rates of it would be a menu item that changes nothing the user can see.
  const live = modes.find((m) => m.id === currentModeId) ?? modes.find((m) => m.current) ?? null;
  if (live && live.width === local.width && live.height === local.height) return null;
  // Whichever timing the size's own menu row would offer, so the two cannot disagree.
  return group.reduce((held, m) => (beats(m, held) ? m : held));
}

/**
 * The client's screen in CSS pixels. RustDesk's web branch divides the physical size by
 * `scaleFactor` to get this number; in a browser `screen.width` already is it, and it is the
 * one that makes `scale: original` fill the viewport rather than land at 1 host pixel per
 * *device* pixel — half size on any 2x display.
 */
export function localScreenSize(): LocalScreen | null {
  if (typeof window === "undefined" || !window.screen) return null;
  const width = Math.round(window.screen.width);
  const height = Math.round(window.screen.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** `3440 × 1440`, with the refresh only when there is one to show. */
export function resolutionLabel(choice: ResolutionChoice): string {
  const size = `${choice.width} × ${choice.height}`;
  return choice.refresh > 0 ? `${size} · ${choice.refresh} Hz` : size;
}
