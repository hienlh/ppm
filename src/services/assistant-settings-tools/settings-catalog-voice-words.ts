import { configService } from "../config.service.ts";
import { isFaded } from "../voice-message/voice-learned-fade.ts";
import { projectWordsOf, readVoiceSettings } from "../voice-message/voice-settings.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { BlockedWord, VoiceMessageConfig } from "../../shared/voice-message.ts";
import type { SettingEntry } from "./settings-catalog-types.ts";

/**
 * Settings → Voice → Self-learning, the lists: per project, the words PPM taught itself from
 * voice messages (`voice.learned.<project>`) and the pairs it is still counting
 * (`voice.learning.<project>`), each item written "heard → meant". The Assistant changes them the
 * way the pane's buttons do — taking an item out is Undo on a learned word and "Don't learn" on a
 * pair being counted, both of which only move it to the undone list — so a change is always one
 * the pane could make, and putting the old list back (the change log's Undo) restores exactly
 * those items. Nothing new can be added here: a word the user wants heard goes in `voice.words`.
 */

/** "mức reboot → bỏ 20": how an item reads, and the only form the lists take. */
export const voicePairItem = (from: string, word: string): string => `${from} → ${word}`;

const LIST = { type: "string_list", maxItems: 300, maxLength: 130 } as const;

/** The projects the pane can show lists for: the Assistant and every registered project. */
function voiceProjects(): string[] {
  const registered = configService.get("projects").map((p) => p.name).filter((n) => n !== ASSISTANT_PROJECT_NAME);
  return [ASSISTANT_PROJECT_NAME, ...registered];
}

const projectLabel = (project: string) => (project === ASSISTANT_PROJECT_NAME ? "PPM Assistant" : project);

/** Items in order, each once (the shape `checkValue` gives a string list). */
const unique = (items: string[]) => [...new Set(items)];

/** The learned words the pane lists (a faded one is already gone from it). */
function learnedItems(config: VoiceMessageConfig, project: string): Array<{ item: string; word: string }> {
  const now = Date.now();
  return projectWordsOf(config, project).learned.filter((l) => !isFaded(l, now)).map((l) => ({ item: voicePairItem(l.from, l.word), word: l.word }));
}

function learningItems(config: VoiceMessageConfig, project: string): Array<{ item: string; word: string }> {
  return (projectWordsOf(config, project).candidates ?? []).map((c) => ({ item: voicePairItem(c.from, c.to), word: c.to }));
}

/** Undone entries that would come back into this list: learned ones, or pairs stopped mid-count. */
function restorable(blocked: readonly BlockedWord[], list: "learned" | "learning"): Array<{ item: string; word: string }> {
  return blocked
    .filter((b) => (list === "learning" ? !!b.learning?.length : !b.learning?.length))
    .flatMap((b) => (list === "learning" ? b.learning!.map((c) => ({ item: voicePairItem(c.from, c.to), word: b.word })) : [{ item: voicePairItem(b.from, b.word), word: b.word }]));
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const lower = (s: string) => s.toLowerCase();

interface Diff { removed: string[]; added: string[] }
function diff(before: unknown, after: unknown): Diff {
  const b = asList(before);
  const a = asList(after);
  return { removed: b.filter((i) => !a.includes(i)), added: a.filter((i) => !b.includes(i)) };
}

/**
 * Why going from `before` to `after` is not something the pane's buttons could do, or null. Both
 * buttons act on the meant word, so every item teaching that word goes or stays together.
 */
function refusal(project: string, list: "learned" | "learning", before: unknown, after: unknown): string | null {
  const config = readVoiceSettings();
  const current = list === "learned" ? learnedItems(config, project) : learningItems(config, project);
  const wordOf = new Map(current.map((c) => [c.item, c.word]));
  const back = restorable(projectWordsOf(config, project).blocked ?? [], list);
  const { removed, added } = diff(before, after);
  const kept = asList(after);
  for (const item of removed) {
    const word = wordOf.get(item);
    if (!word) return `"${item}" is not in the list.`;
    const sibling = current.find((c) => c.item !== item && lower(c.word) === lower(word) && kept.includes(c.item));
    if (sibling) return `"${item}" and "${sibling.item}" both teach "${word}"; take out both or neither.`;
  }
  for (const item of added) {
    if (!back.some((r) => r.item === item)) {
      return `"${item}" was not taken out of this list before, so it cannot be put back; a word to listen for goes in voice.words.`;
    }
  }
  return null;
}

function entries(project: string): SettingEntry[] {
  const label = projectLabel(project);
  return [
    {
      key: `voice.learned.${project}`, category: "voice", label: `Voice Input → Learned words · ${label}`, tier: "direct",
      value: LIST,
      read: () => unique(learnedItems(readVoiceSettings(), project).map((l) => l.item)),
      validate: (value, before) => refusal(project, "learned", before, value),
      write: (value) => {
        const config = readVoiceSettings();
        const { removed, added } = diff(unique(learnedItems(config, project).map((l) => l.item)), value);
        const words = new Map([...learnedItems(config, project), ...restorable(projectWordsOf(config, project).blocked ?? [], "learned")].map((l) => [l.item, l.word]));
        return {
          method: "PUT", path: "/api/speech/voice-settings",
          body: { project, removeLearned: removed.map((i) => words.get(i)!).filter(Boolean), restoreBlocked: added.map((i) => words.get(i)!).filter(Boolean) },
        };
      },
      note: "Items read \"heard → meant\". Taking one out is the pane's Undo: the word is no longer used and is never learned again until put back. Put one back only by restoring an earlier list (settings_undo).",
    },
    {
      key: `voice.learning.${project}`, category: "voice", label: `Voice Input → Words being learned · ${label}`, tier: "direct",
      value: LIST,
      read: () => unique(learningItems(readVoiceSettings(), project).map((l) => l.item)),
      validate: (value, before) => refusal(project, "learning", before, value),
      write: (value) => {
        const config = readVoiceSettings();
        const { removed, added } = diff(unique(learningItems(config, project).map((l) => l.item)), value);
        const words = new Map([...learningItems(config, project), ...restorable(projectWordsOf(config, project).blocked ?? [], "learning")].map((l) => [l.item, l.word]));
        return {
          method: "PUT", path: "/api/speech/voice-settings",
          body: { project, skipLearning: removed.map((i) => words.get(i)!).filter(Boolean), restoreBlocked: added.map((i) => words.get(i)!).filter(Boolean) },
        };
      },
      note: "Pairs still being counted, \"heard → meant\". Taking one out is the pane's \"Don't learn\": it stops being counted and is never learned until put back.",
    },
  ];
}

/** Both lists of every project the pane can show. */
export function voiceWordSettings(): SettingEntry[] {
  return voiceProjects().flatMap(entries);
}
