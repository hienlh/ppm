import { create } from "zustand";

/**
 * Which tabs are allowed to be mounted by TabPool.
 *
 * Session-only and deliberately NEVER persisted: a reload must start from an
 * empty set so only the visible tabs mount. Persisting it would recreate the
 * boot request storm this store exists to prevent (a saved workspace with 18
 * chat tabs cost 515 requests / 36.7 MB when every tab mounted eagerly).
 *
 * A tab enters the set the first time it is visible in any panel, and never
 * leaves — that is what preserves TabPool's keep-alive guarantees (xterm
 * buffer, Monaco state, chat scroll) once a tab has actually been opened.
 */
interface MountedTabsStore {
  mounted: Set<string>;
  /** Allow `tabId` to mount from now on. Idempotent. */
  mount: (tabId: string) => void;
}

export const useMountedTabsStore = create<MountedTabsStore>((set) => ({
  mounted: new Set(),
  mount: (tabId) =>
    set((state) => {
      if (state.mounted.has(tabId)) return state;
      const next = new Set(state.mounted);
      next.add(tabId);
      return { mounted: next };
    }),
}));
