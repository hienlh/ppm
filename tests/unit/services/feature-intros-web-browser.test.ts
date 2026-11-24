/**
 * The web browser is asked about once, as one setting (`web_browser.enabled`): the tour's answer
 * writes it, and a choice made in Settings first settles the question.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { answerFeatureIntro, featureIntrosView, readFeatureIntroStates } from "../../../src/services/feature-intros.service.ts";
import { FEATURE_INTROS } from "../../../src/shared/feature-intros.ts";
import { parseWebBrowserSettings } from "../../../src/shared/web-browser-settings.ts";

const ID = "web-browser-2026-11";
const enabled = () => parseWebBrowserSettings(configService.get("web_browser")).enabled;
let saved: unknown;

beforeEach(() => {
  saved = configService.get("web_browser");
  configService.set("feature_intros", Object.fromEntries(FEATURE_INTROS.filter((i) => i.id !== ID).map((i) => [i.id, { answer: "off" as const, skips: 0, via: "tour" as const }])));
  configService.set("web_browser", parseWebBrowserSettings({}));
});
afterEach(() => configService.set("web_browser", saved as never));

describe("web browser introduction", () => {
  it("is asked while the browser is undecided, and stands for the one setting", () => {
    const intro = FEATURE_INTROS.find((i) => i.id === ID)!;
    expect(intro.setting).toBe("web_browser");
    expect(intro.tools).toEqual([]);
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([ID]);
  });

  it("Turn on / Turn off writes web_browser.enabled and keeps the other settings", () => {
    configService.set("web_browser", { ...parseWebBrowserSettings({}), maxTabs: 2 });
    answerFeatureIntro(ID, "on");
    expect(enabled()).toBe(true);
    expect(parseWebBrowserSettings(configService.get("web_browser")).maxTabs).toBe(2);
    expect(featureIntrosView().pending).toEqual([]);
  });

  it("a choice already made in Settings settles the question without asking", () => {
    configService.set("web_browser", { ...parseWebBrowserSettings({}), enabled: false });
    expect(featureIntrosView().pending).toEqual([]);
    expect(readFeatureIntroStates()[ID]).toMatchObject({ answer: "off", via: "settings" });
  });
});
