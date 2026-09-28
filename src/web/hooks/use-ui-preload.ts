import { useEffect } from "react";
import { tabPreloads } from "@/components/layout/tab-pool";
import { WINDOW_CONTENT } from "@/components/floating-window/window-content-registry";
import { isTouchOnlyDevice } from "@/hooks/use-is-touch-only";
import { preloadWhenIdle, shouldPreloadUi, type ConnectionHints } from "@/lib/preload-ui";

/** The head start the tabs a workspace restores get, as in `use-tab-prefetch.ts`. */
const START_DELAY_MS = 2500;

/** Imported, not reached statically: that would pull Settings' shell into the boot chunk. */
const preloadSettingsPanes = () =>
  import("@/components/settings/settings-section-content").then((m) => m.preloadSettingsSections());

/**
 * Loads the code of every kind of tab and window, and of every Settings pane, once the app has
 * settled, so the first one of each opens at once. Not under `vite dev`, where it would be
 * hundreds of unbundled modules.
 */
export function useUiPreload(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || import.meta.env.DEV) return;
    const connection = (navigator as Navigator & { connection?: ConnectionHints }).connection;
    if (!shouldPreloadUi(connection, isTouchOnlyDevice())) return;

    let stop = () => {};
    const timer = setTimeout(() => {
      stop = preloadWhenIdle([
        ...tabPreloads(),
        ...Object.values(WINDOW_CONTENT).map((content) => content.preload),
        preloadSettingsPanes,
      ]);
    }, START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [enabled]);
}
