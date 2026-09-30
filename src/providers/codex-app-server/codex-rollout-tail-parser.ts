import type { ChatEvent } from "../provider.interface.ts";
import { stripSharedContext } from "../../shared/provider-context.ts";
import { redactTruncate } from "./codex-redact.ts";
import { completeLines, parseLine } from "./codex-rollout-header.ts";
import { mapRolloutItem } from "./codex-rollout-items.ts";
import { subagentToolResult, subagentToolUse } from "./codex-subagent-thread.ts";
import {
  customToolCallToToolUse, fnCallToToolUse, fnOutputToToolResult, genericCallToToolUse,
} from "./codex-history.ts";

/**
 * Line-fed parser for ONE codex rollout, for the live Agent-session window.
 *
 * Unlike `rolloutMessageSteps` (`codex-history.ts`) this never groups events
 * into user/assistant turns and never answers a "load more" request — it just
 * turns each newly-written record into flat step events, in the order they
 * were written, as the file grows. It must never change how history renders,
 * so it is a separate reader over the same schema rather than a refactor of
 * the existing one.
 *
 * A child rollout writes its OWN `session_meta` first and its parent's second
 * (a forked context) — only the first describes the file, so every session_meta
 * after the first is ignored entirely here, the same as `readRolloutHeader` does.
 */

/**
 * First cli_version observed (2026-10-01 survey of ~3400 local rollouts)
 * writing the newer `item_completed` record instead of the legacy
 * `response_item` pairs. Below this, a file is read the legacy way; at or
 * above it, or when the version cannot be read at all, the newer/default path
 * is used — an older writer's rollout has nothing later versions removed, so
 * reading it as the newer shape would just find no item_completed records and
 * emit nothing.
 */
const FIRST_ITEM_EVENTS_CLI_VERSION = "0.154.0";

function isOlderThan(version: string, floor: string): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

/** One step, wire-ready for `/ws/global` push. */
export interface TailEventEnvelope {
  ev: ChatEvent;
  /** Epoch ms, from the record's own timestamp (carried forward when absent). */
  ts: number;
  /** A later event reusing a `toolUseId` already emitted — the client updates
   *  that step in place (a tool_result answering an earlier tool_use is the
   *  common case) instead of appending a new one. */
  replace?: boolean;
}

export interface TailFeedResult {
  events: TailEventEnvelope[];
  /** The file rewrote its own history (compaction / rollback): the caller must
   *  drop everything it has for this parser and re-read the file from byte 0. */
  reset?: boolean;
  /** Thread ids of subagents spawned since the previous `feed()` call, so the
   *  caller can start tailing their rollouts alongside this one. */
  links: string[];
}

/** Redact the input of a tool_use whose tool name is an unmapped item/call
 *  type verbatim — the generic fallback that would otherwise carry through
 *  whatever fields an unrecognized record happened to have, unredacted. */
function redactIfGeneric(ev: ChatEvent, rawType: string): ChatEvent {
  if (ev.type === "tool_use" && ev.tool === rawType) {
    return { ...ev, input: redactTruncate(ev.input) };
  }
  return ev;
}

/** Always-generic legacy-path call (its tool name already comes from `p.name`,
 *  there is nothing more specific to compare it against). */
function redactGenericCall(ev: ChatEvent): ChatEvent {
  return ev.type === "tool_use" ? { ...ev, input: redactTruncate(ev.input) } : ev;
}

