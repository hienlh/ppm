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

/** One project's section of the digest card. */
export interface DigestProject {
  name: string;
  /** `no_answer`: the manager had not answered by the deadline (busy, or the ask never reached it). */
  state: "answered" | "no_answer";
  /** The manager's items, already cleaned by the report tool. */
  items: string[];
  /** The project keeps its details off the phone: Telegram shows only how many items there are. */
  titleOnly?: boolean;
}

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
