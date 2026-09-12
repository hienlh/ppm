import { create } from "zustand";

/**
 * Whether a screen wake lock is being held right now.
 *
 * Deliberately separate from "should we be holding one". The browser grants the lock on its
 * own terms and takes it back without asking — battery saver, a low battery, or the tab
 * being hidden all revoke it — so the indicator has to report what actually happened rather
 * than what was requested. `use-wake-lock.ts` is the only writer.
 */
interface WakeLockStore {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const useWakeLockStore = create<WakeLockStore>((set) => ({
  active: false,
  // Same-value writes are dropped so a re-acquire that changes nothing does not
  // re-render the indicator.
  setActive: (active) => set((s) => (s.active === active ? s : { active })),
}));
