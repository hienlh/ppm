import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "@/lib/icons";
import { fitFrame, type Size } from "../components/design/canvas/canvas-geometry";
import type { CommentPins } from "../components/design/comments/use-comment-pins";
import type { ElementPicker } from "../components/design/comments/use-element-picker";
import type { ShareCanvasState } from "./use-share-canvas";
import type { GuestThread } from "./share-thread-model";
import { SharePinsOverlay } from "./share-pins-overlay";
import { buttonOutline, cx } from "./share-ui";

/**
 * The stage: the shared version in a sandboxed frame, sized to the chosen device frame and
 * scaled to fit, with the pins over it and a hint while the reviewer is choosing an element.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` gives the design an opaque origin,
 * so its scripts can read nothing of this page — which matters more here than in the app,
 * because this page shares its origin with PPM. `no-referrer` keeps the link's code out of
 * any request the design makes.
 */

function useStageSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

export function ShareCanvas({ canvas, title, frameSize, picker, pins, open, numbers, activeId, onOpenThread, isMobile }: {
  canvas: ShareCanvasState;
  title: string;
  frameSize: Size | null;
  picker: ElementPicker;
  pins: CommentPins;
  open: readonly GuestThread[];
  numbers: ReadonlyMap<string, number>;
  activeId: string | null;
  onOpenThread: (id: string) => void;
  isMobile: boolean;
}) {
  const stage = useStageSize();
  const fit = fitFrame(frameSize, stage.size);
  const framed = frameSize !== null;
  const hint = picker.on && !picker.selected
    ? isMobile
      ? picker.outlined ? `Tap the <${picker.outlined.tag}> again to comment on it.` : "Tap the part you want to comment on."
      : "Click the part you want to comment on · Esc to stop"
    : null;

  return (
    <div ref={stage.ref} className={cx("relative min-h-0 min-w-0 flex-1 overflow-hidden", framed && "bg-stage")}>
      <div
        className={cx("absolute left-1/2 top-1/2 origin-center bg-white", framed && "rounded-md shadow-lg ring-1 ring-border")}
        style={{ width: fit.width, height: fit.height, transform: `translate(-50%, -50%) scale(${fit.scale})` }}
      >
        <iframe
          ref={canvas.iframeRef}
          src={canvas.src}
          title={`Shared design: ${title}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={canvas.bridge.frameLoaded}
          className="block size-full border-0 bg-white"
        />
      </div>
      <SharePinsOverlay open={open} numbers={numbers} pins={pins} fit={fit} stage={stage.size}
        activeId={activeId} onOpen={onOpenThread} />
      {hint && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-3">
          <p className="rounded-full border border-border bg-panel px-3 py-1.5 text-sm text-text-2 shadow-md" role="status">{hint}</p>
        </div>
      )}
      {canvas.dead && (
        <div className="absolute inset-x-0 top-2 z-30 flex justify-center px-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-panel px-3 py-2 text-sm shadow-md" role="alert">
            The design stopped responding.
            <button type="button" className={buttonOutline} onClick={canvas.reload}>
              <RefreshCw className="size-4" /> Reload
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
