export type OnboardingFamiliarity = "beginner" | "familiar" | "advanced";
export type OnboardingGoal = "ai" | "explore" | "developer";
export type OnboardingStatus = "unseen" | "choosing" | "active" | "paused" | "dismissed" | "finished";
export type OnboardingStepId = "project" | "chat" | "send" | "history" | "file" | "search" | "terminal" | "git" | "run";

type Scope = { projectName: string; visible: boolean };
type ChatScope = Scope & { tabId: string; sessionId: string; attemptId: string };
export type OnboardingEvent =
  | (Scope & { type: "chat-opened"; tabId: string; sessionId?: string | null })
  | (ChatScope & { type: "chat-started" })
  | (ChatScope & { type: "chat-failed" })
  | (ChatScope & { type: "chat-succeeded"; hasContent: boolean })
  | (ChatScope & { type: "chat-session"; previousSessionId: string })
  | (Scope & { type: "history-opened"; tabId: string; sessionId: string })
  | (Scope & { type: "file-ready"; tabId: string; isRunDocument?: boolean })
  | (Scope & { type: "run-document-ready"; tabId: string })
  | (Scope & { type: "search-succeeded"; requestId: string })
  | (Scope & { type: "terminal-ready"; tabId: string })
  | (Scope & { type: "git-ready" | "run-acknowledged" });

export interface OnboardingState {
  version: 1;
  status: OnboardingStatus;
  familiarity: OnboardingFamiliarity | null;
  goal: OnboardingGoal | null;
  currentStep: OnboardingStepId | null;
  completed: OnboardingStepId[];
  skipped: OnboardingStepId[];
  projectName: string | null;
  sessionId: string | null;
  /** Transient evidence is deliberately excluded from persistence. */
  attempt: { id: string; tabId: string; sessionId: string; failed: boolean } | null;
  runDocumentReady: boolean;
}

export const ONBOARDING_EVENT = "ppm:onboarding-evidence";
export function emitOnboardingEvidence(event: OnboardingEvent): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: event }));
}
