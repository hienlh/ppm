/**
 * Pure helpers behind the Agent/Task card's one-line summary and the chat's
 * slimmed in-memory record of a subagent's work — no React, so this is directly
 * unit-testable and reusable from `use-chat.ts`'s live routing.
 *
 * A "step" is a distinct child `tool_use` id. A card's own direct children count
 * one step each — including a nested Agent/Task call, which counts once for
 * spawning it — and that nested call's *own* subtree is then summed in on top
 * (`recursiveStepCount`), so the number shown on a one-line card equals the
 * live session window's flat count of every `tool_use` in the whole on-disk
 * transcript, not just this card's immediate children. `stepIds` is a Set-like
 * array of ids so a WS replay re-delivering the same `tool_use` never
 * double-counts — the one thing today's `children.length` badge could not
 * guarantee.
 *
 * "Kept children" are what stays in memory once the full list is gone: nested
 * Agent/Task stubs (recursively slimmed the same way, so a further-nested card
 * still routes and lists correctly) and file-mutation tool_use/tool_result
 * pairs (the change tray reads these). Everything else that would otherwise be
 * silently dropped goes into a bounded ring buffer instead — the fallback shown
 * when no on-disk transcript exists to stream from.
 */
import type { ChatEvent } from "../../types/chat";
import { basename } from "./utils";
import { FILE_MUTATION_TOOLS } from "./aggregate-turn-file-changes";

/** Live cards keep at most this many "other" (not kept) child events. */
export const MAX_RECENT_CHILDREN = 200;

/** Ring buffer also evicts oldest-first once its serialized size passes this — a handful of
 *  multi-MB tool outputs would otherwise fit comfortably under the 200-entry count cap while
 *  still holding many megabytes per live card. */
export const MAX_RECENT_BYTES = 256 * 1024;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** "1 step" / "N steps" — every place a card shows its step count uses this instead of
 *  hardcoding the plural, which read as "1 steps" for a single-step agent. */
export function formatStepCount(count: number): string {
  return `${count} step${count === 1 ? "" : "s"}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

/** Plain-text one-line description of a `tool_use` step — the same wording as
 *  the JSX `ToolSummary` in `tool-cards.tsx`, minus the markup, so it fits the
 *  card's "current step" line and is usable from a DOM-free test. */
export function describeStep(ev: ChatEvent): string {
  if (ev.type !== "tool_use") return "";
  const tool = ev.tool;
  const input = ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : {};
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = str(input.notebook_path || input.file_path);
      return path ? `${tool} ${basename(path)}` : tool;
    }
    case "Bash":
    case "PowerShell": {
      const preview = input.description ? str(input.description) : str(input.command);
      return truncate(preview, 60) || tool;
    }
    case "Glob":
      return `Glob ${str(input.pattern)}`;
    case "Grep":
      return `Grep ${truncate(str(input.pattern), 40)}`;
    case "WebSearch":
      return `Search ${truncate(str(input.query), 50)}`;
    case "WebFetch":
      return `Fetch ${truncate(str(input.url), 50)}`;
    case "ToolSearch":
      return `Search ${truncate(str(input.query), 50)}`;
    case "Agent":
    case "Task": {
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
      const task = truncate(str(input.description || input.prompt), 44);
      if (name) return task ? `${name} · ${task}` : name;
      return task || tool;
    }
    case "SendMessage":
      return `Message ${truncate(str(input.to), 30)}`.trim();
    case "TodoWrite":
      return "Todo update";
    case "AskUserQuestion":
      return "Question";
    case "ScheduleWakeup":
      return "Scheduled wakeup";
    case "TaskCreate":
      return truncate(str(input.subject), 60) || tool;
    case "TaskUpdate":
      return `Task #${str(input.taskId)} → ${str(input.status)}`;
    case "TaskStop":
      return `Task #${str(input.taskId)} stopped`;
    case "ImageGen":
      return "Image generation";
    default:
      return tool;
  }
}

/** A `tool_use` child that survives slimming on its own account. */
function isKeptToolUse(tool: string): boolean {
  return tool === "Agent" || tool === "Task" || FILE_MUTATION_TOOLS.has(tool);
}

export interface SlimAgentChildren {
  /** Distinct child `tool_use` ids counted as steps, in arrival order. */
  stepIds: string[];
  /** Plain-text description of the most recent step, if any arrived. */
  lastStep?: string;
  /** Nested Agent/Task stubs (recursively slimmed) + file-mutation tool_use/result pairs. */
  kept: ChatEvent[];
}

/**
 * Recompute a subagent's `{stepIds, lastStep, kept}` from its full child list —
 * used for a from-scratch reduction (history load for a card whose provider
 * stamped `transcriptAvailable`, or any caller that only has the raw array and
 * no running per-card state to update incrementally).
 */
