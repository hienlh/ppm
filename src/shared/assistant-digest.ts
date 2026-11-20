/**
 * The morning digest: once a day, at a time on the user's own clock, PPM asks every manager chat
 * whose digest switch is on for a short status and puts the answers on one card. Shared by the
 * server, which runs it, and the browser, which edits the time and draws the card.
 */
import { isClockTime } from "./assistant-quiet-hours.ts";

export interface DigestSettings {
  enabled: boolean;
  /** "HH:MM", 24-hour, in the zone saved with it (`timezone` in the same settings row). */
  time: string;
}

export const DEFAULT_DIGEST: DigestSettings = { enabled: true, time: "08:00" };

/**
 * A task of the project that waits, as PPM read it from the task store when it put the digest
 * together (not the manager's words): on whom, and until when, worded at that moment.
 */
export interface DigestWaitingTask {
  /** `ppm/12`. */
  ref: string;
  title: string;
  /** "Waiting on you", "Waiting on Việt", "Waiting". */
  label: string;
  /** The wait is on the user. */
  mine: boolean;
  /** "Due today", "Overdue (2026-11-14)", "for 2 days"; null when neither is known. */
  until: string | null;
}

/** Most waiting tasks a digest section lists; the rest are counted. */
export const DIGEST_WAITING_MAX = 8;

/** One project's section of the digest card. */
export interface DigestProject {
  name: string;
  /** `no_answer`: the manager had not answered by the deadline (busy, or the ask never reached it). */
  state: "answered" | "no_answer";
  /** The manager's items, already cleaned by the report tool. */
  items: string[];
  /** The project keeps its details off the phone: Telegram shows only how many items there are. */
  titleOnly?: boolean;
  /** The project's waiting tasks, the user's own first (absent on digests from before this list). */
  waiting?: DigestWaitingTask[];
  /** Waiting tasks left out past `DIGEST_WAITING_MAX`. */
  waitingMore?: number;
  /** How many of all the waiting tasks, listed or not, wait on the user. */
  waitingMine?: number;
}

/** "3 tasks waiting, 1 on you". */
export function digestWaitingSummary(p: Pick<DigestProject, "waiting" | "waitingMore" | "waitingMine">): string {
  const list = p.waiting ?? [];
  const total = list.length + (p.waitingMore ?? 0);
  const mine = p.waitingMine ?? list.filter((w) => w.mine).length;
  return `${plural(total, "task")} waiting${mine ? `, ${mine} on you` : ""}`;
}

/** A task that came back from a snooze on the digest's day; PPM writes these, not a manager. */
export interface DigestResurfacedTask {
  project: string;
  /** The task's code, `ppm/12`. */
  ref: string;
  title: string;
}

/** The heading of the digest's own section for tasks back from a snooze. */
export const DIGEST_RESURFACED_HEADING = "Back from snooze today";

/** Most tasks the section lists; the rest are counted. */
export const DIGEST_RESURFACED_MAX = 20;

/** A word voice self-learning added this past week (Monday's digest only). */
export interface DigestVoiceLearned {
  word: string;
  /** What Whisper had written instead. */
  from: string;
  /** The project it was learned for ("PPM Assistant" for the Assistant's). */
  project: string;
}

/** The heading of the digest's weekly voice section; it informs, and asks nothing. */
export const digestVoiceLearnedHeading = (count: number) =>
  `Voice learned ${count} word${count === 1 ? "" : "s"} this week`;
export const DIGEST_VOICE_LEARNED_HINT = "They are already in use. Undo any of them in PPM → Settings → Voice.";
export const DIGEST_VOICE_LEARNED_MAX = 30;

/** What a project that did not answer shows on the card. */
export const DIGEST_NO_ANSWER = "No answer yet (busy)";

/** What an answered project with nothing to say shows on the card. */
export const DIGEST_NOTHING_NEW = "Nothing new";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The card's title: "Morning digest · 3 projects, 5 items". */
export function digestTitle(projects: readonly DigestProject[]): string {
  const items = projects.reduce((n, p) => n + p.items.length, 0);
  return `Morning digest · ${plural(projects.length, "project")}, ${plural(items, "item")}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Stored or sent digest settings, checked; problems are listed and the defaults kept for them. */
export function readDigestSettings(raw: unknown, errors: string[]): DigestSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_DIGEST };
  if (!isRecord(raw)) {
    errors.push("digest must be an object");
    return { ...DEFAULT_DIGEST };
  }
  const out = { ...DEFAULT_DIGEST };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    else errors.push("digest.enabled must be true or false");
  }
  if (raw.time !== undefined) {
    if (isClockTime(raw.time)) out.time = raw.time;
    else errors.push("digest.time must be a time as HH:MM");
  }
  return out;
}
