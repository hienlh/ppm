/**
 * What a PPM tool card's header says, and the small text helpers the readers of each tool family
 * share (`ppm-tool-summaries-*.ts`). Kept apart from `ppm-tool-call.ts`, which imports the readers.
 */

export type Args = Record<string, unknown>;
export const isObj = (v: unknown): v is Args => !!v && typeof v === "object" && !Array.isArray(v);
/** A non-blank string, trimmed, or undefined. */
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** A positive whole number, or undefined. */
export const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
/** One line of at most `max` characters. */
export const oneLine = (text: string, max = 80): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Parts that are present, joined by " · ". */
export const joinParts = (...parts: Array<string | undefined | null | false>): string | undefined => {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return kept.length ? kept.join(" · ") : undefined;
};

/** A JSON object answer, or null when the text is not one. */
export function jsonAnswer(text: string): Args | null {
  const raw = text.trim();
  if (!raw.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A chat the card can open. */
export interface PpmToolSessionLink {
  sessionId: string;
  providerId?: string;
  turnId?: string;
  /** Set only when the tool named another project. */
  project?: string;
}

/** What one card's header says. */
export interface PpmToolSummary {
  /** The tool's readable name, in the form that fits where the call stands ("Create task", "Created task"). */
  label: string;
  /** What the call was about and what it answered, one line. */
  detail?: string;
  /** A short word on the right ("3 results", "4 schedules"). */
  badge?: string;
  /** The task code to open (`ppm/12`, `#12`). */
  task?: string;
  session?: PpmToolSessionLink;
}

/** One call, as a reader of a tool family sees it. */
export interface PpmToolContext {
  tool: string;
  args: Args;
  /** The answer's text (image stand-ins dropped), "" before there is one. */
  text: string;
  isError: boolean;
  /** Answered without an error: the line may say what came of it. */
  ok: boolean;
}

/** The label for where a call stands: the plain name while it runs or failed, the past form once it answered. */
export const labelFor = (ctx: PpmToolContext, present: string, past: string): string => (ctx.ok ? past : present);
