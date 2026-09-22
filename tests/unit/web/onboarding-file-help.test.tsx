import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { OnboardingFileHelp } = await import("../../../src/web/components/onboarding/onboarding-file-help");
const { useOnboardingStore } = await import("../../../src/web/stores/onboarding-store");
const { initialOnboardingState } = await import("../../../src/web/lib/onboarding/onboarding-state");
const { api } = await import("../../../src/web/lib/api-client");
let view: Mounted | null;
let get: ReturnType<typeof spyOn>;
beforeEach(() => {
  view = null;
  useOnboardingStore.setState({ ...initialOnboardingState(), status: "active", goal: "explore", familiarity: "beginner",
    currentStep: "file", projectName: "notes", completed: ["project"] });
  get = spyOn(api, "get");
});
afterEach(async () => { await view?.unmount(); get.mockRestore(); });

it("accepts projects with arbitrary text files and explains markdown preview", async () => {
  get.mockResolvedValue([{ name: "notes.txt", path: "notes.txt", type: "file" }]);
  view = await mount(<OnboardingFileHelp />);
  expect(view.container.textContent).toContain("Choose any text file");
  expect(view.container.textContent).toContain("No README or package.json is required");
  expect(view.container.textContent).toContain("Markdown Preview counts too");
  expect(view.container.querySelector("button")).toBeNull();
});

it("offers an honest skip for an empty root without fabricating file completion", async () => {
  get.mockResolvedValue([]);
  view = await mount(<OnboardingFileHelp />);
  expect(view.container.textContent).toContain("No files are visible");
  expect(view.container.querySelector("button")?.textContent).toBe("Skip empty project step");
  await click(view.container.querySelector("button"));
  expect(useOnboardingStore.getState()).toMatchObject({ currentStep: "search", completed: ["project"], skipped: ["file"] });
});

it("does not mislabel a listing failure as an empty project", async () => {
  get.mockRejectedValue(new Error("offline"));
  view = await mount(<OnboardingFileHelp />);
  expect(view.container.textContent).not.toContain("No files are visible");
  expect(view.container.querySelector("button")).toBeNull();
  expect(useOnboardingStore.getState()).toMatchObject({ currentStep: "file", completed: ["project"], skipped: [] });
});

it("ignores a late response from the previous project", async () => {
  let resolve!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue([{ name: "src", type: "directory" }]);
  view = await mount(<OnboardingFileHelp />);
  await act(async () => { useOnboardingStore.setState({ projectName: "other" }); });
  await act(async () => resolve([]));
  expect(view.container.textContent).not.toContain("No files are visible");
});

it("ignores an older empty result after a populated refresh", async () => {
  let resolve!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue([{ name: "notes.txt", type: "file" }]);
  view = await mount(<OnboardingFileHelp />);
  await act(async () => { window.dispatchEvent(new Event("ppm:onboarding-refresh")); });
  await act(async () => resolve([]));
  expect(view.container.textContent).not.toContain("No files are visible");
});
