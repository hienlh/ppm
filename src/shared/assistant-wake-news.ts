/**
 * News PPM hands the PPM Assistant in a turn it starts on its own, besides watch events: a report a
 * manager chat filed (`done`, `failed`, `urgent`, the digest answer) and a manager's late reply to
 * a message the Assistant sent without waiting. Built by the server only; everything quoted in it
 * came from another AI and is data.
 */

export type WakeNewsKind = "report" | "late_reply";
export type WakeReportKind = "done" | "failed" | "urgent" | "digest";

export interface WakeNewsNotice {
  kind: WakeNewsKind;
  /** The card's id for a report; an id of its own for a late reply. */
  key: string;
  /** The manager chat's project and session. */
  project: string;
  sessionId: string;
  at: number;
  /** Report news only. */
  reportKind?: WakeReportKind;
  title?: string;
  body?: string;
  items?: string[];
  /** Late-reply news only: the manager's final answer. */
  text?: string;
  /** Report news only: filed by a subagent of the manager. */
  subagent?: boolean;
}

const REPORT_KINDS: readonly WakeReportKind[] = ["done", "failed", "urgent", "digest"];
const MAX_NOTICES = 50;
const MAX_FIELD = 8_000;
const MAX_ITEMS = 12;

const str = (v: unknown, max = MAX_FIELD): v is string => typeof v === "string" && v.length <= max;

/**
 * Notices arriving at the chat control boundary, checked field by field; null when any is
 * malformed. Only the server builds these, so a malformed one is a bug and is refused whole.
 */
export function parseWakeNews(raw: unknown): WakeNewsNotice[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NOTICES) return null;
  const out: WakeNewsNotice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const e = item as Record<string, unknown>;
    if (e.kind !== "report" && e.kind !== "late_reply") return null;
    if (!str(e.key, 100) || !str(e.project, 300) || !str(e.sessionId, 200)) return null;
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
    if (e.kind === "report" && !REPORT_KINDS.includes(e.reportKind as WakeReportKind)) return null;
    for (const k of ["title", "body", "text"] as const) if (e[k] !== undefined && !str(e[k])) return null;
    if (e.items !== undefined && (!Array.isArray(e.items) || e.items.length > MAX_ITEMS || !e.items.every((i) => str(i, 1000)))) return null;
    if (e.subagent !== undefined && typeof e.subagent !== "boolean") return null;
    out.push({
      kind: e.kind, key: e.key, project: e.project, sessionId: e.sessionId, at: e.at,
      ...(e.kind === "report" ? { reportKind: e.reportKind as WakeReportKind } : {}),
      ...(typeof e.title === "string" ? { title: e.title } : {}),
      ...(typeof e.body === "string" ? { body: e.body } : {}),
      ...(Array.isArray(e.items) ? { items: e.items as string[] } : {}),
      ...(typeof e.text === "string" ? { text: e.text } : {}),
      ...(e.subagent === true ? { subagent: true } : {}),
    });
  }
  return out;
}
