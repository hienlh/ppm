import type { OnboardingGoal, OnboardingStepId } from "./onboarding-types";

const routes: Record<OnboardingGoal, readonly OnboardingStepId[]> = {
  ai: ["project", "chat", "send", "history"],
  explore: ["project", "file", "search"],
  developer: ["project", "terminal", "git", "run"],
};

export function getOnboardingSteps(goal: OnboardingGoal | null): readonly OnboardingStepId[] {
  return goal ? routes[goal] : [];
}

export const ONBOARDING_TARGETS: Record<OnboardingStepId, string> = {
  project: "project", chat: "chat", send: "chat-input", history: "chat-history",
  file: "explorer", search: "search", terminal: "terminal", git: "git", run: "explorer",
};
