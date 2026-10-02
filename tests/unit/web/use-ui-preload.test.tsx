/**
 * Once signed in and settled, the app loads the code of every kind of tab and window, and of
 * every Settings pane — the editor, the terminal and chat first — one idle period at a time,
 * and not at all on a phone that may be paying for the download.
 */
import { afterAll, afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
const { TAB_COMPONENTS } = await import("../../../src/web/components/layout/tab-pool");
const { WINDOW_CONTENT } = await import("../../../src/web/components/floating-window/window-content-registry");
const settingsPanes = await import("../../../src/web/components/settings/settings-section-content");
const { useUiPreload } = await import("../../../src/web/hooks/use-ui-preload");

/** The idle periods asked for, fired by the test. */
const idle = new Map<number, () => void>();
let nextIdleId = 0;
installGlobal("requestIdleCallback", (run: () => void) => {
  idle.set(++nextIdleId, run);
  return nextIdleId;
});
installGlobal("cancelIdleCallback", (id: number) => idle.delete(id));

const loaded: string[] = [];
const spies = [
  ...Object.entries(TAB_COMPONENTS).map(([kind, tab]) =>
    spyOn(tab, "preload").mockImplementation(async () => { loaded.push(`tab:${kind}`); })),
  ...Object.entries(WINDOW_CONTENT).map(([kind, content]) =>
    spyOn(content, "preload").mockImplementation(async () => { loaded.push(`window:${kind}`); })),
  spyOn(settingsPanes, "preloadSettingsSections").mockImplementation(async () => { loaded.push("settings-panes"); }),
];
const everything = [
  ...Object.keys(TAB_COMPONENTS).map((kind) => `tab:${kind}`),
  ...Object.keys(WINDOW_CONTENT).map((kind) => `window:${kind}`),
  "settings-panes",
];

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  uninstallDom();
});
afterEach(() => {
  jest.useRealTimers();
  idle.clear();
  loaded.length = 0;
  delete (navigator as { connection?: unknown }).connection;
});

function Probe({ enabled }: { enabled: boolean }) {
  useUiPreload(enabled);
  return null;
}

/** Fire every idle period asked for, one at a time, until none is left. */
async function runIdle(): Promise<void> {
  for (let guard = 0; guard < 500 && idle.size > 0; guard++) {
    const [id, run] = idle.entries().next().value!;
    idle.delete(id);
    run();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

/** A device whose only pointer is a finger. */
function asTouchOnly(): () => void {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse) and (hover: none)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = real; };
}

describe("useUiPreload", () => {
  it("loads every tab's, window's and Settings pane's code once the app has settled, the editor, terminal and chat first", async () => {
    jest.useFakeTimers();
    const view = await mount(<Probe enabled />);
    try {
      jest.advanceTimersByTime(2499);
      expect(idle.size).toBe(0);
      jest.advanceTimersByTime(1);
      expect(idle.size).toBe(1);
      await runIdle();

      expect(loaded.slice(0, 5)).toEqual(["tab:editor", "tab:terminal", "tab:chat", "tab:git-diff", "tab:settings"]);
      expect([...loaded].sort()).toEqual([...everything].sort());
      const lastTab = loaded.findLastIndex((name) => name.startsWith("tab:"));
      expect(loaded.slice(lastTab + 1, -1).every((name) => name.startsWith("window:"))).toBe(true);
      expect(loaded.at(-1)).toBe("settings-panes");
    } finally {
      await view.unmount();
    }
  });

  it("waits for sign-in", async () => {
    jest.useFakeTimers();
    const view = await mount(<Probe enabled={false} />);
    try {
      jest.advanceTimersByTime(10_000);
      await runIdle();
      expect(loaded).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it("stops with the app, before it has started or once it has", async () => {
    jest.useFakeTimers();
    let view = await mount(<Probe enabled />);
    jest.advanceTimersByTime(1000);
    await view.unmount();
    jest.advanceTimersByTime(10_000);
    await runIdle();
    expect(loaded).toEqual([]);

    view = await mount(<Probe enabled />);
    jest.advanceTimersByTime(2500);
    await view.unmount();
    await runIdle();
    jest.advanceTimersByTime(10_000);
    expect(loaded).toEqual([]);
  });

  it("leaves a phone alone unless it says it is on Wi-Fi", async () => {
    const restore = asTouchOnly();
    try {
      jest.useFakeTimers();
      let view = await mount(<Probe enabled />);
      jest.advanceTimersByTime(10_000);
      await runIdle();
      await view.unmount();
      expect(loaded).toEqual([]);

      Object.defineProperty(navigator, "connection", { value: { type: "wifi" }, configurable: true });
      view = await mount(<Probe enabled />);
      jest.advanceTimersByTime(2500);
      await runIdle();
      await view.unmount();
      expect([...loaded].sort()).toEqual([...everything].sort());
    } finally {
      restore();
    }
  });
});
