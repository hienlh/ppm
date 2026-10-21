import type { FrameFit, Size } from "../components/design/canvas/canvas-geometry";
import type { CommentPins } from "../components/design/comments/use-comment-pins";
import { pinCenter, rectVisible } from "../components/design/comments/comment-overlay-geometry";
import type { GuestThread } from "./share-thread-model";
import { cx } from "./share-ui";

/**
 * Numbered pins over the design, one per open thread whose element is on screen, at the
 * element's top-right corner — the same place the owner's canvas puts them. Each is a 44px
 * target around a smaller dot, and a tap opens the thread; a reviewer has nothing else to do
 * with a pin, so there is no menu and no long-press.
 */
export function SharePinsOverlay({ open, numbers, pins, fit, stage, activeId, onOpen }: {
  open: readonly GuestThread[];
  numbers: ReadonlyMap<string, number>;
  pins: CommentPins;
  fit: FrameFit;
  stage: Size;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-label="Comment pins">
      {open.map((t) => {
        const status = pins.statusOf(t.id);
        const rect = pins.rects.get(t.id)?.rect;
        if ((status !== "pinned" && status !== "moved") || !rect || !rectVisible(rect, fit)) return null;
        const at = pinCenter(rect, fit, stage);
        const n = numbers.get(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(t.id)}
            aria-label={`Comment ${n ?? ""}: ${t.body}`}
            className="pointer-events-auto absolute flex size-11 -translate-x-1/2 -translate-y-1/2 select-none items-center justify-center"
            style={{ left: at.left, top: at.top }}
          >
            <span className={cx(
              "flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg shadow-md ring-2 ring-panel",
              activeId === t.id && "scale-125 ring-text",
            )}>
              {n}
            </span>
          </button>
        );
      })}
    </div>
  );
}
