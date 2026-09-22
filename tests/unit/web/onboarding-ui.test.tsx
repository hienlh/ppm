import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { act } from "react";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);
const { OnboardingSetup } = await import("../../../src/web/components/onboarding/onboarding-setup");
const { OnboardingEntry } = await import("../../../src/web/components/onboarding/onboarding-entry");
const { OnboardingGuide } = await import("../../../src/web/components/onboarding/onboarding-guide");
const { useOnboardingStore } = await import("../../../src/web/stores/onboarding-store");
const { initialOnboardingState } = await import("../../../src/web/lib/onboarding/onboarding-state");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
let view: Mounted | null = null;

beforeEach(() => {
  useOnboardingStore.setState(initialOnboardingState());
  useProjectStore.setState({ activeProject: { name: "tour", path: "/tmp/tour" } as any });
});
afterEach(async () => { await view?.unmount(); view = null; });
function button(label: string) {
  return Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes(label)) ?? null;
}
function SetupHarness() {
  const status = useOnboardingStore((s) => s.status);
  return status === "choosing" ? <OnboardingSetup projectName="tour" /> : <OnboardingEntry />;
}
const levels = [
  ["beginner", "I'm just getting started"],
  ["familiar", "I've used similar tools"],
  ["advanced", "I'm a developer / advanced user"],
] as const;
const goals = [
  ["ai", "Work with AI", "chat"],
  ["explore", "Explore a project", "file"],
  ["developer", "Use development tools", "terminal"],
] as const;

for (const [level, levelLabel] of levels) {
  for (const [goal, goalLabel, firstStep] of goals) {
    it(`${level} can choose ${goal} through both setup screens`, async () => {
      view = await mount(<SetupHarness />);
      await click(button("Get started with PPM"));
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Make PPM feel familiar");
      await click(button(levelLabel));
      for (const [, label] of goals) expect(button(label)).not.toBeNull();
      await click(button(goalLabel));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(useOnboardingStore.getState()).toMatchObject({ status: "active", familiarity: level, goal,
        currentStep: firstStep, completed: ["project"], projectName: "tour" });
    });
  }
}

for (const status of ["paused", "dismissed"] as const) {
  it(`${status} entry resumes earned progress instead of replaying setup`, async () => {
    useOnboardingStore.setState({ status, familiarity: "familiar", goal: "explore", projectName: "tour",
      currentStep: "search", completed: ["project", "file"] });
    view = await mount(<OnboardingEntry />);
    await click(button("Resume guided tour"));
    expect(useOnboardingStore.getState()).toMatchObject({ status: "active", currentStep: "search",
      completed: ["project", "file"] });
  });
}

it("lets users leave setup without changing their project or workspace", async () => {
  const panels = usePanelStore.getState();
  const project = useProjectStore.getState().activeProject;
  view = await mount(<SetupHarness />);
  await click(button("Get started with PPM"));
  await click(button("I'll explore on my own"));
  expect(useOnboardingStore.getState().status).toBe("dismissed");
  expect(usePanelStore.getState()).toBe(panels);
  expect(useProjectStore.getState().activeProject).toBe(project);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("offers run acknowledgment only after a run document is actually ready", async () => {
  useOnboardingStore.setState({ status: "active", goal: "developer", familiarity: "beginner", projectName: "tour", currentStep: "run" });
  const actions: string[] = [];
  view = await mount(<OnboardingGuide collapsed={false} setCollapsed={() => {}} onSettings={() => {}} onAction={(step) => actions.push(step)} />);
  expect(button("I know where to run commands")).toBeNull();
  expect(button("Find run instructions")).not.toBeNull();
  await click(button("Find run instructions"));
  expect(actions).toEqual(["run"]);
  expect(useOnboardingStore.getState().status).toBe("active");
  await act(async () => { useOnboardingStore.getState().observe({ type: "file-ready", projectName: "tour", tabId: "file", visible: true, isRunDocument: true }); });
  expect(button("I know where to run commands")).not.toBeNull();
  expect(view.container.textContent).toContain("Run instructions opened");
});
