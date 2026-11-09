/**
 * Settings → Tools → Session collaboration: the three tool switches, the ask-before-create switch
 * and the four limits, each number clamped to the server's range before it is saved.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { SESSION_COLLAB_DEFAULTS, SESSION_COLLAB_LIMITS } from "../../../src/shared/session-collab-settings";

installDom();
afterAll(uninstallDom);
const { SessionCollabSettingsControls } = await import("../../../src/web/components/settings/session-collab-settings-controls");
const { ToolsSettingsSection } = await import("../../../src/web/components/settings/tools-settings-section");
const { api } = await import("../../../src/web/lib/api-client");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** Types into a number field and leaves it, as a person would. */
async function enter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // React's onBlur listens for focusout; the event class has to be the installed DOM's own.
  const FocusEventClass = (window as unknown as { FocusEvent: typeof FocusEvent }).FocusEvent;
  await act(async () => { input.dispatchEvent(new FocusEventClass("focusout", { bubbles: true })); });
}

describe("SessionCollabSettingsControls", () => {
  it("shows the defaults for settings never saved", async () => {
    view = await mount(<SessionCollabSettingsControls stored={undefined} onChange={() => {}} />);
    for (const [key, value] of Object.entries(SESSION_COLLAB_DEFAULTS)) {
      if (typeof value !== "number") continue;
      expect((view.container.querySelector(`[data-session-collab-number="${key}"]`) as HTMLInputElement).value).toBe(String(value));
    }
    expect(view.container.textContent).toContain("Ask before creating sessions");
  });

  it("clamps a number to its range before saving it", async () => {
    const changes: unknown[] = [];
    view = await mount(<SessionCollabSettingsControls stored={{}} onChange={(p) => changes.push(p)} />);
    const depth = view.container.querySelector('[data-session-collab-number="maxDepth"]') as HTMLInputElement;
    expect(depth.max).toBe(String(SESSION_COLLAB_LIMITS.maxDepth.max));
    await enter(depth, "99");
    expect(changes).toEqual([{ maxDepth: SESSION_COLLAB_LIMITS.maxDepth.max }]);
    expect(depth.value).toBe(String(SESSION_COLLAB_LIMITS.maxDepth.max));
  });

  it("keeps the saved value when the field is left empty", async () => {
    const changes: unknown[] = [];
    view = await mount(<SessionCollabSettingsControls stored={{ waitTimeoutMinutes: 7 }} onChange={(p) => changes.push(p)} />);
    const wait = view.container.querySelector('[data-session-collab-number="waitTimeoutMinutes"]') as HTMLInputElement;
    await enter(wait, "");
    expect(changes).toEqual([]);
    expect(wait.value).toBe("7");
  });

  it("turns asking before creating off", async () => {
    const changes: unknown[] = [];
    view = await mount(<SessionCollabSettingsControls stored={{}} onChange={(p) => changes.push(p)} />);
    await click(view.container.querySelector('[role="switch"]'));
    expect(changes).toEqual([{ askBeforeCreate: false }]);
  });
});

describe("ToolsSettingsSection", () => {
  it("lists the three session tools in their own group, and saves a limit under session_collab", async () => {
    const settings = { default_provider: "claude", providers: {}, ppm_tools: {}, session_collab: { ...SESSION_COLLAB_DEFAULTS } };
    const get = spyOn(api, "get").mockImplementation((() => Promise.resolve(settings)) as never);
    const put = spyOn(api, "put").mockImplementation(((_path: string, body: unknown) => Promise.resolve({ ...settings, ...(body as object) })) as never);
    try {
      view = await mount(<ToolsSettingsSection />);
      await act(async () => { await Promise.resolve(); });
      const text = view.container.textContent ?? "";
      expect(text).toContain("Session collaboration");
      for (const tool of ["create_session", "send_to_session", "session_status"]) expect(text).toContain(tool);
      await enter(view.container.querySelector('[data-session-collab-number="maxRunningSpawned"]') as HTMLInputElement, "0");
      expect(put).toHaveBeenCalledWith("/api/settings/ai", { session_collab: { maxRunningSpawned: SESSION_COLLAB_LIMITS.maxRunningSpawned.min } });
    } finally {
      get.mockRestore();
      put.mockRestore();
    }
  });
});
