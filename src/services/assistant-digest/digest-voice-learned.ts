/**
 * The morning digest's weekly voice section: on Mondays, the words voice self-learning added in the
 * past seven days, across every project. Only to let the user know — the words already work, and
 * undoing one is done in Settings → Voice, so the section asks nothing.
 */
import { DIGEST_VOICE_LEARNED_MAX, type DigestVoiceLearned } from "../../shared/assistant-digest.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { VoiceMessageConfig } from "../../shared/voice-message.ts";
import { readVoiceSettings, selfLearningOn } from "../voice-message/voice-settings.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether `date` (YYYY-MM-DD, the digest's local date) is a Monday. */
export function isMonday(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  return !!y && !!m && !!d && new Date(y, m - 1, d).getDay() === 1;
}

/**
 * The words learned in the seven days before `now`, newest first, each project's under its name
 * (the Assistant's as "PPM Assistant"). Empty on any day but Monday, or with the summary switched off.
 */
export function voiceLearnedThisWeek(config: VoiceMessageConfig, date: string, now: number): DigestVoiceLearned[] {
  if (!selfLearningOn(config) || !config.weekly_summary || !isMonday(date)) return [];
  const since = now - WEEK_MS;
  return Object.entries(config.projects)
    .flatMap(([project, words]) => words.learned
      .filter((l) => Date.parse(l.at) >= since && Date.parse(l.at) <= now)
      .map((l) => ({ word: l.word, from: l.from, project: project === ASSISTANT_PROJECT_NAME ? "PPM Assistant" : project, at: l.at })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, DIGEST_VOICE_LEARNED_MAX)
    .map(({ word, from, project }) => ({ word, from, project }));
}

export function digestVoiceLearned(date: string, now: number): DigestVoiceLearned[] {
  return voiceLearnedThisWeek(readVoiceSettings(), date, now);
}
