import { describe, expect, test } from "bun:test";
import { initialOnboardingState, observeOnboarding } from "../../../src/web/lib/onboarding/onboarding-state";
import type { OnboardingState } from "../../../src/web/lib/onboarding/onboarding-types";

function chatState(): OnboardingState {
  return { ...initialOnboardingState(), status: "active", familiarity: "beginner", goal: "ai",
    projectName: "demo", currentStep: "send", completed: ["project", "chat"] };
}
const scope = { projectName: "demo", visible: true, tabId: "chat", sessionId: "session", attemptId: "attempt" };

describe("onboarding outcome evidence", () => {
  test("only an observed matching substantive successful turn completes sending", () => {
    let state = chatState();
    const success = { type: "chat-succeeded" as const, ...scope, hasContent: true };
    expect(observeOnboarding(state, success)).toBe(state);
    state = observeOnboarding(state, { type: "chat-started", ...scope });
    for (const invalid of [{ visible: false }, { projectName: "other" }, { tabId: "other" }, { sessionId: "other" }, { attemptId: "old" }, { hasContent: false }]) {
      expect(observeOnboarding(state, { ...success, ...invalid })).toBe(state);
    }
    state = observeOnboarding(state, success);
    expect(state.currentStep).toBe("history");
    expect(observeOnboarding(state, success)).toBe(state);
    state = observeOnboarding(state, { type: "history-opened", ...scope });
    expect(state.status).toBe("finished");
  });

  test("failure is sticky for an attempt, including duplicate started events", () => {
    let state = observeOnboarding(chatState(), { type: "chat-started", ...scope });
    state = observeOnboarding(state, { type: "chat-failed", ...scope, visible: false });
    state = observeOnboarding(state, { type: "chat-started", ...scope });
    expect(observeOnboarding(state, { type: "chat-succeeded", ...scope, hasContent: true }).currentStep).toBe("send");
    const retry = { ...scope, attemptId: "retry" };
    state = observeOnboarding(state, { type: "chat-started", ...retry });
    expect(observeOnboarding(state, { type: "chat-succeeded", ...retry, hasContent: true }).currentStep).toBe("history");
  });

  test("canonical session migration preserves attempt and rejects stale completion", () => {
    let state = observeOnboarding(chatState(), { type: "chat-started", ...scope });
    state = observeOnboarding(state, { type: "chat-session", ...scope, previousSessionId: "session", sessionId: "canonical" });
    expect(state.sessionId).toBe("canonical");
    expect(observeOnboarding(state, { type: "chat-succeeded", ...scope, hasContent: true })).toBe(state);
    expect(observeOnboarding(state, { type: "chat-succeeded", ...scope, sessionId: "canonical", hasContent: true }).currentStep).toBe("history");
  });

  test("paused or wrong-project readiness never advances", () => {
    const state: OnboardingState = { ...chatState(), goal: "explore", currentStep: "file" };
    const ready = { type: "file-ready" as const, projectName: "demo", visible: true, tabId: "editor" };
    expect(observeOnboarding(state, { ...ready, visible: false })).toBe(state);
    expect(observeOnboarding(state, { ...ready, projectName: "wrong" })).toBe(state);
    expect(observeOnboarding({ ...state, status: "paused" }, ready).status).toBe("paused");
    expect(observeOnboarding(state, ready).currentStep).toBe("search");
  });

  test("run acknowledgement requires a ready documentation file", () => {
    let state: OnboardingState = { ...chatState(), goal: "developer", currentStep: "run" };
    const ack = { type: "run-acknowledged" as const, projectName: "demo", visible: true };
    expect(observeOnboarding(state, ack)).toBe(state);
    state = observeOnboarding(state, { type: "file-ready", ...scope, isRunDocument: false });
    expect(state.runDocumentReady).toBe(false);
    state = observeOnboarding(state, { type: "file-ready", ...scope, isRunDocument: true });
    expect(state.runDocumentReady).toBe(true);
    expect(observeOnboarding(state, ack).status).toBe("finished");
  });
});
