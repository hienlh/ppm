import { Fragment, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

/** Metadata label styling, shared with the loaded panel so the skeleton lines up. */
const LABEL = "text-[var(--img-meta-label)] @max-[470px]:hidden";

/** Widths that keep the placeholder bars from looking like a uniform block. */
const BAR_WIDTHS = ["60%", "45%", "80%"];

/**
 * Loading state for the image panel.
 *
 * Occupies the same box as the loaded panel — same tile ratio, same three metadata rows,
 * same action row — so the transcript does not shift under the reader when the image lands.
 * `aspect` should come from the cached natural size when the file has been seen before.
 */
export function ImagePreviewSkeleton({ aspect, actions }: { aspect: number; actions: ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_1fr] items-start gap-[14px] overflow-hidden rounded-lg border border-border bg-panel p-[14px] @max-[470px]:grid-cols-[64px_1fr] @max-[470px]:gap-[11px] @max-[470px]:p-[11px]">
      <div className="img-skeleton rounded-lg" style={{ aspectRatio: aspect }} />
      <div className="flex min-w-0 flex-col gap-[9px]">
        <div className="img-skeleton h-[13px] w-2/5 rounded @max-[470px]:hidden" />
        {/* Labels stay as text so only the values arrive later — the row keeps its box. */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-[14px] gap-y-[4px] font-mono text-[11.5px] @max-[470px]:grid-cols-[1fr]">
          {["dimensions", "size", "path"].map((label, i) => (
            <Fragment key={label}>
              <dt className={LABEL}>{label}</dt>
              <dd className="flex items-center">
                <span className="img-skeleton h-[11px] rounded" style={{ width: BAR_WIDTHS[i] }} />
              </dd>
            </Fragment>
          ))}
        </dl>
        {actions}
      </div>
    </div>
  );
}

/** Failure state: a compact chip, since there is nothing to show and no space to justify. */
export function ImagePreviewFailure({ code, onRetry }: { code?: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-2 font-mono text-[12px] text-text-2">
      <AlertCircle className="size-3 shrink-0" />
      <span className="truncate">preview unavailable{code ? ` · ${code}` : ""}</span>
      <button type="button" onClick={onRetry} className="ml-auto shrink-0 text-accent">
        retry
      </button>
    </div>
  );
}
