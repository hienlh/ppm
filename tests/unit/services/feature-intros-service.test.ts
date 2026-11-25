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
/** The features introduced after this one, already answered, so only this one is asked here. */
const otherIntrosAnswered = () =>
  Object.fromEntries(FEATURE_INTROS.slice(1).map((i) => [i.id, { answer: "off" as const, skips: 0, via: "tour" as const }]));
const SIX = ["search_sessions", "list_session_turns", "read_session_turns", "create_session", "send_to_session", "session_status", "design_screenshot"];
const ai = () => configService.get("ai");
const onTools = () => PPM_TOOLS.filter((tool) => ppmToolOn(ai(), tool));
let savedProjects: ProjectConfig[];

beforeEach(() => {
  savedProjects = configService.get("projects");
  configService.set("projects", []);
  configService.set("feature_intros", otherIntrosAnswered());
  // A switch another test file left set would settle the voice question before it is asked.
  configService.set("voice_message", { review_before_send: true, words: [], projects: {} });
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
  });

  it("ignores a second answer: the first one, or a choice made in Settings since, stands", () => {
    answerFeatureIntro(INTRO.id, "on");
    expect(answerFeatureIntro(INTRO.id, "off")).toMatchObject({ ok: true, changed: false, state: { answer: "on", via: "tour" } });
    expect(ai().ppm_tools).toEqual(Object.fromEntries(SIX.map((t) => [t, true])));

    // Settled by a switch saved in Settings that nothing has read yet: the late answer settles it first.
    configService.set("feature_intros", {});
    configService.set("ai", { ...ai(), ppm_tools: { create_session: true } });
    expect(answerFeatureIntro(INTRO.id, "off")).toMatchObject({ changed: false, state: { answer: "on", via: "settings" } });
    expect(ai().ppm_tools).toEqual({ create_session: true });

    // Switched off by skipping: Turn on from a stale device does not overwrite it either.
    configService.set("feature_intros", { [INTRO.id]: { answer: "off", skips: 3, via: "skips" } });
    configService.set("ai", { ...ai(), ppm_tools: {} });
    expect(answerFeatureIntro(INTRO.id, "on")).toMatchObject({ changed: false, state: { answer: "off", via: "skips" } });
    for (const tool of SIX) expect(onTools()).not.toContain(tool);
  });

  it("asks again after a skip, and after the last allowed one leaves the feature off and NEW in Settings", () => {
    const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n, 9));
    for (let n = 1; n < MAX_FEATURE_INTRO_SKIPS; n++) {
      expect(skipFeatureIntro(INTRO.id, day(n))).toMatchObject({ ok: true, changed: true, state: { answer: null, skips: n } });
      expect(featureIntrosView().pending).toHaveLength(1);
    }
    expect(skipFeatureIntro(INTRO.id, day(MAX_FEATURE_INTRO_SKIPS)))
      .toMatchObject({ ok: true, state: { answer: "off", skips: MAX_FEATURE_INTRO_SKIPS, via: "skips" } });
    const view = featureIntrosView();
    expect(view.pending).toEqual([]);
    expect(view.newInSettings).toEqual([INTRO.id]);
    for (const tool of SIX) expect(onTools()).not.toContain(tool);
    // A skip after the question ended changes nothing.
    expect(skipFeatureIntro(INTRO.id, day(9))).toMatchObject({ changed: false, state: { skips: MAX_FEATURE_INTRO_SKIPS } });
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

  it("counts one skip per window, however many tabs and devices close the question", () => {
    const at = (hours: number) => new Date(Date.UTC(2026, 10, 8, 9) + hours * 3_600_000);
    expect(skipFeatureIntro(INTRO.id, at(0))).toMatchObject({ changed: true, state: { skips: 1 } });
    for (const hours of [0, 1, 11.9]) {
      expect(skipFeatureIntro(INTRO.id, at(hours))).toMatchObject({ ok: true, changed: false, state: { answer: null, skips: 1 } });
    }
    expect(skipFeatureIntro(INTRO.id, at(12))).toMatchObject({ changed: true, state: { skips: 2 } });
    expect(readFeatureIntroStates()[INTRO.id]!.lastSkipAt).toBe(at(12).toISOString());
  });

  it("knows an install in use by a recorded chat session, and not by projects alone", () => {
    // `ppm init` adds every git repository it finds: projects say nothing about use.
    configService.set("projects", [{ name: "p", path: "/tmp/p" }]);
    expect(isExistingUser()).toBe(false);
    expect(featureIntrosView().isExistingUser).toBe(false);
    setSessionMetadata("feature-intro-session", "p", "/tmp/p");
    expect(isExistingUser()).toBe(true);
    expect(featureIntrosView().isExistingUser).toBe(true);
  });
});

