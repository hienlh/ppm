import { getOnboardingSteps } from "./onboarding-steps";
import type { OnboardingEvent, OnboardingState, OnboardingStepId } from "./onboarding-types";

export function initialOnboardingState(): OnboardingState {
  return { version: 1, status: "unseen", familiarity: null, goal: null, currentStep: null,
    completed: [], skipped: [], projectName: null, sessionId: null, attempt: null, runDocumentReady: false };
}

export function advanceOnboarding(state: OnboardingState, skipped = false): OnboardingState {
  if (state.status !== "active" || !state.currentStep) return state;
  const completed = state.completed.filter((id) => id !== state.currentStep);
  const omitted = state.skipped.filter((id) => id !== state.currentStep);
  (skipped ? omitted : completed).push(state.currentStep);
  const route = getOnboardingSteps(state.goal);
  const next = route.slice(route.indexOf(state.currentStep) + 1).find((id) => !completed.includes(id) && !omitted.includes(id));
  return { ...state, completed, skipped: omitted, currentStep: next ?? state.currentStep, status: next ? "active" : "finished" };
}

export function observeOnboarding(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  // Failure invalidates an already tracked turn even if its tab just became hidden.
  if (event.type === "chat-failed" && event.projectName === state.projectName && state.attempt?.id === event.attemptId &&
      state.attempt.tabId === event.tabId && state.attempt.sessionId === event.sessionId) {
    return { ...state, attempt: { ...state.attempt, failed: true } };
  }
  if (state.status !== "active" || !event.visible || event.projectName !== state.projectName) return state;
  const step = state.currentStep;
  if (event.type === "run-document-ready" && step === "run") return { ...state, runDocumentReady: true };
  if (event.type === "chat-opened" && step === "chat") return advanceOnboarding(state);
  if (event.type === "chat-started" && step === "send") {
    if (state.attempt?.id === event.attemptId) return state;
    return { ...state, sessionId: event.sessionId, attempt: { id: event.attemptId, tabId: event.tabId, sessionId: event.sessionId, failed: false } };
  }
  if (event.type === "chat-session" && state.attempt?.id === event.attemptId && state.attempt.tabId === event.tabId && state.attempt.sessionId === event.previousSessionId) {
    return { ...state, sessionId: event.sessionId, attempt: { ...state.attempt, sessionId: event.sessionId } };
  }
  if (event.type === "chat-failed" || event.type === "chat-succeeded") {
    const attempt = state.attempt;
    if (!attempt || attempt.id !== event.attemptId || attempt.tabId !== event.tabId || attempt.sessionId !== event.sessionId) return state;
    if (event.type === "chat-failed") return { ...state, attempt: { ...attempt, failed: true } };
    return step === "send" && !attempt.failed && event.hasContent ? advanceOnboarding(state) : state;
  }
  if (event.type === "history-opened" && step === "history" && state.completed.includes("send") && event.sessionId === state.sessionId) return advanceOnboarding(state);
  if (event.type === "file-ready") {
    if (step === "file") return advanceOnboarding(state);
    if (step === "run" && event.isRunDocument) return { ...state, runDocumentReady: true };
  }
  if ((event.type === "search-succeeded" && step === "search") ||
      (event.type === "terminal-ready" && step === "terminal") ||
      (event.type === "git-ready" && step === "git") ||
      (event.type === "run-acknowledged" && step === "run" && state.runDocumentReady)) return advanceOnboarding(state);
  return state;
}

/** Select only durable fields: no paths, drafts, queries or runtime evidence. */
export function serializeOnboarding(state: OnboardingState): string {
  const { version, status, familiarity, goal, currentStep, completed, skipped, projectName, sessionId } = state;
  return JSON.stringify({ version, status, familiarity, goal, currentStep, completed, skipped, projectName, sessionId });
}

export function hydrateOnboarding(raw: string | null): OnboardingState {
  const initial = initialOnboardingState();
  if (!raw) return initial;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !["unseen", "choosing", "active", "paused", "dismissed", "finished"].includes(value.status) ||
        ![null, "beginner", "familiar", "advanced"].includes(value.familiarity) || ![null, "ai", "explore", "developer"].includes(value.goal)) return initial;
    const route = getOnboardingSteps(value.goal);
    if (value.currentStep !== null && !route.includes(value.currentStep)) return initial;
    if (![value.completed, value.skipped].every((list) => Array.isArray(list) && list.every((id) => route.includes(id)))) return initial;
    if (![value.projectName, value.sessionId].every((id) => id === null || typeof id === "string")) return initial;
    if (["active", "finished"].includes(value.status) && (!value.familiarity || !value.goal || !value.currentStep)) return initial;
    const completed = [...new Set<OnboardingStepId>(value.completed)];
    const skipped = [...new Set<OnboardingStepId>(value.skipped)].filter((id) => !completed.includes(id));
    return { ...initial, status: value.status === "active" ? "paused" : value.status, familiarity: value.familiarity,
      goal: value.goal, currentStep: value.currentStep, completed, skipped, projectName: value.projectName, sessionId: value.sessionId };
  } catch { return initial; }
}
