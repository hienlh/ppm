/**
 * The history window's status notices: a page loading at either end, and a page that failed.
 *
 * Both float over the window rather than sitting in its rows, except "Loading later turns", which
 * sits below the last row: content added below the viewport moves nothing being read, while a
 * notice inserted above it would push the rows down by its height.
 */
import { AlertCircle, Loader2 } from "@/lib/icons";
import type { LoadDirection } from "@/lib/history-window-model";

export function HistoryWindowSpinner({ label, floating = false }: { label: string; floating?: boolean }) {
  return (
    <div
      className={floating
        ? "flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs text-text-secondary shadow-md"
        : "flex items-center justify-center gap-1.5 py-3 text-xs text-text-secondary"}
      aria-busy="true"
      aria-label={label}
    >
      <Loader2 className="size-3 animate-spin" />
      {label}…
    </div>
  );
}

/** "Loading earlier turns", over the top of the window and out of the rows' flow. */
export function LoadingOlderNotice() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <HistoryWindowSpinner label="Loading earlier turns" floating />
    </div>
  );
}

export function LoadErrorBanner({ error, onRetry }: {
  error: { direction: LoadDirection; message: string };
  onRetry: (direction: LoadDirection) => void;
}) {
  return (
    <div className={`absolute left-0 right-0 z-10 flex justify-center ${error.direction === "older" ? "top-2" : "bottom-16"}`}>
      <button
        type="button"
        onClick={() => onRetry(error.direction)}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs text-text-primary md:min-h-0 md:py-2"
      >
        <AlertCircle className="size-3.5 text-destructive" />
        <span>Could not load more turns: {error.message}</span>
        <span className="underline">Retry</span>
      </button>
    </div>
  );
}
