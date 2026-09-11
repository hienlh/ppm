/**
 * Warning shown before the Remote Desktop viewer connects — wraps both the desktop window body
 * (`remote-desktop-window-content.tsx`) and the mobile full-screen view
 * (`remote-desktop-mobile-sheet.tsx`). The viewer is only mounted after the user continues, so
 * no session nonce is minted and no frame is captured while the warning is up.
 *
 * Shown on every open until the user ticks "don't show again", which persists via the shared
 * `remoteDesktopWarningDismissed` UI pref (server-side, like the stats-overlay toggle) so the
 * choice follows them across devices. Dark chrome on purpose: it sits where the black canvas
 * will be, on both surfaces.
 */
import { useState, type ReactNode } from "react";
import { MonitorSmartphone, ShieldAlert } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";

export interface RemoteDesktopWarningGateProps {
  /** Called when the user backs out instead of continuing — close the window/sheet. */
  onCancel: () => void;
  children: ReactNode;
}

export function RemoteDesktopWarningGate({ onCancel, children }: RemoteDesktopWarningGateProps) {
  const dismissed = useSettingsStore((s) => s.remoteDesktopWarningDismissed);
  const setDismissed = useSettingsStore((s) => s.setRemoteDesktopWarningDismissed);
  const [accepted, setAccepted] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (dismissed || accepted) return <>{children}</>;

  const onContinue = () => {
    if (dontShowAgain) setDismissed(true);
    setAccepted(true);
  };

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-y-auto bg-black p-4 text-white"
      data-testid="remote-desktop-warning-gate"
    >
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-white/10 bg-white/5 p-5">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="size-5 shrink-0 text-primary" />
          <h2 className="text-base font-semibold">Remote Desktop</h2>
          <span className="ml-auto rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            Beta
          </span>
        </div>

        <ul className="flex flex-col gap-2 text-sm text-white/80">
          <li className="flex gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <span>
              This streams the host&apos;s <strong>whole screen</strong> and lets you <strong>move its mouse and type</strong> as if
              you were sitting at it. Anything you do here happens on the real desktop.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <span>
              Anyone signed in to this PPM can do the same. Avoid opening it over a public share link you don&apos;t fully
              trust; a private network (Tailscale, LAN) is safer.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <span>
              Still beta: the host must be unlocked with an active session, UAC prompts stay hidden, and a person at the
              host will fight you for the cursor.
            </span>
          </li>
        </ul>

        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-white/70">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="size-4 accent-primary"
            data-testid="remote-desktop-warning-dont-show"
          />
          Don&apos;t show this again
        </label>

        {/* Primary action last (thumb zone on mobile); both ≥44px tall. */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 flex-1 rounded-md bg-white/10 px-3 text-sm hover:bg-white/20"
            data-testid="remote-desktop-warning-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="min-h-11 flex-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="remote-desktop-warning-continue"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
