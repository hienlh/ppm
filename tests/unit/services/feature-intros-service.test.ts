import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, setSessionMetadata } from "../../../src/services/db.service.ts";
import {
  answerFeatureIntro, featureIntrosView, isExistingUser, markFeatureIntroSeenInSettings, readFeatureIntroStates,
  settleFeaturesDecidedInSettings, skipFeatureIntro,
} from "../../../src/services/feature-intros.service.ts";
import { FEATURE_INTROS, MAX_FEATURE_INTRO_SKIPS } from "../../../src/shared/feature-intros.ts";
import { PPM_TOOLS, ppmToolOn } from "../../../src/shared/ppm-tools.ts";
import type { ProjectConfig } from "../../../src/types/config.ts";

const INTRO = FEATURE_INTROS[0]!;
const SIX = ["search_sessions", "list_session_turns", "read_session_turns", "create_session", "send_to_session", "session_status"];
const ai = () => configService.get("ai");
const onTools = () => PPM_TOOLS.filter((tool) => ppmToolOn(ai(), tool));
let savedProjects: ProjectConfig[];

beforeEach(() => {
  savedProjects = configService.get("projects");
  configService.set("projects", []);
  configService.set("feature_intros", {});
  const { ppm_tools: _drop, ...rest } = ai();
  configService.set("ai", { ...rest, session_collab: { askBeforeCreate: false } });
  getDb().run("DELETE FROM session_metadata");
});
afterEach(() => {
  configService.set("projects", savedProjects);
  const { session_collab: _drop, ...rest } = ai();
  configService.set("ai", rest);
});

describe("feature introductions", () => {
  it("introduces the six session tools, and they are off on every server path until answered", () => {
    expect([...INTRO.tools]).toEqual(SIX);
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([INTRO.id]);
    for (const tool of SIX) expect(onTools()).not.toContain(tool);
  });

  it("writes explicit switches for all six on an answer and leaves ask-before-create alone", () => {
    const result = answerFeatureIntro(INTRO.id, "on");
    expect(result.ok && result.state).toMatchObject({ answer: "on", via: "tour" });
    expect(ai().ppm_tools).toEqual(Object.fromEntries(SIX.map((t) => [t, true])));
    expect(ai().session_collab).toEqual({ askBeforeCreate: false });
    for (const tool of SIX) expect(onTools()).toContain(tool);
    expect(featureIntrosView().pending).toEqual([]);

    answerFeatureIntro(INTRO.id, "off");
    expect(ai().ppm_tools).toEqual(Object.fromEntries(SIX.map((t) => [t, false])));
    expect(readFeatureIntroStates()[INTRO.id]!.answer).toBe("off");
  });

  it("asks again after a skip, and after the last allowed one leaves the feature off and NEW in Settings", () => {
    for (let n = 1; n < MAX_FEATURE_INTRO_SKIPS; n++) {
      expect(skipFeatureIntro(INTRO.id)).toMatchObject({ ok: true, state: { answer: null, skips: n } });
      expect(featureIntrosView().pending).toHaveLength(1);
    }
    expect(skipFeatureIntro(INTRO.id)).toMatchObject({ ok: true, state: { answer: "off", skips: MAX_FEATURE_INTRO_SKIPS, via: "skips" } });
    const view = featureIntrosView();
    expect(view.pending).toEqual([]);
    expect(view.newInSettings).toEqual([INTRO.id]);
    for (const tool of SIX) expect(onTools()).not.toContain(tool);
    // A skip after the question ended changes nothing.
    expect(skipFeatureIntro(INTRO.id)).toMatchObject({ state: { skips: MAX_FEATURE_INTRO_SKIPS } });
    markFeatureIntroSeenInSettings(INTRO.id);
    expect(featureIntrosView().newInSettings).toEqual([]);
  });

  it("counts a switch already set in Settings as the answer, on if any set one is on", () => {
    configService.set("ai", { ...ai(), ppm_tools: { read_session_turns: false } });
    expect(featureIntrosView().pending).toEqual([]);
    expect(readFeatureIntroStates()[INTRO.id]).toMatchObject({ answer: "off", via: "settings" });
    for (const tool of SIX) expect(onTools()).not.toContain(tool);

    configService.set("feature_intros", {});
    configService.set("ai", { ...ai(), ppm_tools: { read_session_turns: false, session_status: true } });
    expect(settleFeaturesDecidedInSettings()).toBe(true);
    expect(readFeatureIntroStates()[INTRO.id]!.answer).toBe("on");
    expect(settleFeaturesDecidedInSettings()).toBe(false);
  });

  it("refuses an unknown feature and ignores a malformed record", () => {
    expect(answerFeatureIntro("nope", "on")).toMatchObject({ ok: false, status: 404 });
    expect(skipFeatureIntro("nope")).toMatchObject({ ok: false, status: 404 });
    configService.set("feature_intros", { [INTRO.id]: "garbage", other: { answer: "on", skips: 0 } } as never);
    expect(readFeatureIntroStates()).toEqual({});
    configService.set("feature_intros", { [INTRO.id]: { answer: "maybe", skips: -2 } } as never);
    expect(readFeatureIntroStates()[INTRO.id]).toEqual({ answer: null, skips: 0 });
  });

  it("knows an install in use by a project or by a recorded chat session", () => {
    expect(isExistingUser()).toBe(false);
    setSessionMetadata("feature-intro-session", "p", "/tmp/p");
    expect(isExistingUser()).toBe(true);
    getDb().run("DELETE FROM session_metadata");
    configService.set("projects", [{ name: "p", path: "/tmp/p" }]);
    expect(featureIntrosView().isExistingUser).toBe(true);
  });
});
