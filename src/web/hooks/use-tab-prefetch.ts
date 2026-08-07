import { useEffect } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { useMountedTabsStore } from "@/stores/mounted-tabs-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { pickPrefetchCandidates } from "@/components/layout/tab-prefetch";

/** Tabs warmed per project. Small on purpose — see the cap note below. */
const PREFETCH_CAP = 3;
/** Delay before the first prefetch, so the visible tabs finish their own work. */
const START_DELAY_MS = 2500;
/** Gap between tabs so mounts stay serialized rather than bursting. */
const STEP_MS = 1200;

type IdleHandle = number;

/**
 * Wait `delayMs`, then run `fn` at the next idle moment.
 *
 * The delay must be a real timer. requestIdleCallback's `timeout` option is a
 * deadline (run by then at the latest), not a minimum wait — passing the delay
 * there made all three prefetches fire ~1s into boot, exactly when the visible
 * tabs were still loading. So: setTimeout for the spacing, requestIdleCallback
 * only to avoid landing in the middle of other work.
 */
function scheduleAfterDelayWhenIdle(fn: () => void, delayMs: number): { cancel: () => void } {
  let idleHandle: IdleHandle | undefined;
  const win = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => IdleHandle;
    cancelIdleCallback?: (h: IdleHandle) => void;
  };

  const timer = setTimeout(() => {
    if (win.requestIdleCallback) idleHandle = win.requestIdleCallback(fn, { timeout: 2000 });
    else fn(); // Safari has no requestIdleCallback
  }, delayMs);

  return {
    cancel: () => {
      clearTimeout(timer);
      if (idleHandle !== undefined) win.cancelIdleCallback?.(idleHandle);
    },
  };
}

/**
 * Warm a few recently-used chat tabs during idle time so switching to them is
 * instant, without reintroducing the boot request storm.
 *
 * Deliberately conservative:
 * - **Never on mobile.** Prefetching spends the user's cellular data on tabs they
 *   may not open.
 * - **Capped at 3 and serialized**, one tab per idle tick. Project-scope request
 *   dedup is out of scope for this plan, so each extra tab still costs its own
 *   ~8 requests; mounting many in parallel would recreate the queueing this work
 *   exists to remove.
 * - **Yields to the user.** Any tab activation cancels the remaining queue, so a
 *   real click never waits behind speculative work.
 *
 * Mount once, at app level — not inside a per-tab component.
 */
export function useTabPrefetch(): void {
  const isMobile = useIsMobile();
  const currentProject = usePanelStore((s) => s.currentProject);

  // Panel + mount state is read via getState() inside the effect, not subscribed:
  // prefetching grows `mounted`, which would otherwise retrigger the effect and
  // restart the queue on every step.
  useEffect(() => {
    if (isMobile) return;

    let disposed = false;
    let remaining = PREFETCH_CAP;
    let pending: { cancel: () => void } | null = null;

    const cancelPending = () => {
      pending?.cancel();
      pending = null;
    };

    const step = () => {
      pending = null;
      if (disposed || remaining <= 0) return;
      const { panels } = usePanelStore.getState();
      const { mounted, mount } = useMountedTabsStore.getState();
      const [next] = pickPrefetchCandidates(panels, mounted, 1);
      if (!next) return; // nothing left worth warming
      mount(next);
      remaining--;
      arm(STEP_MS);
    };

    const arm = (delay: number) => {
      if (disposed || remaining <= 0) return;
      cancelPending();
      pending = scheduleAfterDelayWhenIdle(step, delay);
    };

    // A tab becoming active means the user (or a boot-time restore) has something
    // more important in flight. Push our next step back rather than stopping for
    // good: programmatic activations happen during boot (deep-link auto-open,
    // workspace restore, closeTab picking a successor) and a permanent stop there
    // would disable prefetching for the whole session.
    const unsubscribe = usePanelStore.subscribe((state, prev) => {
      if (state.panels === prev.panels) return;
      for (const id of Object.keys(state.panels)) {
        // A newly created panel has no `prev` entry; that is a layout change, not
        // a user switching tabs, so it must not count.
        if (!(id in prev.panels)) continue;
        if (state.panels[id]?.activeTabId !== prev.panels[id]?.activeTabId) {
          arm(START_DELAY_MS);
          return;
        }
      }
    });

    arm(START_DELAY_MS);

    return () => {
      disposed = true;
      cancelPending();
      unsubscribe();
    };
  }, [isMobile, currentProject]);
}
