import { Loader2, WifiOff } from "@/lib/icons";
import { useReconnectIndicator } from "@/hooks/use-reconnect-indicator";

interface ChatReconnectBannerProps {
  isReconnecting: boolean;
  onRetry: () => void;
  /** Overrides for tests; production uses the hook's defaults. */
  showDelayMs?: number;
  lostAfterMs?: number;
}

/**
 * A small pill floating over the top of the chat while the socket reconnects.
 *
 * It deliberately covers nothing else: the messages on screen stay readable and
 * scrollable, and anything sent meanwhile is queued and goes out on reconnect.
 */
export function ChatReconnectBanner({ isReconnecting, onRetry, showDelayMs, lostAfterMs }: ChatReconnectBannerProps) {
  const { stage, restart } = useReconnectIndicator(isReconnecting, showDelayMs, lostAfterMs);
  if (stage === "hidden") return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-40 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        data-reconnect-stage={stage}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-1 text-xs text-text-secondary shadow-sm backdrop-blur-sm"
      >
        {stage === "reconnecting" ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            <span>Reconnecting…</span>
          </>
        ) : (
          <>
            <WifiOff className="size-3.5 text-error" />
            <span>Connection lost</span>
            <button
              type="button"
              onClick={() => {
                restart();
                onRetry();
              }}
              className="-my-1 min-h-11 rounded-full px-2 font-medium text-primary hover:underline active:opacity-70 md:min-h-0 md:py-1"
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
