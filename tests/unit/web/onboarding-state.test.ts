import { describe, expect, test } from "bun:test";
import { advanceOnboarding, hydrateOnboarding, initialOnboardingState, serializeOnboarding } from "../../../src/web/lib/onboarding/onboarding-state";
import { getOnboardingSteps } from "../../../src/web/lib/onboarding/onboarding-steps";
import { getOnboardingCopy } from "../../../src/web/lib/onboarding/onboarding-copy";
import { useOnboardingStore } from "../../../src/web/stores/onboarding-store";

describe("onboarding choices and persistence", () => {
  test("all nine choice pairs use the goal route and distinct explanation depth", () => {
    for (const goal of ["ai", "explore", "developer"] as const) {
      const bodies = new Set<string>();
      for (const familiarity of ["beginner", "familiar", "advanced"] as const) {
        useOnboardingStore.setState(initialOnboardingState());
        const actions = useOnboardingStore.getState();
        actions.begin(); actions.chooseFamiliarity(familiarity); actions.chooseGoal(goal); actions.start("demo");
        expect(useOnboardingStore.getState().currentStep).toBe(getOnboardingSteps(goal)[1]);
        expect(useOnboardingStore.getState().completed).toEqual(["project"]);
        bodies.add(getOnboardingCopy("project", familiarity).body);
      }
      expect(bodies.size).toBe(3);
    }
  });

  test("active hydration pauses and discards transient evidence", () => {
    const state = { ...initialOnboardingState(), status: "active" as const, goal: "developer" as const,
      familiarity: "beginner" as const, currentStep: "run" as const, runDocumentReady: true,
      attempt: { id: "a", tabId: "t", sessionId: "s", failed: false } };
    const serialized = serializeOnboarding(state);
    expect(serialized).not.toContain("attempt");
    expect(serialized).not.toContain("runDocumentReady");
    const hydrated = hydrateOnboarding(serialized);
    expect(hydrated.status).toBe("paused");
    expect(hydrated.runDocumentReady).toBe(false);
    expect(hydrated.attempt).toBeNull();
  });

  test("invalid storage and schemas reset safely", () => {
    for (const raw of [null, "{broken", "null", "[]", '{"version":2}', JSON.stringify({ ...initialOnboardingState(), currentStep: "unknown" })]) {
      expect(hydrateOnboarding(raw)).toEqual(initialOnboardingState());
    }
  });

  test("all skipped finishes guidance without reporting completed tasks", () => {
    let state = { ...initialOnboardingState(), status: "active" as const, goal: "explore" as const,
      familiarity: "beginner" as const, currentStep: "project" as const } as ReturnType<typeof initialOnboardingState>;
    for (let index = 0; index < 3; index++) state = advanceOnboarding(state, true);
    expect(state.status).toBe("finished");
    expect(state.completed).toEqual([]);
    expect(state.skipped).toEqual(["project", "file", "search"]);
  });

  test("project switch pauses; explicit resume resets project-specific evidence", () => {
    useOnboardingStore.setState(initialOnboardingState());
    const actions = useOnboardingStore.getState();
    actions.chooseFamiliarity("advanced"); actions.chooseGoal("developer"); actions.start("first");
    actions.observe({ type: "terminal-ready", projectName: "first", visible: true, tabId: "t" });
    actions.setProjectContext("second");
    expect(useOnboardingStore.getState().status).toBe("paused");
    expect(useOnboardingStore.getState().projectName).toBe("first");
    actions.resume("second");
    expect(useOnboardingStore.getState().currentStep).toBe("terminal");
    expect(useOnboardingStore.getState().completed).toEqual(["project"]);
    expect(useOnboardingStore.getState().projectName).toBe("second");
  });

  test("dismiss and replay affect only onboarding; changing goal drops route evidence", () => {
    const actions = useOnboardingStore.getState();
    actions.dismiss();
    expect(hydrateOnboarding(serializeOnboarding(useOnboardingStore.getState())).status).toBe("dismissed");
    actions.replay();
    expect(useOnboardingStore.getState().status).toBe("choosing");
    expect(useOnboardingStore.getState().completed).toEqual([]);
    actions.chooseFamiliarity("familiar"); actions.chooseGoal("explore"); actions.start("demo");
    actions.observe({ type: "file-ready", projectName: "demo", visible: true, tabId: "t" });
    actions.changeChoices(); actions.chooseGoal("ai"); actions.start("demo");
    expect(useOnboardingStore.getState().completed).toEqual(["project"]);
    expect(useOnboardingStore.getState().currentStep).toBe("chat");
  });

  test("pausing incomplete setup retains the selected familiarity on reload", () => {
    useOnboardingStore.setState(initialOnboardingState());
    const actions = useOnboardingStore.getState();
    actions.begin(); actions.chooseFamiliarity("familiar"); actions.pause();
    const restored = hydrateOnboarding(serializeOnboarding(useOnboardingStore.getState()));
    expect(restored.status).toBe("paused");
    expect(restored.familiarity).toBe("familiar");
    useOnboardingStore.setState(restored);
    actions.resume();
    expect(useOnboardingStore.getState().status).toBe("choosing");
  });

  test("pause invalidates a pending turn and back preserves real completed actions", () => {
    const actions = useOnboardingStore.getState();
    actions.chooseGoal("ai"); actions.start("demo");
    actions.observe({ type: "chat-opened", projectName: "demo", visible: true, tabId: "chat" });
    actions.observe({ type: "chat-started", projectName: "demo", visible: true, tabId: "chat", sessionId: "s", attemptId: "a" });
    actions.pause();
    expect(useOnboardingStore.getState().attempt).toBeNull();
    actions.resume("demo"); actions.back();
    expect(useOnboardingStore.getState().currentStep).toBe("chat");
    expect(useOnboardingStore.getState().completed).toContain("chat");
  });
});
