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
import { Sun } from "lucide-react";
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
 * Mobile: a pill at the top edge. Top-left and top-right are already taken by the device-name
 * badge and the BETA ribbon, so this sits centred between them.
 */
export const WakeLockMobileBadge = memo(function WakeLockMobileBadge() {
  const active = useWakeLockStore((s) => s.active);
  if (!active) return null;

  return (
    <div
      className="md:hidden fixed left-1/2 -translate-x-1/2 top-0 z-50 flex items-center gap-1 px-2 py-0.5 rounded-b bg-warning/85 text-white text-[10px] font-medium pointer-events-none"
      title={TITLE}
    >
      <Sun className="size-3 shrink-0" />
      <span>{LABEL}</span>
    </div>
  );
});
