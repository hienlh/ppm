import { expect, test } from "bun:test";
import { chooseRunInstructions } from "../../../src/web/lib/onboarding/run-instructions";
import { initialOnboardingState, observeOnboarding } from "../../../src/web/lib/onboarding/onboarding-state";

test("run instructions prefer readable README files, then package.json, never directories or PDFs", () => {
  const file = (name: string) => ({ name, type: "file" as const });
  expect(chooseRunInstructions([file("package.json"), file("README.md")])).toBe("README.md");
  expect(chooseRunInstructions([file("README.PDF"), file("package.json")])).toBe("package.json");
  expect(chooseRunInstructions([{ name: "README.md", type: "directory" }, file("readme.txt")])).toBe("readme.txt");
  expect(chooseRunInstructions([file("index.js")])).toBeUndefined();
});

test("README preview enables run acknowledgment only in the active matching project", () => {
  const state = { ...initialOnboardingState(), status: "active" as const, goal: "developer" as const,
    currentStep: "run" as const, projectName: "demo" };
  const event = { type: "run-document-ready" as const, projectName: "demo", tabId: "readme", visible: true };
  expect(observeOnboarding(state, event).runDocumentReady).toBe(true);
  expect(observeOnboarding(state, { ...event, visible: false }).runDocumentReady).toBe(false);
  expect(observeOnboarding(state, { ...event, projectName: "other" }).runDocumentReady).toBe(false);
  expect(observeOnboarding({ ...state, status: "paused" }, event).runDocumentReady).toBe(false);
  expect(observeOnboarding({ ...state, goal: "explore", currentStep: "file" }, event).completed).toEqual([]);
});
