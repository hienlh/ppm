/**
 * The decisions behind the PPM Tasks UI kit, as pure functions: labels, tones, the due label, what
 * the working-session chip says, and how a link's live state reads. The kit components only draw
 * what these return, so the rules are tested without rendering.
 */
import { daysBetween } from "../../../shared/ppm-tasks-urgency";
import type { Importance, LinkState, TaskLink, Urgency } from "../../../shared/ppm-tasks";
import type { TaskCheckSummary, TaskWorkingSession } from "../../../shared/ppm-tasks-api";

export const URGENCY_LABEL: Record<Urgency, string> = { now: "Now", today: "Today", week: "This week", later: "Later" };
export const IMPORTANCE_LABEL: Record<Importance, string> = { must: "Must", should: "Should", nice: "Nice to have" };
export const TYPE_LABEL: Record<string, string> = { task: "Task", decision: "Decision", reply: "Reply" };

export const typeLabel = (type: string): string => TYPE_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1);

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Overdue 2d", "Today", "Tomorrow", "Fri", "18 Nov"; `soon` when due tomorrow or earlier. */
export function dueView(dueYmd: string | null, todayYmd: string): { label: string; soon: boolean; overdue: boolean } | null {
  if (!dueYmd) return null;
  const days = daysBetween(todayYmd, dueYmd);
  if (days === null) return { label: dueYmd, soon: false, overdue: false };
  if (days < 0) return { label: `Overdue ${-days}d`, soon: true, overdue: true };
  if (days === 0) return { label: "Today", soon: true, overdue: false };
  if (days === 1) return { label: "Tomorrow", soon: true, overdue: false };
  const [y, m, d] = dueYmd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (days <= 6) return { label: WEEKDAY[date.getUTCDay()]!, soon: false, overdue: false };
  return { label: `${d} ${MONTH[m - 1]}`, soon: false, overdue: false };
}

/** Local date as `YYYY-MM-DD`. */
export function localYmd(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** Up to two initials; "?" for a blank name. */
export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[words.length - 1]![0]!;
  return letters.toUpperCase();
}

/** One of five tones, the same for a member everywhere. */
export function memberTone(id: string): 1 | 2 | 3 | 4 | 5 {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

export type SessionChipTone = "run" | "idle" | "need" | "mgr" | "none" | "stalled" | "finished" | "gone";

export interface SessionChipView {
  tone: SessionChipTone;
  label: string;
  /** Extra words after the label ("stalled 40 min"), when there are any. */
  detail: string | null;
  /** The chat a tap opens; null for Start chat. */
  sessionId: string | null;
  title: string;
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/**
 * What the working-session chip shows. A handed-off chat's check wins over its live dot: a chat
 * that is idle but finished without reporting, or running but making no progress, is what the
 * user must see.
 */
export function sessionChipView(working: TaskWorkingSession, check: TaskCheckSummary | null | undefined, now: number): SessionChipView {
  if (working.kind === "start_chat") {
    return { tone: "none", label: "Start chat", detail: null, sessionId: null, title: "No chat works on this task: start one" };
  }
  const s = working.session;
  const name = working.kind === "manager" ? "Manager" : s.title?.trim() || "Chat";
  const base = { label: name, sessionId: s.sessionId };
  if (s.state === "gone") return { ...base, tone: "gone", detail: "deleted", title: `${name} — the chat no longer exists` };
  if (working.kind === "session" && check?.state === "finished_no_report") {
    return { ...base, tone: "finished", detail: "finished, no report", title: `${name} — finished without recording a result` };
  }
  if (working.kind === "session" && check?.state === "stalled") {
    const detail = `stalled ${minutes(now - check.since)} min`;
    return { ...base, tone: "stalled", detail, title: `${name} — ${detail}` };
  }
  if (s.state === "waiting_card") return { ...base, tone: "need", detail: "waiting on you", title: `${name} — waiting on you` };
  if (s.state === "running") return { ...base, tone: working.kind === "manager" ? "mgr" : "run", detail: null, title: `${name} — running` };
  return { ...base, tone: working.kind === "manager" ? "mgr" : "idle", detail: null, title: `${name} — ${s.state === "unknown" ? "state unknown" : "idle"}` };
}

export type LinkTone = "info" | "ok" | "bad" | "warn" | "idle" | "merge";

export interface LinkStateView {
  /** What the chip names: the Jira key, `repo#12`, the chat title, the URL's host. */
  key: string;
  /** The live state in words; null when there is none to show (a plain URL). */
  state: string | null;
  tone: LinkTone;
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/** How a link and its cached live state read on a chip. */
export function linkStateView(link: Pick<TaskLink, "kind" | "ref" | "label">, live: LinkState | null | undefined): LinkStateView {
  const key = link.label?.trim()
    || (link.kind === "pr" ? link.ref.replace(/^[^/]+\//, "") : link.kind === "url" ? hostOf(link.ref) : link.ref);
  if (link.kind === "url") return { key, state: null, tone: "idle" };
  if (live?.error) return { key, state: `state unknown · ${live.error}`, tone: "idle" };
  const st = live?.state as Record<string, unknown> | null | undefined;
  if (!st) return { key, state: "…", tone: "idle" };
  if (link.kind === "jira") {
    const category = st.category as string | null;
    return { key, state: String(st.status ?? "unknown"), tone: category === "done" ? "ok" : category === "indeterminate" ? "info" : "idle" };
  }
  if (link.kind === "pr") {
    const state = st.state as string;
    const checks = st.checks as { failing?: number; pending?: number } | undefined;
    if (state === "merged") return { key, state: "merged", tone: "merge" };
    if (state === "closed") return { key, state: "closed", tone: "idle" };
    const ci = checks?.failing ? " · CI failing" : checks?.pending ? " · CI running" : "";
    return { key, state: `${state}${ci}`, tone: checks?.failing ? "bad" : state === "draft" ? "idle" : checks?.pending ? "warn" : "info" };
  }
  // A chat link: its live state.
  const chat = st.state as string;
  const title = (st.title as string | null)?.trim();
  const named = link.label?.trim() || title || key;
  if (chat === "running") return { key: named, state: "running", tone: "ok" };
  if (chat === "waiting_card") return { key: named, state: "waiting on you", tone: "bad" };
  if (chat === "gone") return { key: named, state: "deleted", tone: "idle" };
  return { key: named, state: chat === "unknown" ? "state unknown" : "idle", tone: "idle" };
}
