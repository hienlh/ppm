import { Loader2, Move, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { CanvasTransformFeature } from "./use-canvas-transform";

/**
 * What Move mode is doing, drawn over the canvas: the target's position and size while it
 * moves, what to do when nothing is selected yet, and — only in a browser that cannot report
 * user activation — Save/Discard for a change the parent could not tie to a gesture. A tap
 * on this readout is itself a gesture the parent saw, which is what makes Save trustworthy.
 *
 * Bottom-left on desktop; at the top on a phone, where the bottom of the canvas belongs to
 * the selected element's action bar.
 */
export function TransformReadout({ feature, isMobile }: { feature: CanvasTransformFeature; isMobile: boolean }) {
  if (!feature.moveOn) return null;
  const { live, target } = feature;
  const r = live?.rect;
  const text = !target
    ? isMobile ? "Tap an element twice to select it, then drag it or its handles." : "Select an element to move or resize it."
    : !live ? "Getting the element…"
    : !r ? "That element is not on the page any more."
    : `x ${Math.round(r.x)}  y ${Math.round(r.y)}  ·  w ${Math.round(r.w)}  h ${Math.round(r.h)}`;
  const btn = cn("flex shrink-0 items-center justify-center rounded-md text-xs font-medium", isMobile ? "min-h-11 px-3" : "h-7 px-2");

  return (
    <div
      role="status"
      aria-live="polite"
      onPointerDown={feature.markGesture}
      className={cn(
        "absolute z-20 flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1 text-xs text-text-2 shadow-md",
        isMobile ? "left-2 right-12 top-2" : "bottom-2 left-2 max-w-[calc(100%-1rem)]",
      )}
    >
      {feature.saving ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Move className="size-4 shrink-0 text-text-subtle" />}
      <span className="min-w-0 flex-1 truncate font-mono tabular-nums">{feature.confirm ? "Save this change to the design?" : text}</span>
      {feature.confirm ? (
        <>
          <button type="button" onClick={feature.confirmSave} className={cn(btn, "bg-primary text-primary-foreground")}>Save</button>
          <button type="button" onClick={feature.discard} className={cn(btn, "hover:bg-surface-elevated")}>Discard</button>
        </>
      ) : (
        <button type="button" onClick={feature.stop} aria-label="Stop moving" title="Stop moving"
          className={cn(btn, "text-text-subtle hover:bg-surface-elevated hover:text-foreground", isMobile ? "min-w-11" : "w-7 px-0")}>
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
