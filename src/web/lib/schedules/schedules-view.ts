/**
 * How the Schedules window reads a list of schedules, without React: which project and chip a row
 * passes, which group it sits in, and the words for its next run, last run and permission mode.
 * Kept pure (no stores, no `localStorage`) so `bun:test` can import it.
 *
 * Times are shown on the clock of the zone the schedule's cron is read in. A chat reminder kept in
 * UK time reads "18:30 London"; everything else reads on this device's clock with no label, which
 * is also the host's in the common case (the browser and PPM on one machine).
 */
import { firesWithin, parseStamp, scheduleAttention, scheduleProblem } from "../../../shared/schedule-attention";
import type { ScheduleOverview } from "../../../types/scheduler";

export const SCHEDULE_CHIPS = ["all", "upcoming", "attention", "bypass", "off"] as const;
export type ScheduleChip = (typeof SCHEDULE_CHIPS)[number];

export const CHIP_LABELS: Record<ScheduleChip, string> = {
  all: "All", upcoming: "Next 24h", attention: "Attention", bypass: "Bypass", off: "Off",
};

export interface SchedulesFilter {
  /** A registered project's name; null for every project. */
  project: string | null;
  chip: ScheduleChip;
  query: string;
}

export const DEFAULT_FILTER: SchedulesFilter = { project: null, chip: "all", query: "" };

export type ScheduleGroupId = "attention" | "upcoming" | "later" | "off";
export const GROUP_LABELS: Record<ScheduleGroupId, string> = {
  attention: "Needs attention", upcoming: "Next 24 hours", later: "Later", off: "Off",
};
const GROUP_ORDER: ScheduleGroupId[] = ["attention", "upcoming", "later", "off"];

export const isBypass = (s: Pick<ScheduleOverview, "effective_permission_mode">): boolean =>
  s.effective_permission_mode === "bypassPermissions";

/** The project a row is listed under: its registered name, else its folder's last part. */
export function projectLabel(s: Pick<ScheduleOverview, "project_name" | "project_path">): string {
  if (s.project_name) return s.project_name;
  const parts = s.project_path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? s.project_path;
}

export function groupOf(s: ScheduleOverview, now: number): ScheduleGroupId {
  if (!s.enabled) return "off";
  if (scheduleAttention(s, now)) return "attention";
  return firesWithin(s, now) ? "upcoming" : "later";
}

function passesChip(s: ScheduleOverview, chip: ScheduleChip, now: number): boolean {
  switch (chip) {
    case "all": return true;
    case "upcoming": return firesWithin(s, now);
    case "attention": return !!scheduleAttention(s, now);
    case "bypass": return !!s.enabled && isBypass(s);
    case "off": return !s.enabled;
  }
}

function matchesQuery(s: ScheduleOverview, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.name, s.prompt, s.cron_expr, projectLabel(s), s.target_title ?? "", s.task?.ref ?? "", s.task?.title ?? ""]
    .some((text) => text.toLowerCase().includes(q));
}

export function filterSchedules(list: ScheduleOverview[], filter: SchedulesFilter, now: number): ScheduleOverview[] {
  return list.filter((s) =>
    (filter.project === null || projectLabel(s) === filter.project)
    && passesChip(s, filter.chip, now)
    && matchesQuery(s, filter.query));
}

/** How many rows each chip would show inside the chosen project. */
export function chipCounts(list: ScheduleOverview[], project: string | null, now: number): Record<ScheduleChip, number> {
  const inProject = list.filter((s) => project === null || projectLabel(s) === project);
  const counts = {} as Record<ScheduleChip, number>;
  for (const chip of SCHEDULE_CHIPS) counts[chip] = inProject.filter((s) => passesChip(s, chip, now)).length;
  return counts;
}

/** Every project that has a schedule, by name, for the project picker. */
export function projectsOf(list: ScheduleOverview[]): string[] {
  return [...new Set(list.map(projectLabel))].sort((a, b) => a.localeCompare(b));
}

const fireTime = (s: ScheduleOverview): number => {
  if (s.pending_since) return parseStamp(s.pending_since);
  return s.next_fire_at ? parseStamp(s.next_fire_at) : Number.POSITIVE_INFINITY;
};

/** Groups in a fixed order, each soonest first; empty groups are left out. */
export function groupSchedules(list: ScheduleOverview[], now: number): Array<{ id: ScheduleGroupId; label: string; items: ScheduleOverview[] }> {
  const buckets = new Map<ScheduleGroupId, ScheduleOverview[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const s of list) buckets.get(groupOf(s, now))!.push(s);
  return GROUP_ORDER
    .map((id) => ({ id, label: GROUP_LABELS[id], items: buckets.get(id)!.sort((a, b) => fireTime(a) - fireTime(b) || a.id - b.id) }))
    .filter((g) => g.items.length > 0);
}

