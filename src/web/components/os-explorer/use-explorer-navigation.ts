/**
 * Directory navigation for one explorer window: fetching, history, and cross-window
 * refresh.
 *
 * Two requests for the same window must never race: a slow `C:\Windows\System32` listing
 * arriving after the user already stepped into another folder would repaint stale rows.
 * Each fetch therefore aborts the previous one and re-checks its own identity before
 * writing to the store.
 */

import { useCallback, useEffect, useRef } from "react";
import { fsApi, FsError } from "@/lib/fs-api";
import { useWindowStore } from "@/components/floating-window/window-store";
import { onFsChanged, useExplorerStore, type ExplorerSlice } from "./explorer-store";

export interface ExplorerNavigation {
  go(path: string, opts?: { replace?: boolean }): void;
  back(): void;
  forward(): void;
  up(): void;
  refresh(): void;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function useExplorerNavigation(
  windowId: string,
  slice: ExplorerSlice | undefined,
  showHidden: boolean,
): ExplorerNavigation {
  const abortRef = useRef<AbortController | null>(null);
  const patch = useExplorerStore((s) => s.patch);

  // The load target is read from a ref so `load` keeps a stable identity: it is a
  // dependency of the fsChanged subscription, which must not resubscribe per keystroke.
  const pathRef = useRef(slice?.path ?? "");
  pathRef.current = slice?.path ?? "";
  const hiddenRef = useRef(showHidden);
  hiddenRef.current = showHidden;

  const load = useCallback(
    async (path: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      patch(windowId, { loading: true, error: null });
      try {
        const result = await fsApi.browse(path, {
          showHidden: hiddenRef.current,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        patch(windowId, {
          entries: result.entries,
          breadcrumbs: result.breadcrumbs,
          parent: result.parent,
          sep: result.sep,
          truncated: result.truncated === true,
          loading: false,
          error: null,
        });
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        patch(windowId, {
          loading: false,
          entries: [],
          error:
            e instanceof FsError
              ? { message: e.message, code: e.code, hint: e.hint }
              : { message: e instanceof Error ? e.message : "Failed to read directory", code: "EUNKNOWN" },
        });
      }
    },
    [windowId, patch],
  );

  // Fetch whenever the target directory or the hidden-files preference changes.
  const path = slice?.path;
  useEffect(() => {
    if (!path) return;
    void load(path);
    return () => abortRef.current?.abort();
  }, [path, showHidden, load]);

  // Another window (or this one) mutated a directory we are displaying.
  useEffect(() => {
    return onFsChanged((dir) => {
      if (dir === pathRef.current) void load(dir);
    });
  }, [load]);

  const go = useCallback(
    (target: string, opts?: { replace?: boolean }) => {
      const current = useExplorerStore.getState().slices[windowId];
      if (!current || target === current.path) return;
      const history = opts?.replace
        ? [...current.history.slice(0, current.historyIndex), target]
        : [...current.history.slice(0, current.historyIndex + 1), target];
      patch(windowId, {
        path: target,
        history: history.slice(-100),
        historyIndex: Math.min(history.length, 100) - 1,
        selection: new Set(),
        anchor: null,
        filter: "",
        inlineEdit: null,
      });
      // Keeps the titlebar in step and makes the window reopen here after a reload.
      useWindowStore.getState().setPayload(windowId, { path: target });
    },
    [windowId, patch],
  );

  const step = useCallback(
    (delta: number) => {
      const current = useExplorerStore.getState().slices[windowId];
      if (!current) return;
      const index = current.historyIndex + delta;
      const target = current.history[index];
      if (target == null) return;
      patch(windowId, {
        path: target,
        historyIndex: index,
        selection: new Set(),
        anchor: null,
        filter: "",
        inlineEdit: null,
      });
      useWindowStore.getState().setPayload(windowId, { path: target });
    },
    [windowId, patch],
  );

  const back = useCallback(() => step(-1), [step]);
  const forward = useCallback(() => step(1), [step]);

  const up = useCallback(() => {
    const current = useExplorerStore.getState().slices[windowId];
    if (current?.parent) go(current.parent);
  }, [windowId, go]);

  const refresh = useCallback(() => {
    if (pathRef.current) void load(pathRef.current);
  }, [load]);

  return {
    go,
    back,
    forward,
    up,
    refresh,
    canGoBack: (slice?.historyIndex ?? 0) > 0,
    canGoForward: slice ? slice.historyIndex < slice.history.length - 1 : false,
  };
}
