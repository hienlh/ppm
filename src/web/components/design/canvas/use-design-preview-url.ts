import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestCanvasPreview } from "@/lib/design/api-designs";

/**
 * The canvas's capability URL for one design.
 *
 * Minted once when the canvas mounts, then refreshed through the authenticated API every
 * 10 minutes while it stays mounted — the iframe's own requests never extend a token. A
 * refresh may rotate the token; the successor is kept for the *next* load and the document
 * on screen is never reloaded for it (its old token stays valid until its own expiry).
 *
 * `remint` gets a fresh token outright: the recovery path when the frame reports its token
 * expired, or stopped answering.
 */

export const PREVIEW_REFRESH_MS = 10 * 60 * 1000;

export interface DesignPreviewUrl {
  /** The URL the next load should use (the newest token), or null before the first mint. */
  latestUrl: () => string | null;
  /** Set once the first mint finished; a change asks the canvas to load it. */
  initialUrl: string | null;
  error: string | null;
  remint: () => Promise<string | null>;
}

export function useDesignPreviewUrl(projectName: string, slug: string): DesignPreviewUrl {
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<{ url: string; token: string } | null>(null);
  const alive = useRef(true);

  const remint = useCallback(async (): Promise<string | null> => {
    try {
      const cap = await requestCanvasPreview(projectName, slug);
      if (!alive.current) return null;
      latest.current = { url: cap.url, token: cap.token };
      setError(null);
      return cap.url;
    } catch (e) {
      if (alive.current) setError((e as Error).message || "Could not open the preview");
      return null;
    }
  }, [projectName, slug]);

  useEffect(() => {
    alive.current = true;
    latest.current = null;
    setInitialUrl(null);
    void remint().then((url) => { if (url) setInitialUrl(url); });
    return () => { alive.current = false; };
  }, [remint]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = latest.current;
      if (!current) return;
      requestCanvasPreview(projectName, slug, current.token)
        .then((cap) => {
          // Only the token for the next load changes; the frame on screen keeps its own.
          if (alive.current && cap.rotated) latest.current = { url: cap.url, token: cap.token };
        })
        .catch((e) => {
          // An expired token cannot be refreshed; the frame posts `expired` on its next
          // load and the canvas re-mints then. Anything else is worth a line in the console.
          console.warn(`[design] preview refresh for ${slug} failed: ${(e as Error).message}`);
        });
    }, PREVIEW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [projectName, slug]);

  const latestUrl = useCallback(() => latest.current?.url ?? null, []);
  return useMemo(() => ({ latestUrl, initialUrl, error, remint }), [latestUrl, initialUrl, error, remint]);
}
