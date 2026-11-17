/**
 * Checks a patch and turns it into the values a write stores, one entry per change field
 * (`title`, `links`, `result`, `fields.<key>`, …). Sizes are bounded, references (status, members,
 * parent) must belong to the task's project, a parent may not make a cycle, and links are stored
 * canonically (Jira keys upper-cased, PRs as `owner/repo#n`). A Jira link given as its issue URL
 * is stored as its key, and the URL's site is kept as the project's fallback Jira site.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import {
  IMPORTANCES, LINK_KINDS, ME_MEMBER_ID, PPM_TASK_LIMITS as L, TASK_TYPES, URGENCIES,
  type TaskLink, type TaskPatch, type TaskResult, type WriteContext,
} from "../../shared/ppm-tasks.ts";
import { canonicalPrRef, parseJiraKey } from "../../shared/ppm-tasks-refs.ts";
import { parseJiraIssueUrl } from "../../shared/ppm-task-link-href.ts";
import { rememberPastedJiraSite } from "./link-state/ppm-tasks-jira-site.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";
import { statusById } from "./ppm-tasks-db.ts";
import { invalid } from "./ppm-tasks-errors.ts";
import { workingSessionRefusal } from "./ppm-tasks-session-check.ts";
import { todayYmd } from "./ppm-tasks-today.ts";
import { daysBetween } from "../../shared/ppm-tasks-urgency.ts";

/** The furthest a snooze may reach: past that, closing or dropping the task says it better. */
export const MAX_SNOOZE_DAYS = 366 * 2;

