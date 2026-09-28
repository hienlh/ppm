import { useLayoutEffect, useRef, useState, type ElementType } from "react";
import { ArrowUp, MessageSquarePlus, Send, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { FrameFit, Size } from "../canvas/canvas-geometry";
import type { ElementPicker } from "./use-element-picker";
import { barPosition } from "./comment-overlay-geometry";

/**
 * Actions on the element picked inside the canvas: Comment, Send to AI, Parent, Clear.
 *
 * The element lives in the iframe, so it cannot be the trigger of an adaptive context menu
 * (that must be a node of this document). The actions are therefore always-visible inline
 * buttons instead: floating beside the element on desktop, in the thumb zone at the bottom
 * of the canvas on a phone — where, while nothing is picked yet, the same bar says how
 * picking works on touch and offers the way out.
 */

interface Actions {
  onComment: () => void;
  onSend: () => void;
  /** Shown with the selected element, e.g. "Created by a script, so it cannot be moved". */
  hint?: string | null;
}

export function ElementActionBar({ picker, isMobile, fit, stage, onComment, onSend, hint }: Actions & {
  picker: ElementPicker;
  isMobile: boolean;
  fit: FrameFit;
  stage: Size;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [barSize, setBarSize] = useState<Size>({ width: 320, height: 40 });
  const { selected } = picker;
  useLayoutEffect(() => {
    const el = barRef.current;
    if (el && (el.offsetWidth !== barSize.width || el.offsetHeight !== barSize.height)) {
      setBarSize({ width: el.offsetWidth, height: el.offsetHeight });
    }
  });

  const buttons: Array<{ label: string; icon: ElementType; run: () => void }> = [
    { label: "Comment", icon: MessageSquarePlus, run: onComment },
    { label: "Send to AI", icon: Send, run: onSend },
    { label: "Parent", icon: ArrowUp, run: picker.selectParent },
    { label: "Clear", icon: X, run: picker.clear },
  ];

  if (isMobile) {
    if (!selected && !picker.on) return null;
    return (
      <div className="absolute inset-x-2 bottom-2 z-20 rounded-lg border border-border bg-popover p-2 shadow-lg" role="toolbar" aria-label="Selected element">
        {selected ? (
          <>
            <p className="truncate px-1 pb-1 text-xs text-text-subtle">&lt;{selected.tag}&gt; {selected.text}</p>
            {hint && <p className="px-1 pb-1 text-xs text-warning">{hint}</p>}
            <div className="grid grid-cols-4 gap-2">
              {buttons.map((b) => (
                <button key={b.label} type="button" onClick={b.run}
                  className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-text-2 active:bg-surface-elevated">
                  <b.icon className="size-5" /> {b.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-text-2">
              {picker.outlined ? `Tap the <${picker.outlined.tag}> again to select it.` : "Tap an element, then tap it again to select. Long-press to comment."}
            </p>
            <button type="button" onClick={() => picker.setOn(false)}
              className="min-h-11 shrink-0 rounded-md px-3 text-sm font-medium text-primary active:bg-surface-elevated">
              Done
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!selected) {
    if (!picker.on) return null;
    return (
      <div className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 text-xs text-text-2 shadow-md">
        Click an element to select it · Esc to stop
      </div>
    );
  }
  const at = barPosition(selected.rect, fit, stage, barSize);
  return (
    <div ref={barRef} role="toolbar" aria-label={`Selected <${selected.tag}>`}
      className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
      style={{ left: at.left, top: at.top }}>
      <span className="max-w-32 truncate px-2 font-mono text-xs text-text-subtle">&lt;{selected.tag}&gt;</span>
      {hint && <span className="max-w-64 truncate px-1 text-xs text-warning" title={hint}>{hint}</span>}
      {buttons.map((b) => (
        <button key={b.label} type="button" onClick={b.run} title={b.label}
          className={cn("flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-2 hover:bg-surface-elevated hover:text-foreground",
            b.label === "Clear" && "px-1.5")}>
          <b.icon className="size-4" /> {b.label !== "Clear" && b.label}
          {b.label === "Clear" && <span className="sr-only">Clear</span>}
        </button>
      ))}
    </div>
  );
}
