/**
 * "Stop all child sessions?" — asked inline at the foot of the linked-sessions list (which is
 * already a bottom sheet on a phone), so nothing stops on the first press. Names the sessions it
 * will stop, so the person knows what the button reaches before pressing it.
 */
import { Square } from "@/lib/icons";
import { FooterButton } from "./footer-popover";

export function StopChildSessionsConfirm({ titles, busy, onConfirm, onCancel }: {
  /** The running sessions this one created. */
  titles: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const n = titles.length;
  const what = n === 1 ? "child session" : `${n} child sessions`;
  const named = titles.map((t) => `“${t}”`).join(n === 2 ? " and " : ", ");
  return (
    <div
      data-stop-children-confirm=""
      className="footer-from-right shrink-0 border-t border-border-soft bg-error/5 px-3 pb-3 pt-2.5 max-md:px-4"
    >
      <p className="m-0 mb-2.5 break-words text-xs leading-relaxed text-text-2 max-md:text-sm">
        <b className="font-semibold text-text">Stop {what}?</b> Their current turns end now. {named}{" "}
        {n === 1 ? "stays" : "stay"} in History and can be continued later. This session keeps running.
      </p>
      <div className="flex justify-end gap-1.5 max-md:gap-2">
        <FooterButton onClick={onCancel} className="max-md:flex-1 max-md:justify-center">Cancel</FooterButton>
        <FooterButton variant="danger-fill" disabled={busy} onClick={onConfirm} className="max-md:flex-1 max-md:justify-center">
          <Square />
          {busy ? "Stopping…" : `Stop ${n === 1 ? "1 session" : `${n} sessions`}`}
        </FooterButton>
      </div>
    </div>
  );
}