export const FIELD_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Keys that would name an object's prototype rather than a field. */
const RESERVED_FIELD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `key` may name a custom field. */
export const isFieldKey = (key: unknown): key is string => typeof key === "string" && FIELD_KEY_RE.test(key) && !RESERVED_FIELD_KEYS.has(key);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(name: string, value: unknown, max: number, nullable: boolean): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw invalid(`${name} is required`);
  }
  if (typeof value !== "string") throw invalid(`${name} must be text`);
  const v = value.trim();
  if (!v) {
    if (nullable) return null;
    throw invalid(`${name} is required`);
  }
  if (v.length > max) throw invalid(`${name} is longer than ${max} characters`);
  return v;
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalid(`${name} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function validDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !YMD_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid("dueDate must be a date as YYYY-MM-DD");
  }
  return value;
}

/** A snooze day: a real date after today (in the user's zone) and within two years; null clears it. */
function snoozeDate(value: unknown, now: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !YMD_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid("snoozedUntil must be a date as YYYY-MM-DD, or null");
  }
  const today = todayYmd(now);
  const days = daysBetween(today, value);
  if (days === null || days <= 0) throw invalid(`snoozedUntil must be after today (${today}): it is the day the task shows again`);
  if (days > MAX_SNOOZE_DAYS) throw invalid("snoozedUntil may be at most two years away");
  return value;
}

function member(projectKey: string, name: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value) throw invalid(`${name} must be a member id`);
  if (value === ME_MEMBER_ID) return value;
  const row = getDb().query("SELECT archived_at FROM task_members WHERE id = ? AND project_key = ?").get(value, projectKey) as { archived_at: number | null } | null;
  if (!row) throw invalid(`${name}: no member ${value} in this project`);
  return value;
}

/** The link as stored, or why it cannot be. */
export function canonicalLink(link: { kind: unknown; ref: unknown; label?: unknown }): TaskLink {
  const kind = oneOf("link kind", link.kind, LINK_KINDS);
  const raw = text("link ref", link.ref, L.linkRef, false)!;
  let ref: string | null = raw;
  if (kind === "jira") ref = parseJiraKey(raw) ?? parseJiraIssueUrl(raw)?.key ?? null;
  else if (kind === "pr") ref = canonicalPrRef(raw);
  else if (kind === "url" && !/^https?:\/\/\S+$/i.test(raw)) ref = null;
  if (!ref) throw invalid(`Not a valid ${kind} link: ${raw}`);
  return { kind, ref, label: text("link label", link.label ?? null, L.linkLabel, true) };
}

/**
 * Keeps the site of the last Jira link given as its issue URL, so the project's keys open in a
 * browser without a Jira config. Runs inside the write's transaction (a refused write keeps
 * nothing); browsers re-read the project once the write has returned.
 */
function rememberPastedSite(projectKey: string, links: ReadonlyArray<{ kind?: unknown; ref?: unknown }>, ctx: WriteContext): void {
  const site = links.map((l) => (l?.kind === "jira" && typeof l.ref === "string" ? parseJiraIssueUrl(l.ref)?.site : null)).filter(Boolean).at(-1);
  if (site && rememberPastedJiraSite(projectKey, site)) {
    queueMicrotask(() => ppmTasksEvents.emit({ type: "project", projectKey, what: "settings", actor: ctx.actor, via: ctx.via }));
  }
}

/** Whether making `parentId` the parent of `taskId` would make a cycle. */
function makesCycle(taskId: string | null, parentId: string): boolean {
  if (!taskId) return false;
  let cursor: string | null = parentId;
  for (let hops = 0; cursor && hops < 1000; hops++) {
    if (cursor === taskId) return true;
    cursor = (getDb().query("SELECT parent_id FROM tasks WHERE id = ?").get(cursor) as { parent_id: string | null } | null)?.parent_id ?? null;
  }
  return false;
}

/**
 * The patch's values as stored, keyed by change field. `taskId` is null for a task being created.
 * `currentFieldCount` is how many custom keys the task already has (the cap counts the result).
 */
export function normalizePatch(
  projectKey: string, taskId: string | null, patch: TaskPatch, ctx: WriteContext, now: number, currentFields: Record<string, unknown> = {},
): Map<string, unknown> {
  if (!patch || typeof patch !== "object") throw invalid("Nothing to change");
  const out = new Map<string, unknown>();
  if (patch.title !== undefined) out.set("title", text("title", patch.title, L.title, false));
  if (patch.type !== undefined) out.set("type", oneOf("type", patch.type, TASK_TYPES));
  if (patch.urgency !== undefined) out.set("urgency", oneOf("urgency", patch.urgency, URGENCIES));
  if (patch.importance !== undefined) out.set("importance", oneOf("importance", patch.importance, IMPORTANCES));
  if (patch.why !== undefined) out.set("why", text("why", patch.why, L.why, true));
  if (patch.nextStep !== undefined) out.set("nextStep", text("nextStep", patch.nextStep, L.nextStep, true));
  if (patch.notes !== undefined) out.set("notes", text("notes", patch.notes, L.notes, true));
  if (patch.dueDate !== undefined) out.set("dueDate", validDate(patch.dueDate));
  if (patch.snoozedUntil !== undefined) out.set("snoozedUntil", snoozeDate(patch.snoozedUntil, now));
  if (patch.snoozeUntilChange !== undefined) {
    if (typeof patch.snoozeUntilChange !== "boolean") throw invalid("snoozeUntilChange must be true or false");
    out.set("snoozeUntilChange", patch.snoozeUntilChange);
  }
  if (patch.statusId !== undefined) {
    const status = typeof patch.statusId === "string" ? statusById(patch.statusId) : null;
    if (!status || status.projectKey !== projectKey) throw invalid(`No status ${String(patch.statusId)} in this project`);
    out.set("statusId", status.id);
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > L.tags) throw invalid(`tags must be a list of at most ${L.tags}`);
    const tags = [...new Set(patch.tags.map((t) => text("tag", t, L.tag, false)!))];
    out.set("tags", tags);
  }
  if (patch.assigneeMemberId !== undefined) out.set("assigneeMemberId", member(projectKey, "assignee", patch.assigneeMemberId));
  if (patch.waitingOnMemberId !== undefined) out.set("waitingOnMemberId", member(projectKey, "waitingOn", patch.waitingOnMemberId));
  if (patch.parentId !== undefined) {
    if (patch.parentId !== null) {
      const parent = getDb().query("SELECT project_key, deleted_at FROM tasks WHERE id = ?").get(patch.parentId) as { project_key: string; deleted_at: number | null } | null;
      if (!parent || parent.deleted_at !== null || parent.project_key !== projectKey) throw invalid("The parent task must be a task of the same project");
      if (patch.parentId === taskId || makesCycle(taskId, patch.parentId)) throw invalid("A task cannot be its own ancestor");
    }
    out.set("parentId", patch.parentId);
  }
  if (patch.workingSessionId !== undefined) {
    if (patch.workingSessionId === null) out.set("workingSessionId", null);
    else {
      const asked = text("workingSessionId", patch.workingSessionId, 200, false)!;
      const refusal = workingSessionRefusal(projectKey, asked);
      if (refusal) throw invalid(refusal);
      // Stored under the id the chat answers to now, so a provider's rename is no change.
      out.set("workingSessionId", resolveMigratedSession(asked));
    }
  }
  if (patch.links !== undefined) {
    if (!Array.isArray(patch.links) || patch.links.length > L.links) throw invalid(`links must be a list of at most ${L.links}`);
    const seen = new Set<string>();
    const links = patch.links.map(canonicalLink).filter((l) => {
      const key = `${l.kind}\u0000${l.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    out.set("links", links);
    rememberPastedSite(projectKey, patch.links, ctx);
  }
  if (patch.result !== undefined) {
    const result: TaskResult | null = patch.result === null ? null
      : { text: text("result", patch.result?.text, L.result, false)!, at: now, by: ctx.actor.label };
    out.set("result", result);
  }
  if (patch.fields !== undefined) {
    if (!patch.fields || typeof patch.fields !== "object" || Array.isArray(patch.fields)) throw invalid("fields must be an object");
    const keys = new Set(Object.keys(currentFields));
    for (const [key, value] of Object.entries(patch.fields)) {
      if (!isFieldKey(key)) throw invalid(`Field name "${key}" may use letters, digits, _ . - and at most 64 characters`);
      if (value !== null && typeof value !== "string" && typeof value !== "number") throw invalid(`Field ${key} must be text, a number or null`);
      if (typeof value === "number" && !Number.isFinite(value)) throw invalid(`Field ${key} must be a finite number`);
      if (typeof value === "string" && value.length > L.fieldValue) throw invalid(`Field ${key} is longer than ${L.fieldValue} characters`);
      if (value === null) keys.delete(key);
      else keys.add(key);
      out.set(`fields.${key}`, value);
    }
    if (keys.size > L.fieldKeys) throw invalid(`A task holds at most ${L.fieldKeys} fields`);
  }
  checkContext(ctx);
  return out;
}

/** Bounds what a write context carries; every write path calls it. */
export function checkContext(ctx: WriteContext): void {
  if (!ctx?.actor || typeof ctx.actor.label !== "string" || !ctx.actor.label.trim()) throw invalid("A write needs an actor with a label");
  if (ctx.actor.label.length > 200) throw invalid("The actor label is longer than 200 characters");
  if (ctx.reason !== undefined && ctx.reason !== null && (typeof ctx.reason !== "string" || ctx.reason.length > L.reason)) {
    throw invalid(`reason is longer than ${L.reason} characters`);
  }
}