export function createRolloutTailParser(): { feed(chunk: string): TailFeedResult } {
  // Raw text not yet terminated by a newline — carried to the next feed() call
  // rather than parsed early, so a chunk boundary landing mid-line (or mid
  // multi-byte character) never produces a corrupt partial record.
  let pending = "";
  let headerSeen = false;
  let format: "item-events" | "legacy" = "item-events";
  const seenIds = new Set<string>();
  let lastTs = 0;

  function resolveTs(raw: unknown): number {
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) { lastTs = parsed; return parsed; }
    }
    return lastTs;
  }

  function push(out: TailEventEnvelope[], ev: ChatEvent, ts: number): void {
    const id = "toolUseId" in ev ? ev.toolUseId : undefined;
    if (id) {
      if (seenIds.has(id)) { out.push({ ev, ts, replace: true }); return; }
      seenIds.add(id);
    }
    out.push({ ev, ts });
  }

  function reset(out: TailEventEnvelope[]): void {
    // The window is about to be rebuilt from byte 0, so every id emitted so
    // far is no longer "already sent" from the caller's point of view either.
    seenIds.clear();
    out.length = 0;
  }

  function feed(chunk: string): TailFeedResult {
    pending += chunk;
    const lastNl = pending.lastIndexOf("\n");
    const ready = lastNl >= 0 ? pending.slice(0, lastNl + 1) : "";
    pending = lastNl >= 0 ? pending.slice(lastNl + 1) : pending;

    const out: TailEventEnvelope[] = [];
    const links: string[] = [];
    const linkSeen = new Set<string>();
    let didReset = false;

    for (const line of completeLines(ready)) {
      const rec = parseLine(line);
      if (!rec) continue;
      const p = rec.payload ?? {};
      const ts = resolveTs(rec.timestamp);

      if (rec.type === "session_meta") {
        if (!headerSeen) {
          headerSeen = true;
          const cliVersion = typeof p.cli_version === "string" ? p.cli_version : undefined;
          format = cliVersion && isOlderThan(cliVersion, FIRST_ITEM_EVENTS_CLI_VERSION) ? "legacy" : "item-events";
        }
        continue;
      }

      if (rec.type === "compacted") {
        reset(out);
        didReset = true;
        continue;
      }

      if (rec.type === "event_msg") {
        if (p.type === "thread_rolled_back") {
          reset(out);
          didReset = true;
          continue;
        }
        if (p.type === "user_message" && typeof p.message === "string") {
          push(out, { type: "text", content: stripSharedContext(p.message) }, ts);
          continue;
        }
        if (p.type === "agent_message" && typeof p.message === "string") {
          push(out, { type: "text", content: p.message }, ts);
          continue;
        }
        if (p.type === "item_completed" && format === "item-events") {
          const item = p.item;
          const rawType = item && typeof item === "object" && typeof (item as Record<string, unknown>).type === "string"
            ? (item as Record<string, unknown>).type as string
            : "";
          const mapped = mapRolloutItem(item);
          if (mapped.kind === "user") {
            push(out, { type: "text", content: stripSharedContext(mapped.text) }, ts);
          } else if (mapped.kind === "assistant") {
            push(out, { type: "text", content: mapped.text }, ts);
          } else if (mapped.kind === "events") {
            for (const ev of mapped.events) push(out, redactIfGeneric(ev, rawType), ts);
          } else if (mapped.kind === "subagent") {
            const { activity } = mapped;
            if (!linkSeen.has(activity.threadId)) { linkSeen.add(activity.threadId); links.push(activity.threadId); }
            // No `children`: the window renders nested agents flat, following
            // in timestamp order as their own steps rather than nested inline.
            push(out, activity.done ? subagentToolResult(activity) : subagentToolUse(activity), ts);
          }
          continue;
        }
        continue;
      }

      if (rec.type === "response_item" && format === "legacy") {
        if (p.type === "function_call") push(out, fnCallToToolUse(p), ts);
        else if (p.type === "function_call_output") push(out, fnOutputToToolResult(p), ts);
        else if (p.type === "custom_tool_call") push(out, customToolCallToToolUse(p), ts);
        else if (p.type === "custom_tool_call_output") push(out, fnOutputToToolResult(p), ts);
        else if (typeof p.type === "string" && p.type.endsWith("_call_output")) push(out, fnOutputToToolResult(p), ts);
        else if (typeof p.type === "string" && p.type.endsWith("_call")) push(out, redactGenericCall(genericCallToToolUse(p)), ts);
      }
    }

    return { events: out, links, ...(didReset ? { reset: true as const } : {}) };
  }

  return { feed };
}
