import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import {
  designFrameKey, loadDesignViewPrefs, saveDesignViewPrefs, withFrame,
} from "@/lib/design/design-view-prefs";
import { useDesignTab } from "../design-tab-context";
import { DesignToolbar, DesignToolbarList, type DesignToolbarContext } from "../design-toolbar";
import { DesignHistoryPanel } from "../history/design-history-panel";
import { useDesignCanvas } from "./use-design-canvas";
import { defaultFrameFor, framePreset, type DeviceFrameId } from "./device-frame-presets";
import { fitFrame, type Size } from "./canvas-geometry";
import { DesignIssuesBadge } from "./design-issues-badge";
import { useDesignCommentsFeature } from "../comments/use-design-comments-feature";
import { DesignCommentsOverlay, DesignCommentsSidePanel } from "../comments/design-comments-layer";
import { useDesignTweaks } from "../tweaks/use-design-tweaks";
import { TweaksPanel } from "../tweaks/tweaks-panel";
import { useCanvasTransform } from "../transform/use-canvas-transform";
import { useDesignUndo } from "../transform/design-undo-stack";
import { TransformReadout } from "../transform/transform-readout";

/**
 * The live canvas: the design's entry page in a sandboxed iframe, sized to the chosen
 * device frame, with the toolbar above it (desktop) or behind the More sheet (phone).
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` gives the page an opaque origin, so
 * it can read nothing of PPM's; `no-referrer` keeps its capability URL out of any request
 * the page makes.
 */
