/**
 * Opening Settings shows its pane without a spinner only if that pane's code was loaded
 * ahead, so the idle preload has to reach every one of them.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { SETTINGS_CATEGORIES } from "../../../src/web/components/settings/settings-categories";
import { SECTIONS, preloadSettingsSections } from "../../../src/web/components/settings/settings-section-content";

describe("preloadSettingsSections", () => {
  it("loads the code of every Settings pane", async () => {
    const spies = SETTINGS_CATEGORIES.map(({ id }) => spyOn(SECTIONS[id], "preload").mockResolvedValue());
    try {
      await preloadSettingsSections();
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("settles only once every pane has", async () => {
    let finish = () => {};
    const slow = spyOn(SECTIONS.general, "preload").mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const rest = SETTINGS_CATEGORIES.filter(({ id }) => id !== "general")
      .map(({ id }) => spyOn(SECTIONS[id], "preload").mockResolvedValue());
    try {
      let settled = false;
      const done = preloadSettingsSections().then(() => { settled = true; });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(settled).toBe(false);
      finish();
      await done;
      expect(settled).toBe(true);
    } finally {
      slow.mockRestore();
      for (const spy of rest) spy.mockRestore();
    }
  });
});
