/**
 * "Screen awake" indicator — shown only while a wake lock is actually held.
 *
 * Two mounts, because the two viewports have no shared chrome: the status bar is `hidden md:flex`
 * and never renders on the phones and tablets this feature exists for, while a fixed badge would
 * collide with the desktop status bar. Both read the same store, so they can never disagree.
 *
 * The state is reported by the browser, not assumed: `use-wake-lock.ts` only flips the store
 * after a request resolves, so this chip disappearing means the platform really did take the
 * lock back (battery saver, low battery) rather than the setting being off.
 */

import { memo } from "react";
import { Sun } from "@/lib/icons";
import { useWakeLockStore } from "@/stores/wake-lock-store";

const LABEL = "Screen awake";
const TITLE = "Screen is being kept on while this turn runs";

/** Desktop: a plain entry that inherits the status bar's own type scale. */
export const WakeLockStatusBarItem = memo(function WakeLockStatusBarItem() {
  const active = useWakeLockStore((s) => s.active);
  if (!active) return null;

  return (
    <span className="flex items-center gap-1 text-warning shrink-0" title={TITLE}>
      <Sun className="size-3 shrink-0" />
      <span>awake</span>
    </span>
  );
});

/**
 * Mobile: a sun in the bottom nav, in the flow of the bar like the desktop entry is in the status
 * bar. It used to be a pill fixed over the top edge of the page, where it covered the header of
 * whatever panel was open (an extension panel's title and first controls) for as long as a turn
 * ran. The label stays for screen readers and as the tooltip.
 */
export const WakeLockMobileBadge = memo(function WakeLockMobileBadge() {
  const active = useWakeLockStore((s) => s.active);
  if (!active) return null;

  return (
    <span
      className="flex size-12 shrink-0 items-center justify-center text-warning"
      title={TITLE}
      role="status"
      aria-label={LABEL}
      data-slot="wake-lock-mobile"
    >
      <Sun className="size-4" />
    </span>
  );
});