describe("scheduled prompts in a chat", () => {
  const SCHEDULES = FEATURE_INTROS.find((i) => i.id === "session-schedules-2026-11")!;
  const SCRIPTS = FEATURE_INTROS.find((i) => i.id === "script-schedule-proposals-2026-11")!;
  const THREE = ["session_schedule_create", "session_schedule_list", "session_schedule_delete"];

  it("is a question of its own: turning the session tools on leaves the schedule tools off and still asked", () => {
    configService.set("feature_intros", {});
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([INTRO.id, SCHEDULES.id, SCRIPTS.id, "assistant-full-mode-2026-11", "voice-messages-2026-11", "assistant-settings-tools-2026-11", "remembered-approvals-2026-11", "web-browser-2026-11", "card-withdraw-2026-11"]);
    answerFeatureIntro(INTRO.id, "on");
    for (const tool of THREE) expect(onTools()).not.toContain(tool);
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([SCHEDULES.id, SCRIPTS.id, "assistant-full-mode-2026-11", "voice-messages-2026-11", "assistant-settings-tools-2026-11", "remembered-approvals-2026-11", "web-browser-2026-11", "card-withdraw-2026-11"]);

    answerFeatureIntro(SCHEDULES.id, "on");
    for (const tool of THREE) expect(onTools()).toContain(tool);
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([SCRIPTS.id, "assistant-full-mode-2026-11", "voice-messages-2026-11", "assistant-settings-tools-2026-11", "remembered-approvals-2026-11", "web-browser-2026-11", "card-withdraw-2026-11"]);
  });

  it("asks apart about script proposals: prompts turned on never agreed to code that runs on this machine", () => {
    configService.set("feature_intros", {});
    answerFeatureIntro(SCHEDULES.id, "on");
    expect(onTools()).toContain("session_schedule_set_enabled");
    expect(onTools()).not.toContain("session_schedule_propose_script");
    answerFeatureIntro(SCRIPTS.id, "on");
    expect(onTools()).toContain("session_schedule_propose_script");
    expect(featureIntrosView().pending.filter((i) => i.id === SCRIPTS.id)).toEqual([]);
  });
});

describe("Full mode for the PPM Assistant", () => {
  const FULL = FEATURE_INTROS.find((i) => i.id === "assistant-full-mode-2026-11")!;
  let savedAssistant: unknown;
  beforeEach(() => { savedAssistant = configService.get("assistant"); configService.set("feature_intros", {}); });
  afterEach(() => { configService.set("assistant", savedAssistant as never); });
  const mode = () => (configService.get("assistant") as { permission_mode?: string } | undefined)?.permission_mode;

  it("is a setting, not tool switches: Turn on writes Full and touches no tool", () => {
    expect(FULL.setting).toBe("assistant_permission_mode");
    expect(FULL.tools).toEqual([]);
    const before = JSON.stringify(ai().ppm_tools ?? {});
    expect(answerFeatureIntro(FULL.id, "on")).toMatchObject({ ok: true, changed: true });
    expect(mode()).toBe("full");
    expect(JSON.stringify(ai().ppm_tools ?? {})).toBe(before);
  });

  it("Turn off writes Ask", () => {
    answerFeatureIntro(FULL.id, "off");
    expect(mode()).toBe("ask");
  });

  it("is settled by a mode already chosen in Settings, and a late answer does not change it", () => {
    configService.set("assistant", { ...(configService.get("assistant") ?? {}), permission_mode: "ask" } as never);
    expect(featureIntrosView().pending.map((i) => i.id)).not.toContain(FULL.id);
    expect(answerFeatureIntro(FULL.id, "on")).toMatchObject({ ok: true, changed: false });
    expect(mode()).toBe("ask");
  });

  it("stays asked while no mode is chosen", () => {
    const { permission_mode: _drop, ...rest } = (configService.get("assistant") ?? {}) as Record<string, unknown>;
    configService.set("assistant", rest as never);
    expect(featureIntrosView().pending.map((i) => i.id)).toContain(FULL.id);
  });
});

