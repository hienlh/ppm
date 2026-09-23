import { useCallback, useEffect, useRef, useState } from "react";
import { useDesignPreviewUrl } from "./use-design-preview-url";
import { newBridgeNonce, useDesignBridge } from "./use-design-bridge";
import { useDesignLiveReload } from "./use-design-live-reload";
import { MAX_CANVAS_ISSUES, type CanvasIssue } from "./design-issues-badge";
import type { DesignTabContextValue } from "../design-tab-context";

/**
 * Everything that keeps the canvas iframe showing the right document.
 *
 * Each load gets a fresh nonce on its URL (`?n=`), and reloading means setting a new `src` —
 * the frame's origin is opaque, so `location.reload()` is not available to the parent. The
 * frame is recovered at most once per healthy document: an `expired` message or a load that
 * never says `ready` re-mints the token and reloads; if that fails too the canvas says so
 * instead of reloading forever.
 */
export function useDesignCanvas(ctx: DesignTabContextValue) {
  const { projectName, slug, design, isActive, refreshDesign } = ctx;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const preview = useDesignPreviewUrl(projectName, slug);
  const [load, setLoad] = useState<{ url: string; nonce: string } | null>(null);
  const [dead, setDead] = useState(false);
  const [issues, setIssues] = useState<CanvasIssue[]>([]);
  const recovering = useRef(false);
  const lastScroll = useRef<{ x: number; y: number } | null>(null);

  const reload = useCallback(async (opts?: { remint?: boolean }) => {
    const url = opts?.remint ? await preview.remint() : preview.latestUrl();
    if (!url) { setDead(true); return; }
    setIssues([]);
    setLoad({ url, nonce: newBridgeNonce() });
  }, [preview]);

  const recover = useCallback(() => {
    if (recovering.current) { setDead(true); return; }
    recovering.current = true;
    void reload({ remint: true });
  }, [reload]);

  const bridge = useDesignBridge(iframeRef, load?.nonce ?? null, recover);

  // First URL: load it.
  useEffect(() => {
    if (preview.initialUrl) setLoad({ url: preview.initialUrl, nonce: newBridgeNonce() });
  }, [preview.initialUrl]);

  // A manifest that names another entry page needs a URL for that page.
  const entry = useRef(design.entry);
  useEffect(() => {
    if (entry.current === design.entry) return;
    entry.current = design.entry;
    void reload({ remint: true });
  }, [design.entry, reload]);

  useEffect(() => {
    const offs = [
      bridge.on("ready", () => { recovering.current = false; setDead(false); }),
      bridge.on("expired", recover),
      bridge.on("scroll", (m) => { lastScroll.current = { x: m.x, y: m.y }; }),
      bridge.on("issue", (m) => setIssues((list) => list.length >= MAX_CANVAS_ISSUES ? list
        : [...list, { kind: m.kind, message: m.message, source: m.source, line: m.line }])),
      bridge.on("navigate-blocked", (m) => setIssues((list) => list.length >= MAX_CANVAS_ISSUES ? list
        : [...list, { kind: "navigate-blocked", message: "The canvas does not follow links out of the design.", source: m.href }])),
      // Every new document starts at the top; put the reader back where they were.
      bridge.onReplay((send) => {
        const at = lastScroll.current;
        if (at && (at.x || at.y)) send({ type: "restore-scroll", x: at.x, y: at.y });
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge.on, bridge.onReplay, recover]); // eslint-disable-line react-hooks/exhaustive-deps

  const readyGen = useRef<string | null>(null);
  readyGen.current = bridge.ready?.gen ?? null;
  useDesignLiveReload({
    projectName, slug, isActive,
    reload: (opts) => { void reload(opts); },
    onManifestChanged: refreshDesign,
    currentUrl: () => load?.url ?? null,
    readyGen: () => readyGen.current,
  });

  const src = load ? `${load.url}?n=${encodeURIComponent(load.nonce)}` : null;
  return {
    iframeRef, src, bridge, issues, dead, error: preview.error,
    reload: () => { recovering.current = false; setDead(false); void reload(); },
  };
}

export type DesignCanvasState = ReturnType<typeof useDesignCanvas>;
