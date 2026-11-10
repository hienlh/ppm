import { getConfigValue, setConfigValue } from "../db.service.ts";
import { createLogger } from "../logger.ts";

/**
 * The morning digest's run, in the `assistant_digest_state` config row (one JSON value, so no
 * migration), the way the Telegram bridge keeps `assistant_telegram_state`. Only the latest run is
 * kept: its date is what stops a second run for the same day, and everything a restart mid-run
 * needs is in it.
 *
 * Written before any ask goes out, so a crash loop finds the run and never starts it again.
 */

export const DIGEST_STATE_ROW = "assistant_digest_state";

export interface DigestRun {
  /** The user's local date the run belongs to ("YYYY-MM-DD"). */
  date: string;
  startedAt: number;
  /** Past this, the digest is put together with whatever came in. */
  deadline: number;
  /** Project key → the manager chat asked. Insertion order is the card's order. */
  asked: Record<string, string>;
  /** Project key → the project's name when it was asked. */
  names: Record<string, string>;
  /** Project key → the ask as handed to the chat. */
  delivered: Record<string, { clientMessageId: string; at: number }>;
  /** Project key → a turn of that chat opened with the ask (or it answered). */
  taken: Record<string, true>;
  /** Project key → the ask was handed over again after a restart; it never is twice. */
  redelivered: Record<string, true>;
  /** Project key → the manager's items; a second answer replaces the first. */
  answers: Record<string, string[]>;
  /** The card, once the digest was put together. */
  cardId?: string;
}

const log = createLogger("assistant-digest");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROJECTS = 200;
const MAX_ITEMS = 12;
const MAX_ITEM = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function strings(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).slice(0, MAX_PROJECTS).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

function flags(raw: unknown): Record<string, true> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).slice(0, MAX_PROJECTS).filter(([, v]) => v === true)) as Record<string, true>;
}

/** The stored run, checked field by field; null when there is none or it is not what this file writes. */
export function parseDigestRun(text: string | null): DigestRun | null {
  if (!text) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isRecord(raw) || typeof raw.date !== "string" || !DATE_RE.test(raw.date) || !finite(raw.startedAt) || !finite(raw.deadline)) return null;
  const delivered: DigestRun["delivered"] = {};
  if (isRecord(raw.delivered)) {
    for (const [key, v] of Object.entries(raw.delivered).slice(0, MAX_PROJECTS)) {
      if (isRecord(v) && typeof v.clientMessageId === "string" && finite(v.at)) delivered[key] = { clientMessageId: v.clientMessageId, at: v.at };
    }
  }
  const answers: DigestRun["answers"] = {};
  if (isRecord(raw.answers)) {
    for (const [key, v] of Object.entries(raw.answers).slice(0, MAX_PROJECTS)) {
      if (Array.isArray(v)) answers[key] = v.filter((i): i is string => typeof i === "string").slice(0, MAX_ITEMS).map((i) => i.slice(0, MAX_ITEM));
    }
  }
  return {
    date: raw.date, startedAt: raw.startedAt, deadline: raw.deadline,
    asked: strings(raw.asked), names: strings(raw.names), delivered,
    taken: flags(raw.taken), redelivered: flags(raw.redelivered), answers,
    ...(typeof raw.cardId === "string" ? { cardId: raw.cardId } : {}),
  };
}

export interface DigestStateStore {
  read(): DigestRun | null;
  write(run: DigestRun): void;
}

export const digestStateRow: DigestStateStore = {
  read: () => {
    const text = getConfigValue(DIGEST_STATE_ROW);
    const run = parseDigestRun(text);
    if (text && !run) log.warn(`${DIGEST_STATE_ROW} is not a digest run; treating it as none`);
    return run;
  },
  write: (run) => setConfigValue(DIGEST_STATE_ROW, JSON.stringify(run)),
};