/** "in 8h 10m", "in 3m", "in 2d 22h", "now". */
export function relativeIn(at: number, now: number): string {
  const ms = at - now;
  if (ms < 60_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `in ${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

/** "3h ago", "2d ago". */
export function relativeAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "Europe/London" → "London". */
export const zoneCity = (zone: string): string => (zone.split("/").pop() ?? zone).replace(/_/g, " ");

const deviceZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; }
};

function ymd(at: number, zone: string | undefined): string {
  return new Date(at).toLocaleDateString("en-CA", zone ? { timeZone: zone } : undefined);
}

/**
 * `at` as a clock time in `zone` (this device's when null or the same as the device's), with the
 * day in front when it is not today there: "18:30", "tomorrow 02:00", "Fri 16:00", "Nov 30 09:00",
 * and the zone's city after it when the zone is not this device's: "18:30 London".
 */
export function clockLabel(at: number, zone: string | null, now: number, device = deviceZone()): string {
  const tz = zone && zone !== device ? zone : undefined;
  let time: string;
  let day = "";
  try {
    time = new Date(at).toLocaleTimeString("en-GB", { ...(tz && { timeZone: tz }), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const dayOf = ymd(at, tz);
    if (dayOf !== ymd(now, tz)) {
      if (dayOf === ymd(now + 86_400_000, tz)) day = "tomorrow ";
      else if (at - now < 6 * 86_400_000 && at > now) day = `${new Date(at).toLocaleDateString("en-GB", { ...(tz && { timeZone: tz }), weekday: "short" })} `;
      else day = `${new Date(at).toLocaleDateString("en-GB", { ...(tz && { timeZone: tz }), month: "short", day: "numeric" })} `;
    }
  } catch {
    time = new Date(at).toISOString().slice(11, 16);
  }
  return `${day}${time}${tz ? ` ${zoneCity(tz)}` : ""}`;
}

export interface WhenLabel {
  main: string;
  sub: string;
}

/** The "Next run" cell: when, on the schedule's own clock, and how far off. */
export function nextRunLabel(s: ScheduleOverview, now: number, device = deviceZone()): WhenLabel {
  if (s.mode === "always-on") return { main: "Always on", sub: s.enabled ? s.status.state : "off" };
  if (!s.enabled) return { main: "Off", sub: "" };
  if (s.paused_reason) return { main: "Paused", sub: "turn it on to resume" };
  if (s.pending_since) return { main: "Due now", sub: "waiting for its chat" };
  if (!s.next_fire_at) return { main: "No next run", sub: "" };
  const at = parseStamp(s.next_fire_at);
  const repeats = s.kind !== "session" || s.recurring === 1;
  return { main: clockLabel(at, s.timezone, now, device), sub: `${relativeIn(at, now)}${repeats ? "" : " · once"}` };
}

export type RunTone = "ok" | "bad" | "warn" | "running" | "none";

/** The "Last run" cell: its outcome in a word or two, and when. */
export function lastRunLabel(s: ScheduleOverview, now: number): { tone: RunTone; text: string; when: string } {
  const problem = scheduleProblem(s, now);
  const run = s.last_run;
  if (problem?.kind === "waiting") return { tone: "warn", text: problem.text, when: "" };
  if (problem?.kind === "paused") return { tone: "bad", text: "Paused", when: "" };
  if (!run) return { tone: "none", text: "Not run yet", when: "" };
  const at = parseStamp(run.ended_at ?? run.started_at);
  const when = relativeAgo(at, now);
  if (problem?.kind === "stuck") return { tone: "bad", text: problem.text, when: "" };
  if (run.status === "running") return { tone: "running", text: "Running", when: relativeAgo(parseStamp(run.started_at), now).replace(" ago", "") };
  if (run.status === "error") return { tone: "bad", text: run.error ? firstLine(run.error) : "Failed", when };
  return { tone: "ok", text: "Done", when };
}

const firstLine = (text: string): string => {
  const line = text.split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

export const MODE_LABELS: Record<string, string> = {
  bypassPermissions: "Bypass", acceptEdits: "Edits", plan: "Plan", default: "Ask",
};

export const modeLabel = (mode: string): string => MODE_LABELS[mode] ?? mode;

export const KIND_LABELS = { prompt: "Prompt · new chat each run", session: "Sends into a chat", script: "Script" } as const;
