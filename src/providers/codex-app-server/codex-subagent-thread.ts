import type { ChatEvent, ChatMessage } from "../provider.interface.ts";
import { redactTruncate } from "./codex-redact.ts";

/**
 * Subagent threads, rendered as one Agent card in the conversation that spawned
 * them.
 *
 * Codex writes a spawned subagent as a rollout of its own, in the same sessions
 * tree and with the same `cwd` as a real conversation. Left alone it surfaces
 * twice over: once as a top-level session that opens mid-stream (it has no user
 * prompt — the task is handed over as encrypted scaffolding), and once as two
 * bare `SubAgentActivity` cards in the parent. Folding the child transcript into
 * the parent's card is what makes it one step of one conversation again.
 */

/** Codex spells the item PascalCase in a rollout and camelCase on the wire. */
export const SUBAGENT_ITEM_TYPES = new Set(["SubAgentActivity", "subAgentActivity"]);

export interface SubagentActivity {
  /** Rollout id of the spawned thread — the link to its transcript. */
  threadId: string;
  /** Codex's name for the agent, e.g. `/root/simplify_login`. */
  path: string;
  done: boolean;
}

/** The transcript of a spawned thread, ready to hang under its card. */
export interface SubagentTranscript {
  events: ChatEvent[];
  /** The agent's closing message — its report back to the parent. */
  finalText: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** A `SubAgentActivity` item → normalized activity, or null if it is not one. */
export function parseSubagentActivity(item: unknown): SubagentActivity | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  if (!SUBAGENT_ITEM_TYPES.has(String(it.type ?? ""))) return null;
  const threadId = str(it.agent_thread_id) ?? str(it.agentThreadId);
  if (!threadId) return null;
  const kind = String(it.kind ?? "");
  return {
    threadId,
    path: str(it.agent_path) ?? str(it.agentPath) ?? "subagent",
    done: kind === "completed" || kind === "failed",
  };
}

/**
 * Card id derived from the spawned thread.
 *
 * The started and completed records carry DIFFERENT item ids (`call_…` vs
 * `subagent-completed-…`), so pairing on the item id leaves the call unanswered
 * and the completion orphaned as a second card. The thread they both name is
 * the stable key.
 */
export function subagentCardId(threadId: string): string {
  return `subagent-${threadId}`;
}

/** The spawn, as the Agent card the chat already knows how to expand. */
export function subagentToolUse(activity: SubagentActivity, transcript?: SubagentTranscript | null): ChatEvent {
  return {
    type: "tool_use",
    tool: "Agent",
    input: { description: activity.path },
    toolUseId: subagentCardId(activity.threadId),
    ...(transcript?.events.length ? { children: transcript.events } : {}),
  };
}

/** The completion, answering the card above with the agent's own report. */
export function subagentToolResult(activity: SubagentActivity, transcript?: SubagentTranscript | null): ChatEvent {
  return {
    type: "tool_result",
    output: redactTruncate(transcript?.finalText || `${activity.path} finished`),
    toolUseId: subagentCardId(activity.threadId),
  };
}

/** A parsed child transcript → the flat event list a card nests. */
export function transcriptToEvents(messages: ChatMessage[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const m of messages) {
    // An assistant turn with tool calls already carries its text as the last event.
    if (m.events?.length) events.push(...m.events);
    else if (m.content) events.push({ type: "text", content: m.content });
  }
  return events;
}

/** The agent's closing message, which is what it reported back. */
export function finalAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.content) return m.content;
  }
  return "";
}
