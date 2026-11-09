/**
 * The chat's connection, in the footer's context row — and only when there is something to say.
 *
 * Connected is not news, so it shows nothing. While the socket reconnects (after the grace period
 * `useReconnectIndicator` keeps, so a quick return to the app never flashes) a quiet chip spins;
 * once the reconnect drags on it turns red, "Connection lost · Retry", and the whole chip is the
 * retry. Nothing here blocks the chat: anything sent meanwhile is queued and goes out once the
 * connection is back, which the composer's placeholder says.
 */
import { Loader2, WifiOff } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { ReconnectStage } from "@/hooks/use-reconnect-indicator";
import { FOOTER_CHIP, HIDE_NARROW } from "./footer-chip";

/** Narrow and phone widths: the lost chip says "Offline" in place of "Connection lost". */
const SHOW_NARROW = "hidden @max-[420px]/chat:inline max-md:inline";

export function ConnectionChip({ stage, onRetry }: { stage: ReconnectStage; onRetry: () => void }) {
  if (stage === "hidden") return null;
  if (stage === "reconnecting") {
    return (
      <span
        role="status"
        aria-live="polite"
        data-reconnect-stage="reconnecting"
        title="Reconnecting — anything you send now goes out once the connection is back"
        className={cn(FOOTER_CHIP, "footer-fade-in cursor-default motion-safe:active:scale-100 can-hover:hover:border-border-soft can-hover:hover:text-text-2")}
      >
        <Loader2 className="animate-spin" />
        <span className={HIDE_NARROW}>Reconnecting…</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-live="polite"
      data-reconnect-stage="lost"
      onClick={onRetry}
      title="Connection lost — tap to retry"
      className={cn(
        FOOTER_CHIP,
        "footer-fade-in border-error/35 bg-error/10 text-error can-hover:hover:border-error/60 can-hover:hover:text-error",
      )}
    >
      <WifiOff />
      <span className={HIDE_NARROW}>Connection lost</span>
      <span className={SHOW_NARROW}>Offline</span>
      <b className="ml-0.5 font-semibold before:mr-1.5 before:font-normal before:text-error/60 before:content-['·']">Retry</b>
    </button>
  );
}