export function slimAgentChildren(children: ChatEvent[] | undefined): SlimAgentChildren {
  const stepIds: string[] = [];
  const kept: ChatEvent[] = [];
  const keptToolUseIds = new Set<string>();
  let lastStep: string | undefined;

  (children ?? []).forEach((ev, i) => {
    if (ev.type === "tool_use") {
      stepIds.push(ev.toolUseId ?? `idx:${i}`);
      const desc = describeStep(ev);
      if (desc) lastStep = desc;
      if (isKeptToolUse(ev.tool)) {
        const isAgent = ev.tool === "Agent" || ev.tool === "Task";
        if (isAgent) {
          const nested = slimAgentChildren(ev.children);
          kept.push({
            ...ev,
            children: nested.kept,
            stepIds: nested.stepIds,
            stepCount: nested.stepIds.length,
            lastStep: nested.lastStep,
          });
        } else {
          kept.push(ev);
        }
        if (ev.toolUseId) keptToolUseIds.add(ev.toolUseId);
      }
    } else if (ev.type === "tool_result") {
      if (ev.toolUseId && keptToolUseIds.has(ev.toolUseId)) kept.push(ev);
    }
    // text/thinking/other event kinds are never kept in the slimmed set.
  });

  return { stepIds, lastStep, kept };
}

/**
 * Recursive count of every `tool_use` across a card's whole subtree: this card's own direct
 * steps (a nested Agent/Task counted once, for spawning it) plus, for each such nested card,
 * everything further inside it. A nested Agent/Task stub is always kept in `.children` (never
 * the ring buffer — see `isKeptToolUse`), so its own `stepCount`/`stepIds` is always the latest
 * value live-routed into it, and summing over `.children` here never revisits the same id
 * twice: the nested card's own direct count already excludes its own id.
 */
export function recursiveStepCount(tool: Extract<ChatEvent, { type: "tool_use" }>): number {
  const direct = tool.stepCount ?? tool.stepIds?.length ?? slimAgentChildren(tool.children).stepIds.length;
  let total = direct;
  for (const child of tool.children ?? []) {
    if (child.type === "tool_use" && (child.tool === "Agent" || child.tool === "Task")) {
      total += recursiveStepCount(child);
    }
  }
  return total;
}

/** `{stepCount, lastStep}` for the one-line card: `stepCount` is always the recursive total
 *  (see `recursiveStepCount`) so it equals the session window's flat count; `lastStep` prefers
 *  the field a live card or a slimmed history card already carries, and only falls back to
 *  recomputing from `children` when unset (e.g. a card rendered straight from a server search
 *  result, or an unstamped history card that kept its full list). */
export function agentStepInfo(tool: Extract<ChatEvent, { type: "tool_use" }>): { stepCount: number; lastStep?: string } {
  const stepCount = recursiveStepCount(tool);
  if (tool.stepCount != null) return { stepCount, lastStep: tool.lastStep };
  const { lastStep } = slimAgentChildren(tool.children);
  return { stepCount, lastStep };
}

function approxByteSize(ev: ChatEvent): number {
  try { return JSON.stringify(ev).length; } catch { return 0; }
}

/** Drop oldest entries (keeping at least one) while the buffer's approximate serialized
 *  size exceeds `MAX_RECENT_BYTES` — a count cap alone lets a handful of huge tool outputs
 *  through untouched. */
function capByBytes(buffer: ChatEvent[]): ChatEvent[] {
  let total = buffer.reduce((sum, e) => sum + approxByteSize(e), 0);
  let start = 0;
  while (total > MAX_RECENT_BYTES && start < buffer.length - 1) {
    total -= approxByteSize(buffer[start]!);
    start++;
  }
  return start > 0 ? buffer.slice(start) : buffer;
}

/**
 * Upsert `ev` into a bounded ring buffer: a WS replay re-delivering the same
 * `toolUseId` replaces the existing entry in place instead of growing the
 * buffer, and anything past `MAX_RECENT_CHILDREN` (count) or `MAX_RECENT_BYTES`
 * (approximate serialized size) is dropped from the front.
 *
 * `seq` stamps the entry's `arrivalSeq` for `mergeFallbackEvents` to later
 * interleave this buffer back together with the kept `children` list in the
 * order events actually arrived — omitted by direct/standalone callers that
 * have no parent-level counter to hand it a value.
 */
export function pushRecentChild(buffer: ChatEvent[], ev: ChatEvent, seq?: number): ChatEvent[] {
  const id = (ev as { toolUseId?: string }).toolUseId;
  if (id) {
    const idx = buffer.findIndex((e) => e.type === ev.type && (e as { toolUseId?: string }).toolUseId === id);
    if (idx !== -1) {
      const preserved = (buffer[idx] as { arrivalSeq?: number }).arrivalSeq;
      const next = [...buffer];
      next[idx] = (seq != null ? { ...ev, arrivalSeq: preserved } : ev) as ChatEvent;
      return next;
    }
  }
  const stamped = seq != null ? ({ ...ev, arrivalSeq: seq } as ChatEvent) : ev;
  const next = [...buffer, stamped];
  const capped = next.length > MAX_RECENT_CHILDREN ? next.slice(next.length - MAX_RECENT_CHILDREN) : next;
  return capByBytes(capped);
}

