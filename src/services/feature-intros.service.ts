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
  answerFromSwitches, FEATURE_INTRO_SKIP_WINDOW_MS, FEATURE_INTROS, featureIntroById, MAX_FEATURE_INTRO_SKIPS, switchesForAnswer,
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
  if (typeof value.lastSkipAt === "string" && !Number.isNaN(Date.parse(value.lastSkipAt))) state.lastSkipAt = value.lastSkipAt;
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

/**
 * An install somebody has used: a chat session was ever recorded. Projects do not count, because
 * `ppm init` adds every git repository under the home directory and the basic tour's first step
 * picks one, so a brand-new install usually has projects before anyone has used it.
 */
export function isExistingUser(): boolean {
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

/** `changed` is false when the request was valid but nothing was written. */
export type FeatureIntroChange =
  | { ok: true; state: FeatureIntroState; changed: boolean }
  | { ok: false; status: 404; error: string };

const unknownIntro = (id: string): FeatureIntroChange => ({ ok: false, status: 404, error: `No feature introduction named "${id}"` });

/**
 * The tour's Turn on / Turn off: every tool of the feature is written as an explicit switch, and
 * nothing else in the AI settings moves (the session limits and ask-before-create keep theirs).
 *
 * A feature already decided — answered on another device, settled by a switch set in Settings,
 * or switched off by skipping — is left as it is and its current state returned: a device that
 * missed the change (its `/ws/global` was down) must not overwrite per-tool choices made since.
 */
export function answerFeatureIntro(id: string, answer: FeatureIntroAnswer, now = new Date()): FeatureIntroChange {
  const intro = featureIntroById(id);
  if (!intro) return unknownIntro(id);
  settleFeaturesDecidedInSettings(now);
  const states = readFeatureIntroStates();
  const current = stateOf(states, id);
  if (current.answer) {
    log.info(`Feature "${id}" already ${current.answer} (via ${current.via ?? "unknown"}); ignoring a late "${answer}"`);
    return { ok: true, state: current, changed: false };
  }
  const ai = configService.get("ai");
  configService.set("ai", { ...ai, ppm_tools: { ...ai.ppm_tools, ...switchesForAnswer(intro, answer) } });
  const state: FeatureIntroState = { ...current, answer, answeredAt: now.toISOString(), via: "tour" };
  delete state.seenInSettings;
  configService.set("feature_intros", { ...states, [id]: state });
  log.info(`Feature "${id}" turned ${answer} from the tour`);
  return { ok: true, state, changed: true };
}

/**
 * "Later", or closing the tour without answering. The last allowed skip settles the feature as
 * off, which Settings → Tools then marks NEW. A feature already settled is left as it is, and so
 * is one skipped within {@link FEATURE_INTRO_SKIP_WINDOW_MS}: every tab and device open at once
 * closing the question is one "later", not several.
 */
export function skipFeatureIntro(id: string, now = new Date()): FeatureIntroChange {
  if (!featureIntroById(id)) return unknownIntro(id);
  const states = readFeatureIntroStates();
  const current = stateOf(states, id);
  if (current.answer) return { ok: true, state: current, changed: false };
  if (current.lastSkipAt && now.getTime() - Date.parse(current.lastSkipAt) < FEATURE_INTRO_SKIP_WINDOW_MS) {
    return { ok: true, state: current, changed: false };
  }
  const skips = current.skips + 1;
  const lastSkipAt = now.toISOString();
  const state: FeatureIntroState = skips >= MAX_FEATURE_INTRO_SKIPS
    ? { answer: "off", skips, answeredAt: lastSkipAt, via: "skips", lastSkipAt }
    : { answer: null, skips, lastSkipAt };
  configService.set("feature_intros", { ...states, [id]: state });
  if (state.answer) log.info(`Feature "${id}" left off after ${skips} skips`);
  return { ok: true, state, changed: true };
}

/** Settings → Tools was opened while the feature was marked NEW there. */
export function markFeatureIntroSeenInSettings(id: string): FeatureIntroChange {
  if (!featureIntroById(id)) return unknownIntro(id);
  const states = readFeatureIntroStates();
  const current = stateOf(states, id);
  if (current.seenInSettings) return { ok: true, state: current, changed: false };
  const state: FeatureIntroState = { ...current, seenInSettings: true };
  configService.set("feature_intros", { ...states, [id]: state });
  return { ok: true, state, changed: true };
}
