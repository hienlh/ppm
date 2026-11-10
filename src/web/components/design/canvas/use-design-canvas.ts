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
 *
 * `expired` is only trusted before this load's `ready` arrives: the real expired stand-in
 * (`expired-page.ts`) never sends one, but the actual design document could — its own script
 * can read `?n=` off its URL — so a document that already proved itself must not be able to
 * keep claiming its token died and loop the canvas through remints, each of which evicts
 * another open canvas's token from the shared store.
 */

/** Whether an `expired` message for the current load should trigger a remint-and-reload. */
export function acceptsExpired(readyForCurrentLoad: boolean): boolean {
  return !readyForCurrentLoad;
}

/**
 * Where the design's own folder starts in a canvas URL path:
 * `/api/design-preview/content/<token>/<slug>/<page>` → the index of `<page>`'s first segment.
 */
function pageStart(segments: string[], slug: string): number {
  for (let i = 1; i + 2 < segments.length; i++) {
    if (segments[i - 1] === "design-preview" && segments[i] === "content") {
      return segments[i + 2] === encodeURIComponent(slug) ? i + 3 : -1;
    }
  }
  return -1;
}

/**
 * The page of this design a blocked link points at, as a path inside the design folder, or
 * null when the link leaves the design (another design, another token, another origin, not an
 * HTML page).
 *
 * The frame cannot navigate itself — the bridge cancels every link out of its document — so a
 * design made of several pages has its links followed here instead. The canvas token already
 * covers the whole design folder; only the page under it changes. `currentUrl` is the shown
 * page's absolute URL; the frame reports `href` absolute too.
 */
export function designPageFor(href: string, currentUrl: string, slug: string): string | null {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(href, current);
  } catch {
    return null;
  }
  if (target.origin !== current.origin) return null;
  const now = current.pathname.split("/");
  const next = target.pathname.split("/");
  const start = pageStart(now, slug);
  if (start < 0 || pageStart(next, slug) !== start) return null;
  // Same token: a link cannot borrow another canvas's capability.
  if (now.slice(0, start).join("/") !== next.slice(0, start).join("/")) return null;
  let page: string[];
  try {
    page = next.slice(start).map(decodeURIComponent);
  } catch {
    return null;
  }
  // A dot-folder (`.design/`) is PPM's own; an encoded slash would load another path than linked.
  if (!page.length || page.some((s) => s === "" || s.startsWith(".") || /[/\\]/.test(s))) return null;
  const path = page.join("/");
  return /\.html?$/i.test(path) ? path : null;
}

/** A canvas URL for some page of the design, pointed at `page` instead. */
export function withDesignPage(url: string, slug: string, page: string): string {
  const segments = url.split("/");
  const start = pageStart(segments, slug);
  if (start < 0) return url;
  return [...segments.slice(0, start), ...page.split("/").map(encodeURIComponent)].join("/");
}

/** `file` is the variant to show: the entry page, or one of the other variants. */
export function useDesignCanvas(ctx: DesignTabContextValue, file: string) {
  const { projectName, slug, isActive, refreshDesign } = ctx;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const preview = useDesignPreviewUrl(projectName, slug, file);
  const [load, setLoad] = useState<{ url: string; nonce: string } | null>(null);
  const [dead, setDead] = useState(false);
  const [issues, setIssues] = useState<CanvasIssue[]>([]);
  const recovering = useRef(false);
  const lastScroll = useRef<{ x: number; y: number } | null>(null);

  // The page of the design a followed link moved the canvas to, kept across token reloads;
  // null while the variant itself is shown.
  const page = useRef<string | null>(null);
  const loadUrl = useRef<string | null>(null);
  loadUrl.current = load?.url ?? null;

  const reload = useCallback(async (opts?: { remint?: boolean }) => {
    const url = opts?.remint ? await preview.remint() : preview.latestUrl();
    if (!url) { setDead(true); return; }
    setIssues([]);
    setLoad({ url: page.current ? withDesignPage(url, slug, page.current) : url, nonce: newBridgeNonce() });
  }, [preview, slug]);

  const openPage = useCallback((url: string, next: string) => {
    page.current = next === file ? null : next;
    lastScroll.current = null;
    setIssues([]);
    setLoad({ url: withDesignPage(url, slug, next), nonce: newBridgeNonce() });
  }, [file, slug]);

  const recover = useCallback(() => {
    if (recovering.current) { setDead(true); return; }
    recovering.current = true;
    void reload({ remint: true });
  }, [reload]);

  const bridge = useDesignBridge(iframeRef, load?.nonce ?? null, recover);
  // Read inside the "expired" handler below instead of `bridge.ready` directly: that handler
  // is registered in an effect that does not re-run on every render, so it would otherwise
  // see whichever load was current the last time the effect ran.
  const readyForLoad = useRef(false);
  readyForLoad.current = bridge.ready !== null;

  // First URL: load it.
  useEffect(() => {
    if (preview.initialUrl) setLoad({ url: preview.initialUrl, nonce: newBridgeNonce() });
  }, [preview.initialUrl]);

  // Another variant, or a manifest naming another entry page, needs a URL for that page.
  const shown = useRef(file);
  useEffect(() => {
    if (shown.current === file) return;
    shown.current = file;
    page.current = null;
    void preview.retarget(file).then((url) => {
      if (!url || shown.current !== file) return;
      setIssues([]);
      setLoad({ url, nonce: newBridgeNonce() });
    });
  }, [file, preview]);

  useEffect(() => {
    const offs = [
      bridge.on("ready", () => { recovering.current = false; setDead(false); }),
      bridge.on("expired", () => { if (acceptsExpired(readyForLoad.current)) recover(); }),
      bridge.on("scroll", (m) => { lastScroll.current = { x: m.x, y: m.y }; }),
      bridge.on("issue", (m) => setIssues((list) => list.length >= MAX_CANVAS_ISSUES ? list
        : [...list, { kind: m.kind, message: m.message, source: m.source, line: m.line }])),
      bridge.on("navigate-blocked", (m) => {
        const url = loadUrl.current;
        const page = url ? designPageFor(m.href, new URL(url, window.location.origin).href, slug) : null;
        if (url && page) {
          openPage(url, page);
          return;
        }
        setIssues((list) => list.length >= MAX_CANVAS_ISSUES ? list
          : [...list, { kind: "navigate-blocked", message: "The canvas does not follow links out of the design.", source: m.href }]);
      }),
      // Every new document starts at the top; put the reader back where they were.
      bridge.onReplay((send) => {
        const at = lastScroll.current;
        if (at && (at.x || at.y)) send({ type: "restore-scroll", x: at.x, y: at.y });
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge.on, bridge.onReplay, recover, openPage, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const readyGen = useRef<string | null>(null);
  readyGen.current = bridge.ready?.gen ?? null;
  useDesignLiveReload({
    projectName, slug, isActive,
    reload: (opts) => { void reload(opts); },
    onManifestChanged: refreshDesign,
    entry: ctx.design.entry,
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
