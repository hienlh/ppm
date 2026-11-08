/**
 * The tour's "PPM has new features" part for this app open. What has been asked and answered is
 * the server's (install-wide, `/api/feature-intros`); this store only remembers what this page
 * load already did, so one open records at most one skip per feature, and a refetch after this
 * device's own answer or skip does not bring the question back. Nothing here is persisted: a
 * reload is a new app open.
 */
import { create } from "zustand";
import type { FeatureIntro, FeatureIntroAnswer, FeatureIntrosView } from "../../shared/feature-intros";
import {
  fetchFeatureIntros, postFeatureIntroAnswer, postFeatureIntroSkip,
} from "@/lib/onboarding/feature-intros-client";

interface FeatureIntrosState {
  view: FeatureIntrosView | null;
  /** Ids in the order they were first shown, so the counter does not jump on a refetch. */
  order: string[];
  /** Answered or put off on this device during this app open. */
  handled: string[];
  /** Skips already recorded during this app open. */
  skipped: string[];
  /** The part was closed for the rest of this app open. */
  closed: boolean;
  busy: boolean;
  error: string | null;
}

interface FeatureIntrosActions {
  load: () => Promise<void>;
  answer: (id: string, answer: FeatureIntroAnswer) => Promise<void>;
  later: (id: string) => Promise<void>;
  /** Closing without answering puts off every feature not yet handled, once per app open. */
  close: () => Promise<void>;
  /** Hides the part for this app open without counting a skip: the user went to decide in Settings. */
  hide: () => void;
  reset: () => void;
}

const initial: FeatureIntrosState = { view: null, order: [], handled: [], skipped: [], closed: false, busy: false, error: null };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useFeatureIntrosStore = create<FeatureIntrosState & FeatureIntrosActions>((set, get) => {
  /** Records one skip, unless this app open already recorded one for `id`. */
  const skipOnce = async (id: string): Promise<void> => {
    if (get().skipped.includes(id)) return;
    set((s) => ({ skipped: [...s.skipped, id] }));
    await postFeatureIntroSkip(id);
  };
  const markHandled = (id: string) => set((s) => ({ handled: s.handled.includes(id) ? s.handled : [...s.handled, id] }));

  return {
    ...initial,
    load: async () => {
      try {
        const view = await fetchFeatureIntros();
        if (!view) return;
        set((s) => ({ view, order: [...s.order, ...view.pending.map((i) => i.id).filter((id) => !s.order.includes(id))] }));
      } catch (e) {
        // Asking about new features is never worth an error in the user's way; the next open asks.
        console.warn(`Could not load the new-feature introductions: ${errorText(e)}`);
      }
    },
    answer: async (id, answer) => {
      set({ busy: true, error: null });
      try {
        await postFeatureIntroAnswer(id, answer);
        markHandled(id);
        set({ busy: false });
      } catch (e) {
        set({ busy: false, error: `Could not save your choice: ${errorText(e)}` });
      }
    },
    later: async (id) => {
      markHandled(id);
      try { await skipOnce(id); }
      catch (e) { console.warn(`Could not record "Later" for ${id}: ${errorText(e)}`); }
    },
    close: async () => {
      const open = featureIntroSteps(get()).remaining.map((intro) => intro.id);
      set({ closed: true, error: null });
      for (const id of open) {
        markHandled(id);
        try { await skipOnce(id); }
        catch (e) { console.warn(`Could not record closing the introduction of ${id}: ${errorText(e)}`); }
      }
    },
    hide: () => set({ closed: true, error: null }),
    reset: () => set(initial),
  };
});

/**
 * The part's steps: every feature still pending on the server or handled here, in first-seen
 * order. A feature another device answered drops out; one this device handled stays counted.
 */
export function featureIntroSteps(state: Pick<FeatureIntrosState, "view" | "order" | "handled">): {
  steps: string[]; remaining: FeatureIntro[]; current: FeatureIntro | null;
} {
  const pending = new Map((state.view?.pending ?? []).map((intro) => [intro.id, intro]));
  const steps = state.order.filter((id) => pending.has(id) || state.handled.includes(id));
  const remaining = steps.filter((id) => !state.handled.includes(id)).map((id) => pending.get(id)!).filter(Boolean);
  return { steps, remaining, current: remaining[0] ?? null };
}