export function DesignCanvasPane({ moreOpen = false, onMoreClose }: { moreOpen?: boolean; onMoreClose?: () => void }) {
  const tab = useDesignTab();
  const canvas = useDesignCanvas(tab);
  const [historyOpen, setHistoryOpen] = useState(false);
  const frameKey = designFrameKey(tab.projectName, tab.slug);
  const [frame, setFrameState] = useState<DeviceFrameId>(
    () => loadDesignViewPrefs().frames[frameKey] ?? defaultFrameFor(tab.design.kind),
  );
  const setFrame = useCallback((next: DeviceFrameId) => {
    setFrameState(next);
    saveDesignViewPrefs(withFrame(loadDesignViewPrefs(), frameKey, next));
  }, [frameKey]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = fitFrame(framePreset(frame).size, stage);
  const framed = frame !== "desktop";

  // Comments, tweaks and the history share the side column, so opening one closes the others.
  const closeTweaksRef = useRef<() => void>(() => {});
  const comments = useDesignCommentsFeature(tab, canvas.bridge, {
    onPanelOpen: () => { setHistoryOpen(false); closeTweaksRef.current(); },
  });
  const { closePanel: closeComments } = comments;
  const tweaks = useDesignTweaks(tab, canvas.bridge, canvas.reload, {
    onPanelOpen: () => { setHistoryOpen(false); closeComments(); },
  });
  const { closePanel: closeTweaks } = tweaks;
  closeTweaksRef.current = closeTweaks;
  const toggleHistory = useCallback(() => {
    if (!historyOpen) { closeComments(); closeTweaks(); }
    setHistoryOpen(!historyOpen);
  }, [historyOpen, closeComments, closeTweaks]);

  const transform = useCanvasTransform(tab, canvas.bridge, comments.picker, fit.scale, canvas.reload);
  const openHistory = useCallback(() => {
    closeComments();
    closeTweaks();
    setHistoryOpen(true);
  }, [closeComments, closeTweaks]);
  const undo = useDesignUndo(tab, { openHistory });

  const toolbarCtx = useMemo<DesignToolbarContext>(() => ({
    ...tab, canvas, frame, setFrame, historyOpen, toggleHistory, comments, tweaks, transform, undo,
  }), [tab, canvas, frame, setFrame, historyOpen, toggleHistory, comments, tweaks, transform, undo]);
  const tweaksPanel = tweaks.panelOpen && <TweaksPanel feature={tweaks} tabId={tab.tabId} slug={tab.slug} />;

  const history = historyOpen && (
    <DesignHistoryPanel onClose={() => setHistoryOpen(false)} onRestored={canvas.reload} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {!tab.isMobile && <DesignToolbar ctx={toolbarCtx} />}
      <div className="flex min-h-0 flex-1">
        {/* Focusable in Move mode, so arrow keys pressed here nudge the selected element. */}
        <div ref={stageRef} className={cn("relative min-w-0 flex-1 overflow-hidden outline-none", framed && "bg-surface-elevated/40")}
          tabIndex={transform.moveOn ? 0 : undefined} onKeyDown={transform.onPaneKeyDown}
          aria-label={transform.moveOn ? "Canvas: arrow keys move the selected element" : undefined}>
          {canvas.src && (
            <div
              className={cn("absolute left-1/2 top-1/2 origin-center", framed && "rounded-md shadow-lg ring-1 ring-border")}
              style={{
                width: fit.width, height: fit.height,
                transform: `translate(-50%, -50%) scale(${fit.scale})`,
              }}
            >
              <iframe
                ref={canvas.iframeRef}
                src={canvas.src}
                title={`Design canvas: ${tab.design.title}`}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                onLoad={canvas.bridge.frameLoaded}
                className="block size-full border-0 bg-white [[data-design-resizing]_&]:pointer-events-none"
              />
            </div>
          )}
          {!canvas.src && !canvas.error && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-text-subtle">
              <Loader2 className="mr-2 size-4 animate-spin" /> Opening canvas…
            </div>
          )}
          {(canvas.dead || canvas.error) && (
            <div className="absolute inset-x-0 top-0 flex items-center justify-center p-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md" role="alert">
                {canvas.error ?? "The canvas stopped responding."}
                <button type="button" onClick={canvas.reload}
                  className="flex min-h-11 items-center gap-1 px-2 text-primary underline md:min-h-7">
                  <RefreshCw className="size-3.5" /> Reload
                </button>
              </div>
            </div>
          )}
          <DesignIssuesBadge issues={canvas.issues} className="absolute right-2 top-2" />
          {canvas.src && (
            <DesignCommentsOverlay feature={comments} fit={fit} stage={stage} isMobile={tab.isMobile} selectionHint={transform.hint} />
          )}
          {canvas.src && <TransformReadout feature={transform} isMobile={tab.isMobile} />}
        </div>
        {!tab.isMobile && history && <div className="w-72 shrink-0 border-l border-border">{history}</div>}
        {!tab.isMobile && comments.panelOpen && (
          <div className="w-72 shrink-0 border-l border-border"><DesignCommentsSidePanel feature={comments} /></div>
        )}
        {!tab.isMobile && tweaksPanel && <div className="w-72 shrink-0 border-l border-border">{tweaksPanel}</div>}
      </div>
      {/* Docked under the canvas rather than in a sheet: a sheet's backdrop would dim the very
          colours being tweaked, and the canvas has to stay in view while a slider moves. */}
      {tab.isMobile && tweaksPanel && <div className="h-[45%] shrink-0 border-t border-border">{tweaksPanel}</div>}
      {tab.isMobile && (
        <>
          <BottomSheet open={moreOpen} onClose={() => onMoreClose?.()}>
            <DesignToolbarList ctx={toolbarCtx} onDone={() => onMoreClose?.()} />
          </BottomSheet>
          <BottomSheet open={historyOpen} onClose={() => setHistoryOpen(false)} className="flex h-[70vh] flex-col">
            <div className="min-h-0 flex-1">{history}</div>
          </BottomSheet>
          <BottomSheet open={comments.panelOpen} onClose={closeComments} className="flex h-[70vh] flex-col">
            <div className="min-h-0 flex-1"><DesignCommentsSidePanel feature={comments} /></div>
          </BottomSheet>
        </>
      )}
    </div>
  );
}
