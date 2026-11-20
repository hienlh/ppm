/**
 * Settings → Voice Input, the voice-message part: the feature switch, and the word lists with
 * learned words drawn apart and removable on their own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { VoiceMessageSettings } = await import("../../../src/web/components/settings/voice-message-settings");
const { api } = await import("../../../src/web/lib/api-client");
const { useProjectStore } = await import("../../../src/web/stores/project-store");

const answer = (over: Record<string, unknown> = {}) => ({
  enabled: true, reviewBeforeSend: true, words: ["PPM"], projectWords: ["Bun.serve"],
  projectLearned: [{ word: "Hono", from: "hô nô", at: "2026-11-20T00:00:00Z" }], whisperReady: true, ...over,
});

let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;
let put: ReturnType<typeof spyOn>;

beforeEach(() => {
  useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never, activeProject: { name: "ppm", path: "/p" } as never });
  get = spyOn(api, "get").mockImplementation((() => Promise.resolve(answer())) as never);
  put = spyOn(api, "put").mockImplementation(((_path: string, body: Record<string, unknown>) =>
    Promise.resolve(answer({ projectLearned: body.removeLearned ? [] : answer().projectLearned }))) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
  put.mockRestore();
});

const flush = async () => { const { act } = await import("react"); await act(async () => { await Promise.resolve(); }); };

describe("VoiceMessageSettings", () => {
  it("reads the active project's words and shows a learned word with the form that was misheard", async () => {
    view = await mount(<VoiceMessageSettings />);
    await flush();
    expect(get.mock.calls[0]?.[0]).toBe("/api/speech/voice-settings?project=ppm");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Read the transcript before it is sent");
    expect(text).toContain("Hono");
    expect(text).toContain("← hô nô");
    expect(text).toContain("Bun.serve");
    expect(text).toContain("2:00");
  });

  it("removes a learned word by name, for the project shown", async () => {
    view = await mount(<VoiceMessageSettings />);
    await flush();
    await click(view.container.querySelector("button[aria-label='Remove learned word Hono']"));
    await flush();
    expect(put.mock.calls[0]?.[1]).toEqual({ project: "ppm", removeLearned: ["Hono"] });
    expect(view.container.textContent).not.toContain("← hô nô");
  });

  it("shows only the switch while the feature is off", async () => {
    get.mockImplementation((() => Promise.resolve(answer({ enabled: false }))) as never);
    view = await mount(<VoiceMessageSettings />);
    await flush();
    const text = view.container.textContent ?? "";
    expect(text).toContain("Voice messages");
    expect(text).not.toContain("Words · all projects");
  });
});
