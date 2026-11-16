/**
 * A history row in words: "Manager nxsys changed urgency Today → Now", "You marked Done",
 * "Assistant created this". Values are named the way the task page names them (status names,
 * members, urgency labels), so a row reads the same as the field it changed.
 */
import { AI_ACTOR_KINDS, type HistoryChange, type HistoryEntry, type TaskMember, type TaskStatusDef } from "../../../shared/ppm-tasks";
import { IMPORTANCE_LABEL, URGENCY_LABEL, typeLabel } from "./ppm-tasks-kit-logic";
import { memberName } from "./task-format";

export interface HistoryNames {
  statuses?: readonly TaskStatusDef[];
  members?: readonly TaskMember[];
}

const FIELD_LABEL: Record<string, string> = {
  title: "title", type: "type", statusId: "status", urgency: "urgency", importance: "importance", why: "why", nextStep: "next step",
  notes: "notes", dueDate: "due date", tags: "tags", assigneeMemberId: "assignee", waitingOnMemberId: "waiting on", parentId: "parent",
  workingSessionId: "working chat", links: "links", result: "result", decision: "decision", rank: "order", deletedAt: "deleted",
};

export const isAiEntry = (e: Pick<HistoryEntry, "actor">): boolean => AI_ACTOR_KINDS.includes(e.actor.kind);

function fieldLabel(field: string): string {
  return field.startsWith("fields.") ? field.slice(7) : FIELD_LABEL[field] ?? field;
}

/** One value as the task page would show it; null for "nothing". */
export function valueText(field: string, v: unknown, names: HistoryNames): string | null {
  if (v === null || v === undefined || v === "") return null;
  switch (field) {
    case "statusId": return names.statuses?.find((s) => s.id === v)?.name ?? String(v);
    case "urgency": return URGENCY_LABEL[v as keyof typeof URGENCY_LABEL] ?? String(v);
    case "importance": return IMPORTANCE_LABEL[v as keyof typeof IMPORTANCE_LABEL] ?? String(v);
    case "type": return typeLabel(String(v));
    case "assigneeMemberId":
    case "waitingOnMemberId": return memberName(String(v), names.members);
    case "tags": return Array.isArray(v) ? v.join(", ") || null : String(v);
    case "links": return Array.isArray(v) ? `${v.length} link${v.length === 1 ? "" : "s"}` : null;
    case "result": return typeof v === "object" ? String((v as { text?: unknown }).text ?? "") : String(v);
    case "decision": return null;
    default: return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "urgency Today → Now", "due date set to 2026-11-18", "notes cleared". */
export function changeText(c: HistoryChange, names: HistoryNames): string {
  const label = fieldLabel(c.field);
  const before = valueText(c.field, c.before, names);
  const after = valueText(c.field, c.after, names);
  if (c.field === "why" || c.field === "nextStep" || c.field === "notes") return after ? `edited ${label}` : `cleared ${label}`;
  if (c.field === "links" && Array.isArray(c.before) && Array.isArray(c.after)) {
    const had = new Set((c.before as Array<{ ref: string }>).map((l) => l.ref));
    const added = (c.after as Array<{ ref: string }>).filter((l) => !had.has(l.ref)).map((l) => l.ref);
    const now = new Set((c.after as Array<{ ref: string }>).map((l) => l.ref));
    const removed = [...had].filter((r) => !now.has(r));
    return [added.length ? `linked ${added.join(", ")}` : "", removed.length ? `unlinked ${removed.join(", ")}` : ""].filter(Boolean).join("; ") || "changed links";
  }
  if (before && after) return `changed ${label} ${clip(before, 40)} → ${clip(after, 40)}`;
  if (after) return `set ${label} to ${clip(after)}`;
  if (before) return `cleared ${label}`;
  return `changed ${label}`;
}

/** The row's sentence after the actor's name. */
export function entryText(e: HistoryEntry, names: HistoryNames): string {
  switch (e.kind) {
    case "created": return "created this";
    case "closed": {
      const status = e.changes.find((c) => c.field === "statusId");
      return `closed it${status ? ` as ${valueText("statusId", status.after, names)}` : ""}`;
    }
    case "reopened": return "reopened it";
    case "reordered": return "changed its order";
    case "decided": {
      const d = e.changes.find((c) => c.field === "decision")?.after as { chosen?: { optionId: string }; options?: Array<{ id: string; label: string }> } | undefined;
      const opt = d?.options?.find((o) => o.id === d.chosen?.optionId);
      return opt ? `chose ${opt.id.toUpperCase()} — ${clip(opt.label)}` : "made the decision";
    }
    case "decision": return "set the decision options";
    case "result": {
      const r = e.changes.find((c) => c.field === "result")?.after as { text?: string } | null | undefined;
      return r?.text ? `recorded the result: ${clip(r.text)}` : "cleared the result";
    }
    case "deleted": return "deleted it";
    case "undo": return "undid a change";
    default: return e.changes.map((c) => changeText(c, names)).join("; ") || "changed it";
  }
}

/** "from Telegram", "with a tool"; null for PPM itself. */
export function viaText(e: Pick<HistoryEntry, "via">): string | null {
  return e.via === "telegram" ? "from Telegram" : e.via === "api" ? "through the API" : null;
}