describe("Voice messages", () => {
  const VOICE = FEATURE_INTROS.find((i) => i.id === "voice-messages-2026-11")!;
  const enabled = () => (configService.get("voice_message") as { enabled?: boolean } | undefined)?.enabled;
  beforeEach(() => {
    configService.set("feature_intros", {});
    configService.set("voice_message", { review_before_send: true, words: [], projects: {} });
  });
  afterEach(() => configService.set("voice_message", { review_before_send: true, words: [], projects: {} }));

  it("is a setting: Turn on writes voice_message.enabled and touches no tool or other voice setting", () => {
    expect(VOICE.setting).toBe("voice_messages");
    expect(VOICE.tools).toEqual([]);
    // Telegram is set to Haiku here so the assertion shows the answer leaves it alone;
    // left out, normalising the config would write its default and prove nothing.
    configService.set("voice_message", { review_before_send: false, transcript_fix: { composer: "hints", telegram: "haiku" }, words: ["Hono"], projects: {} });
    expect(featureIntrosView().pending.map((i) => i.id)).toContain(VOICE.id);
    expect(answerFeatureIntro(VOICE.id, "on")).toMatchObject({ ok: true, changed: true });
    expect(configService.get("voice_message")).toEqual({
      enabled: true,
      review_before_send: false,
      transcript_fix: { composer: "hints", telegram: "haiku" },
      // Self-learning's parts take their defaults; self-learning itself stays unchosen.
      learn_auto_vocabulary: true,
      learn_from_cleanup: true,
      learn_from_chat: true,
      weekly_summary: true,
      vietnamese_fixes: true,
      words: ["Hono"],
      projects: {},
    });
    answerFeatureIntro(VOICE.id, "off");
    expect(enabled()).toBe(true);
  });

  it("Turn off writes false, and a switch already set in Settings settles the question", () => {
    answerFeatureIntro(VOICE.id, "off");
    expect(enabled()).toBe(false);
    configService.set("feature_intros", {});
    configService.set("voice_message", { enabled: true, review_before_send: true, words: [], projects: {} });
    expect(settleFeaturesDecidedInSettings()).toBe(true);
    expect(readFeatureIntroStates()[VOICE.id]).toMatchObject({ answer: "on", via: "settings" });
  });
});

describe("Voice self-learning", () => {
  const LEARN = FEATURE_INTROS.find((i) => i.id === "voice-self-learning-2026-11")!;
  const voice = () => configService.get("voice_message") as { enabled?: boolean; self_learning?: boolean; learn_from_cleanup?: boolean };
  beforeEach(() => configService.set("feature_intros", {}));
  afterEach(() => configService.set("voice_message", { review_before_send: true, words: [], projects: {} }));

  it("is asked only once voice messages are on: it means nothing without them", () => {
    configService.set("voice_message", { review_before_send: true, words: [], projects: {} });
    expect(featureIntrosView().pending.map((i) => i.id)).not.toContain(LEARN.id);
    configService.set("voice_message", { enabled: true, review_before_send: true, words: [], projects: {} });
    expect(featureIntrosView().pending.map((i) => i.id)).toContain(LEARN.id);
  });

  it("Turn on writes voice_message.self_learning and leaves voice messages and the parts alone", () => {
    configService.set("voice_message", { enabled: true, review_before_send: true, learn_from_cleanup: false, words: [], projects: {} });
    expect(LEARN.setting).toBe("voice_self_learning");
    expect(answerFeatureIntro(LEARN.id, "on")).toMatchObject({ ok: true, changed: true });
    expect(voice()).toMatchObject({ enabled: true, self_learning: true, learn_from_cleanup: false });
  });

  it("a choice already made in Settings settles the question", () => {
    configService.set("voice_message", { enabled: true, self_learning: false, review_before_send: true, words: [], projects: {} });
    expect(settleFeaturesDecidedInSettings()).toBe(true);
    expect(readFeatureIntroStates()[LEARN.id]).toMatchObject({ answer: "off", via: "settings" });
  });
});
