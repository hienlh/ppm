import { create } from "zustand";
import { advanceOnboarding, hydrateOnboarding, initialOnboardingState, observeOnboarding, serializeOnboarding } from "../lib/onboarding/onboarding-state";
import { getOnboardingSteps } from "../lib/onboarding/onboarding-steps";
import type { OnboardingEvent, OnboardingFamiliarity, OnboardingGoal, OnboardingState } from "../lib/onboarding/onboarding-types";

export const ONBOARDING_STORAGE_KEY = "ppm-onboarding-v1";
interface OnboardingActions {
  begin: () => void;
  chooseFamiliarity: (value: OnboardingFamiliarity) => void;
  chooseGoal: (value: OnboardingGoal) => void;
  start: (projectName?: string | null) => void;
  pause: () => void;
  dismiss: () => void;
  resume: (projectName?: string | null) => void;
  replay: () => void;
  skip: () => void;
  back: () => void;
  changeChoices: () => void;
  observe: (event: OnboardingEvent) => void;
  setProjectContext: (name: string | null) => void;
}

function readState(): OnboardingState {
  try { return hydrateOnboarding(typeof localStorage === "undefined" ? null : localStorage.getItem(ONBOARDING_STORAGE_KEY)); }
  catch { return initialOnboardingState(); }
}

export const useOnboardingStore = create<OnboardingState & OnboardingActions>((set, get) => {
  const activate = (name?: string | null) => set((state) => {
    if (!state.goal || !state.familiarity) return { status: "choosing" as const };
    const projectName = name === undefined ? state.projectName : name;
    const changed = projectName !== state.projectName;
    const next: OnboardingState = { ...state, status: "active", projectName,
      currentStep: changed || !state.currentStep ? "project" : state.currentStep,
      completed: changed ? [] : state.completed, skipped: changed ? [] : state.skipped,
      attempt: changed ? null : state.attempt, sessionId: changed ? null : state.sessionId,
      runDocumentReady: changed ? false : state.runDocumentReady };
    return next.currentStep === "project" && projectName ? advanceOnboarding(next) : next;
  });
  return {
    ...readState(),
    begin: () => set({ status: "choosing" }),
    chooseFamiliarity: (familiarity) => set({ familiarity }),
    chooseGoal: (goal) => set((state) => state.goal === goal ? { goal } : {
      goal, currentStep: "project", completed: state.completed.includes("project") && state.projectName ? ["project"] : [],
      skipped: [], sessionId: null, attempt: null, runDocumentReady: false,
    }),
    start: activate,
    pause: () => set((state) => state.status === "active" || state.status === "choosing" ? { status: "paused", attempt: null } : {}),
    dismiss: () => set({ status: "dismissed", attempt: null }),
    resume: activate,
    replay: () => set({ ...initialOnboardingState(), status: "choosing" }),
    skip: () => set((state) => advanceOnboarding(state, true)),
    back: () => set((state) => {
      const route = getOnboardingSteps(state.goal);
      const index = state.currentStep ? route.indexOf(state.currentStep) : -1;
      return index > 0 ? { currentStep: route[index - 1], status: "active" } : {};
    }),
    changeChoices: () => set({ status: "choosing", attempt: null }),
    observe: (event) => set((state) => observeOnboarding(state, event)),
    setProjectContext: (name) => {
      const state = get();
      if (state.status !== "active") return;
      if (state.currentStep === "project" && name) {
        set(advanceOnboarding({ ...state, projectName: name }));
      } else if (name !== state.projectName) set({ status: "paused", attempt: null, runDocumentReady: false });
    },
  };
});

useOnboardingStore.subscribe((state) => {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(ONBOARDING_STORAGE_KEY, serializeOnboarding(state)); }
  catch { /* Guidance remains usable when browser storage is unavailable. */ }
});
