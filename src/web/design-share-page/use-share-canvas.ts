import { useCallback, useEffect, useRef, useState } from "react";
import { newBridgeNonce, useDesignBridge } from "../components/design/canvas/use-design-bridge";
import { shareBase } from "./share-api";

/**
 * The design frame of a share link: which page it shows and the bridge to it.
 *
 * Every load gets a fresh nonce on its URL (`?n=`), and reloading means setting a new `src`:
 * the frame's origin is opaque, so `location.reload()` is not the parent's to call. A load
 * that never says `ready` is retried once with a new nonce; failing again, the page says the
 * design stopped responding rather than reloading forever.
 */

/** `/s/<code>/f/<slug>/<file>`, each segment encoded, `file` keeping its own slashes. */
export function frameUrl(code: string, slug: string, file: string): string {
  return `${shareBase(code)}/f/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export function useShareCanvas(code: string, slug: string, file: string) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce, setNonce] = useState(() => newBridgeNonce());
  const [dead, setDead] = useState(false);
  const recovering = useRef(false);

  const recover = useCallback(() => {
    if (recovering.current) { setDead(true); return; }
    recovering.current = true;
    setNonce(newBridgeNonce());
  }, []);
  const bridge = useDesignBridge(iframeRef, nonce, recover);

  // Another page of the design is another document: a new nonce goes with it.
  const shown = useRef(file);
  useEffect(() => {
    if (shown.current === file) return;
    shown.current = file;
    setNonce(newBridgeNonce());
  }, [file]);

  useEffect(() => bridge.on("ready", () => { recovering.current = false; setDead(false); }), [bridge.on]);

  const reload = useCallback(() => {
    recovering.current = false;
    setDead(false);
    setNonce(newBridgeNonce());
  }, []);

  return { iframeRef, src: `${frameUrl(code, slug, file)}?n=${encodeURIComponent(nonce)}`, bridge, dead, reload };
}

export type ShareCanvasState = ReturnType<typeof useShareCanvas>;
