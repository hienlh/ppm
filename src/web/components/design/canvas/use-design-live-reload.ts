import { useEffect, useRef } from "react";
import { classifyDesignChange } from "@/lib/design/design-change-filter";

/**
 * Keep the canvas in step with the design's files.
 *
 * While the design's project is the active one, the file watcher reports every change and
 * a burst of them (an agent writing three files) becomes one reload 300 ms after the last.
 * The watcher follows the active project only, though, so a canvas that was hidden — another
 * project, another tab, a backgrounded browser — asks the server when it comes back: a HEAD
 * on its preview URL answers with the page's current `X-PPM-Gen`, and a gen other than the
 * one the frame last reported means it is showing an old version.
 */

export const LIVE_RELOAD_DEBOUNCE_MS = 300;

export interface LiveReloadOptions {
  projectName: string;
  slug: string;
  /** True while the design tab is the visible tab of its panel. */
  isActive: boolean;
  reload: (opts?: { remint?: boolean }) => void;
  onManifestChanged: () => void;
  /** The URL the frame is showing now (for the gen check), or null while none is loaded. */
  currentUrl: () => string | null;
  /** The gen the frame last reported in `ready`, or null while none has. */
  readyGen: () => string | null;
}

export function useDesignLiveReload(opts: LiveReloadOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { projectName, slug, isActive } = opts;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ projectName?: string; path?: string }>).detail;
      if (!detail || detail.projectName !== projectName || typeof detail.path !== "string") return;
      const change = classifyDesignChange(detail.path, slug);
      if (change === "manifest") optsRef.current.onManifestChanged();
      if (change !== "reload") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        optsRef.current.reload();
      }, LIVE_RELOAD_DEBOUNCE_MS);
    };
    window.addEventListener("file:changed", onChange);
    return () => {
      window.removeEventListener("file:changed", onChange);
      if (timer) clearTimeout(timer);
    };
  }, [projectName, slug]);

  const wasActive = useRef(isActive);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const { currentUrl, readyGen, reload } = optsRef.current;
      const url = currentUrl();
      const gen = readyGen();
      if (!url || !gen) return;
      try {
        const res = await fetch(url, { method: "HEAD", cache: "no-store", referrerPolicy: "no-referrer" });
        if (cancelled) return;
        if (res.status === 404) { reload({ remint: true }); return; }
        const current = res.headers.get("X-PPM-Gen");
        if (res.ok && current && current !== gen) reload();
      } catch (e) {
        // Offline or a server restart in progress: the frame's own liveness check covers it.
        console.warn(`[design] gen check for ${slug} failed: ${(e as Error).message}`);
      }
    };
    if (isActive && !wasActive.current) void check();
    wasActive.current = isActive;
    const onVisibility = () => {
      if (document.visibilityState === "visible" && optsRef.current.isActive) void check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isActive, slug]);
}