/**
 * Merge kept `children` with the bounded "other" ring buffer back into the order events
 * actually arrived in: splitting live arrivals into a kept list and a ring buffer by
 * kind (nested-agent/file-mutation vs everything else) loses the interleaving between them —
 * a plain concatenation showed every edit before the reads that actually preceded it. Each
 * entry's `arrivalSeq` (stamped by `applyChildToParent`/`pushRecentChild`) says where it
 * really sorts; an entry with none (never live-routed, e.g. a history-loaded card, which
 * never populates both lists at once) keeps its position within its own list.
 */
export function mergeFallbackEvents(kept: ChatEvent[], recent: ChatEvent[]): ChatEvent[] {
  const tag = (list: ChatEvent[]) =>
    list.map((ev, i) => ({ ev, seq: (ev as { arrivalSeq?: number }).arrivalSeq ?? i }));
  return [...tag(kept), ...tag(recent)]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.ev);
}

/**
 * Apply one newly-arrived child event to its Agent/Task parent, updating
 * `stepIds`/`stepCount`/`lastStep` and routing the child into either the kept
 * `children` (nested stub or file mutation, upserted by id the same way the
 * pre-slimming code deduped a replay) or the `recentChildren` ring buffer.
 *
 * Every routed child is stamped with the parent's monotonic `childSeq` (preserved rather
 * than reassigned when the upsert is an update-in-place, e.g. a tool_result arriving for an
 * already-kept tool_use) — the arrival order `mergeFallbackEvents` needs to interleave
 * `children` and `recentChildren` back together correctly.
 */
export function applyChildToParent(parent: ChatEvent, childEvent: ChatEvent): ChatEvent {
  if (parent.type !== "tool_use") return parent;

  let stepIds = parent.stepIds;
  let lastStep = parent.lastStep;
  if (childEvent.type === "tool_use") {
    const id = childEvent.toolUseId;
    if (!id || !stepIds?.includes(id)) stepIds = [...(stepIds ?? []), id ?? `idx:${stepIds?.length ?? 0}`];
    const desc = describeStep(childEvent);
    if (desc) lastStep = desc;
  }

  const seq = parent.childSeq ?? 0;

  const upsertKept = (list: ChatEvent[]): ChatEvent[] => {
    const id = (childEvent as { toolUseId?: string }).toolUseId;
    const idx = id ? list.findIndex((c) => c.type === childEvent.type && (c as { toolUseId?: string }).toolUseId === id) : -1;
    if (idx !== -1) {
      const preserved = (list[idx] as { arrivalSeq?: number }).arrivalSeq;
      const next = [...list];
      next[idx] = { ...childEvent, arrivalSeq: preserved } as ChatEvent;
      return next;
    }
    return [...list, { ...childEvent, arrivalSeq: seq } as ChatEvent];
  };

  const children = parent.children ?? [];
  const recentChildren = parent.recentChildren ?? [];
  const isKeptToolUseChild = childEvent.type === "tool_use" && isKeptToolUse(childEvent.tool);
  const matchesKeptToolUse = (id: string | undefined) =>
    !!id && children.some((c) => c.type === "tool_use" && c.toolUseId === id);

  let nextChildren = children;
  let nextRecent = recentChildren;
  if (isKeptToolUseChild) {
    nextChildren = upsertKept(children);
  } else if (childEvent.type === "tool_result" && matchesKeptToolUse(childEvent.toolUseId)) {
    nextChildren = upsertKept(children);
  } else {
    nextRecent = pushRecentChild(recentChildren, childEvent, seq);
  }

  return {
    ...parent,
    children: nextChildren,
    recentChildren: nextRecent,
    stepIds,
    stepCount: stepIds?.length,
    lastStep,
    childSeq: seq + 1,
  };
}

/** Walk a history message tree, slimming every Agent/Task card a provider
 *  stamped `transcriptAvailable` on; an unstamped card keeps its full children
 *  (there is no disk source to fall back to, so it stays the fallback itself). */
export function slimHistoryEvents(events: ChatEvent[] | undefined): ChatEvent[] | undefined {
  if (!events) return events;
  return events.map((ev) => {
    if (ev.type !== "tool_use" || (ev.tool !== "Agent" && ev.tool !== "Task") || !ev.transcriptAvailable) return ev;
    const { stepIds, lastStep, kept } = slimAgentChildren(ev.children);
    return { ...ev, children: kept, stepIds, stepCount: stepIds.length, lastStep };
  });
}
