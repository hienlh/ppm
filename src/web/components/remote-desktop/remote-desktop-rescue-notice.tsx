/**
 * The one thing the user hears from the Windows helper's safety net: it ran, because nobody saw
 * the PC through PPM for 5 minutes after the session was brought back or the display turned on,
 * and it turned the virtual display on (or found none to turn on). Everything before that is
 * silent — the viewer confirms by itself once a picture comes through.
 *
 * Floats over the checklist and the viewer alike without changing the layout under it (which
 * would remount the viewer and drop its connection). One button, the standard text-button size
 * (`docs/design-guidelines.md` rule 3).
 */
import { MonitorSmartphone } from "@/lib/icons";
import { TEXT_BUTTON } from "@/lib/control-size";
import type { RescueNotice } from "./use-headless-rescue";

/** The helper's `RESCUE_MINUTES` (`win32-helper/helper-paths.ts`), which the browser bundle does
 *  not import; a test pins the two together. */
export const RESCUE_MINUTES_SHOWN = 5;

export function rescueNoticeText(notice: RescueNotice): string {
  return notice.outcome === "display-on"
    ? `PPM turned the virtual display on because nobody could see this PC for ${RESCUE_MINUTES_SHOWN} minutes.`
    : `Nobody could see this PC for ${RESCUE_MINUTES_SHOWN} minutes, and it has no virtual display to turn on.`;
}

export function RescueNoticeBar({ notice, onDismiss }: { notice: RescueNotice; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-lg border border-white/15 bg-black/85 px-3 py-2 text-xs text-white shadow-lg backdrop-blur"
      data-testid="remote-desktop-rescue-notice"
    >
      <MonitorSmartphone className="size-4 shrink-0 text-sky-300" />
      <p className="min-w-0 flex-1 leading-relaxed">{rescueNoticeText(notice)}</p>
      <button
        type="button"
        onClick={onDismiss}
        className={`inline-flex items-center justify-center ${TEXT_BUTTON} shrink-0 bg-white/10 font-medium hover:bg-white/20`}
        data-testid="remote-desktop-rescue-notice-dismiss"
      >
        OK
      </button>
    </div>
  );
}
