/**
 * The install-wide record of which new features the tour has asked about (config key
 * `feature_intros`, see `src/shared/feature-intros.ts`). Answered on one device, no other device
 * asks. The answer itself lives in `ai.ppm_tools` as explicit switches; this record only says
 * whether, how and when the question ended, and how many times it was put off.
 */
import { configService } from "./config.service.ts";
import { getDb } from "./db.service.ts";
import { createLogger } from "./logger.ts";
import {
  answerFromSwitches, FEATURE_INTROS, featureIntroById, MAX_FEATURE_INTRO_SKIPS, switchesForAnswer,
  type FeatureIntroAnswer, type FeatureIntroState, type FeatureIntroStates, type FeatureIntrosView,
} from "../shared/feature-intros.ts";

const log = createLogger("feature-intros");

const isAnswer = (value: unknown): value is FeatureIntroAnswer => value === "on" || value === "off";

/** One stored entry, or null for anything malformed: a broken row must not decide a tool. */
function parseState(raw: unknown): FeatureIntroState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const answer = isAnswer(value.answer) ? value.answer : null;
  const skips = typeof value.skips === "number" && Number.isInteger(value.skips) && value.skips >= 0 ? value.skips : 0;
  const state: FeatureIntroState = { answer, skips };
  if (typeof value.answeredAt === "string") state.answeredAt = value.answeredAt;
  if (value.via === "tour" || value.via === "skips" || value.via === "settings") state.via = value.via;
  if (value.seenInSettings === true) state.seenInSettings = true;
  return state;
}

/** The stored record, with unknown ids and malformed entries dropped. */
export function readFeatureIntroStates(): FeatureIntroStates {
  const stored = configService.get("feature_intros") as unknown;
  const states: FeatureIntroStates = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return states;
  for (const intro of FEATURE_INTROS) {
    const state = parseState((stored as Record<string, unknown>)[intro.id]);
    if (state) states[intro.id] = state;
  }
  return states;
}

const stateOf = (states: FeatureIntroStates, id: string): FeatureIntroState => states[id] ?? { answer: null, skips: 0 };

/**
 * Records "decided in Settings" for every unanswered feature whose switches are already set:
 * the user chose there, so the tour never asks. Returns whether anything was written.
 */
export function settleFeaturesDecidedInSettings(now = new Date()): boolean {
  const states = readFeatureIntroStates();
  const switches = configService.get("ai").ppm_tools;
  let changed = false;
  for (const intro of FEATURE_INTROS) {
    const state = stateOf(states, intro.id);
    const fromSwitches = answerFromSwitches(switches, intro);
    if (state.answer || !fromSwitches) continue;
    states[intro.id] = { ...state, answer: fromSwitches, answeredAt: now.toISOString(), via: "settings" };
    changed = true;
  }
  if (changed) configService.set("feature_intros", states);
  return changed;
}

/** An install somebody has used: it has a project, or a chat session was ever recorded. */
export function isExistingUser(): boolean {
  if (configService.get("projects").length > 0) return true;
  try {
    return getDb().query("SELECT 1 FROM session_metadata LIMIT 1").get() !== null;
  } catch (e) {
    log.warn(`Could not read session metadata, treating the install as new: ${(e as Error).message}`);
    return false;
  }
}

export function featureIntrosView(): FeatureIntrosView {
  settleFeaturesDecidedInSettings();
  const states = readFeatureIntroStates();
  return {
    pending: FEATURE_INTROS.filter((intro) => {
      const state = stateOf(states, intro.id);
      return !state.answer && state.skips < MAX_FEATURE_INTRO_SKIPS;
    }),
    isExistingUser: isExistingUser(),
    newInSettings: FEATURE_INTROS
      .filter((intro) => { const s = states[intro.id]; return s?.via === "skips" && s.answer === "off" && !s.seenInSettings; })
      .map((intro) => intro.id),
  };
}

export type FeatureIntroChange =
  | { ok: true; state: FeatureIntroState }
  | { ok: false; status: 404; error: string };

const unknownIntro = (id: string): FeatureIntroChange => ({ ok: false, status: 404, error: `No feature introduction named "${id}"` });

/**
 * The tour's Turn on / Turn off: every tool of the feature is written as an explicit switch, and
 * nothing else in the AI settings moves (the session limits and ask-before-create keep theirs).
 */
export function answerFeatureIntro(id: string, answer: FeatureIntroAnswer, now = new Date()): FeatureIntroChange {
  const intro = featureIntroById(id);
  if (!intro) return unknownIntro(id);
  const ai = configService.get("ai");
  configService.set("ai", { ...ai, ppm_tools: { ...ai.ppm_tools, ...switchesForAnswer(intro, answer) } });
  const states = readFeatureIntroStates();
  const state: FeatureIntroState = { ...stateOf(states, id), answer, answeredAt: now.toISOString(), via: "tour" };
  delete state.seenInSettings;
  configService.set("feature_intros", { ...states, [id]: state });
  log.info(`Feature "${id}" turned ${answer} from the tour`);
  return { ok: true, state };
}

/**
 * "Later", or closing the tour without answering. The last allowed skip settles the feature as
 * off, which Settings → Tools then marks NEW. A feature already settled is left as it is.
 */
export function skipFeatureIntro(id: string, now = new Date()): FeatureIntroChange {
  if (!featureIntroById(id)) return unknownIntro(id);
  const states = readFeatureIntroStates();
  const current = stateOf(states, id);
  if (current.answer) return { ok: true, state: current };
  const skips = current.skips + 1;
  const state: FeatureIntroState = skips >= MAX_FEATURE_INTRO_SKIPS
    ? { answer: "off", skips, answeredAt: now.toISOString(), via: "skips" }
    : { answer: null, skips };
  configService.set("feature_intros", { ...states, [id]: state });
  if (state.answer) log.info(`Feature "${id}" left off after ${skips} skips`);
  return { ok: true, state };
}

/** Settings → Tools was opened while the feature was marked NEW there. */
export function markFeatureIntroSeenInSettings(id: string): FeatureIntroChange {
  if (!featureIntroById(id)) return unknownIntro(id);
  const states = readFeatureIntroStates();
  const current = stateOf(states, id);
  if (current.seenInSettings) return { ok: true, state: current };
  const state: FeatureIntroState = { ...current, seenInSettings: true };
  configService.set("feature_intros", { ...states, [id]: state });
  return { ok: true, state };
}
