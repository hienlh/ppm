/**
 * The tour's "PPM has new features" part, mounted through the real `OnboardingRoot`: when it
 * shows for a new and an existing install, what each button sends, the once-per-open skip rule,
 * another device's answer closing it, and Settings → Tools' NEW marker.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { FEATURE_INTROS, FEATURE_INTROS_CHANGED_EVENT, type FeatureIntro } from "../../../src/shared/feature-intros";

installDom();
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);
const { OnboardingRoot } = await import("../../../src/web/components/onboarding/onboarding-root");
const { ToolsSettingsSection } = await import("../../../src/web/components/settings/tools-settings-section");
const { featurePartAllowed } = await import("../../../src/web/lib/onboarding/feature-intros-client");
const { useFeatureIntrosStore } = await import("../../../src/web/stores/feature-intros-store");
const { useOnboardingStore } = await import("../../../src/web/stores/onboarding-store");
const { initialOnboardingState } = await import("../../../src/web/lib/onboarding/onboarding-state");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { api } = await import("../../../src/web/lib/api-client");

const INTRO = FEATURE_INTROS[0]!;
const SECOND: FeatureIntro = { id: "second-feature", title: "A second feature", body: "More.", tools: ["open_url"], since: "x" };
let view: Mounted | null = null;
let served: { pending: FeatureIntro[]; isExistingUser: boolean; newInSettings: string[] };
let posts: Array<[string, unknown]> = [];
let get: ReturnType<typeof spyOn>;
let post: ReturnType<typeof spyOn>;

beforeEach(() => {
  served = { pending: [INTRO], isExistingUser: true, newInSettings: [] };
  posts = [];
  useFeatureIntrosStore.getState().reset();
  useOnboardingStore.setState(initialOnboardingState());
  useProjectStore.setState({ activeProject: null } as never);
  get = spyOn(api, "get").mockImplementation(((path: string) => path === "/api/feature-intros"
    ? Promise.resolve(structuredClone(served))
    : Promise.resolve({ default_provider: "claude", providers: {}, ppm_tools: {} })) as never);
  post = spyOn(api, "post").mockImplementation(((path: string, body?: unknown) => { posts.push([path, body]); return Promise.resolve({}); }) as never);
});
afterEach(async () => { await view?.unmount(); view = null; get.mockRestore(); post.mockRestore(); });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((n) => n.textContent?.trim() === label) ?? null;
const dialog = () => document.querySelector(`[role="dialog"][aria-labelledby="feature-intro-${INTRO.id}"]`);
async function mountRoot(): Promise<void> {
  view = await mount(<OnboardingRoot openProjects={() => {}} openNavigation={() => {}} closeNavigation={() => {}} />);
  await flush();
}

describe("when the part shows", () => {
  it("waits for a new install's basic tour, and shows at once for an install in use", () => {
    const base = { remaining: 1, isExistingUser: false, closed: false };
    for (const tourStatus of ["unseen", "choosing", "active", "paused"] as const) expect(featurePartAllowed({ ...base, tourStatus })).toBe(false);
    for (const tourStatus of ["finished", "dismissed"] as const) expect(featurePartAllowed({ ...base, tourStatus })).toBe(true);
    expect(featurePartAllowed({ ...base, isExistingUser: true, tourStatus: "unseen" })).toBe(true);
    expect(featurePartAllowed({ ...base, isExistingUser: true, tourStatus: "unseen", closed: true })).toBe(false);
    expect(featurePartAllowed({ ...base, isExistingUser: true, tourStatus: "unseen", remaining: 0 })).toBe(false);
  });

  it("gives an existing user the feature step directly and never starts the basic tour", async () => {
    await mountRoot();
    expect(dialog()?.textContent).toContain(INTRO.title);
    expect(document.body.textContent).not.toContain("Get started with PPM");
    expect(useOnboardingStore.getState().status).toBe("unseen");
    expect(document.activeElement).toBe(dialog());
  });

  it("queues a new user's feature step until the basic tour is dismissed, or shows it when it already finished", async () => {
    served.isExistingUser = false;
    useOnboardingStore.setState({ status: "paused" });
    await mountRoot();
    expect(dialog()).toBeNull();
    await act(async () => { useOnboardingStore.getState().dismiss(); });
    expect(dialog()?.textContent).toContain(INTRO.title);
    await view!.unmount();
    useFeatureIntrosStore.getState().reset();
    useOnboardingStore.setState({ ...initialOnboardingState(), status: "finished", goal: "ai", familiarity: "beginner", currentStep: "history" });
    await mountRoot();
    expect(dialog()?.textContent).toContain(INTRO.title);
  });
});

describe("answering", () => {
  for (const [label, answer] of [["Turn on", "on"], ["Turn off", "off"]] as const) {
    it(`${label} records "${answer}" and closes the part after the last feature`, async () => {
      await mountRoot();
      await click(button(label));
      await flush();
      expect(posts).toEqual([[`/api/feature-intros/${INTRO.id}/answer`, { answer }]]);
      expect(dialog()).toBeNull();
    });
  }

  it("Later records one skip and moves on to the next feature", async () => {
    served.pending = [INTRO, SECOND];
    await mountRoot();
    expect(dialog()?.textContent).toContain("1 of 2");
    await click(button("Later"));
    await flush();
    expect(posts).toEqual([[`/api/feature-intros/${INTRO.id}/skip`, undefined]]);
    expect(document.body.textContent).toContain("A second feature");
    expect(document.body.textContent).toContain("2 of 2");
  });

  it("counts closing as one skip per feature for the whole app open", async () => {
    served.pending = [INTRO, SECOND];
    await mountRoot();
    await click(button("Later"));
    await click(document.querySelector('[aria-label="Close, ask me later"]'));
    await flush();
    expect(posts.map(([path]) => path)).toEqual([`/api/feature-intros/${INTRO.id}/skip`, "/api/feature-intros/second-feature/skip"]);
    // Both are still pending on the server; this open asks no more and records no more skips.
    await act(async () => { window.dispatchEvent(new CustomEvent(FEATURE_INTROS_CHANGED_EVENT)); });
    await flush();
    await act(async () => { await useFeatureIntrosStore.getState().close(); });
    expect(posts).toHaveLength(2);
    expect(document.body.textContent).not.toContain("PPM has new features");
  });

  it("disappears when another device answers", async () => {
    await mountRoot();
    expect(dialog()).not.toBeNull();
    served.pending = [];
    await act(async () => { window.dispatchEvent(new CustomEvent(FEATURE_INTROS_CHANGED_EVENT)); });
    await flush();
    expect(dialog()).toBeNull();
    expect(posts).toEqual([]);
  });
});

describe("Settings → Tools", () => {
  it("marks the tools of a feature left off by skipping as NEW for this visit, and records the visit", async () => {
    served = { pending: [], isExistingUser: true, newInSettings: [INTRO.id] };
    view = await mount(<ToolsSettingsSection />);
    await flush();
    const marked = Array.from(document.querySelectorAll("[data-new-tool]")).map((n) => n.getAttribute("data-new-tool"));
    expect(marked).toEqual([...INTRO.tools]);
    expect(posts).toEqual([[`/api/feature-intros/${INTRO.id}/seen-in-settings`, undefined]]);
    // Off before an answer, and still switchable.
    const create = Array.from(document.querySelectorAll('[role="switch"]')).find((n) => n.closest("div")?.textContent?.includes("create_session"));
    expect(create?.getAttribute("aria-checked")).toBe("false");
  });

  it("shows no marker when nothing was left off by skipping", async () => {
    served = { pending: [INTRO], isExistingUser: true, newInSettings: [] };
    view = await mount(<ToolsSettingsSection />);
    await flush();
    expect(document.querySelectorAll("[data-new-tool]")).toHaveLength(0);
    expect(posts).toEqual([]);
  });
});
