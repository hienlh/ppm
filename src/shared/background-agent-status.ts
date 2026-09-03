/**
 * Lifecycle of a backgrounded subagent (`Agent`/`Task` with `run_in_background`).
 *
 * The tool call itself returns the instant the agent is spawned — its result is a launch
 * acknowledgement, not a report. The agent then runs past the end of the turn and only
 * reports back through a `<task-notification>` the CLI injects as a user message.
 *
 * A tool card that treats the launch ack as "finished" therefore shows a green check while
 * the agent is still working and its step count keeps climbing. Everything here exists so
 * both the transcript loader and the live stream can tell the two apart.
 */

import type { ChatEvent, ChatMessage } from "../types/chat";

/** Terminal states the CLI reports for a background task. */
export type BackgroundAgentStatus = "completed" | "failed" | "stopped";

/** Text the Agent/Task tool returns when it only spawned the agent. */
const LAUNCH_ACK = "Async agent launched successfully";

/**
 * Whether an Agent/Task tool result is a launch acknowledgement rather than the agent's
 * report. Keyed off the result text, not `input.run_in_background`: that flag is optional
 * (backgrounding is the default) and absent from most recorded calls, whereas the ack text
 * is emitted for every async launch and never for a synchronous one.
 */
export function isAsyncAgentLaunchAck(output: string | undefined): boolean {
  return !!output && output.includes(LAUNCH_ACK);
}

const NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

/** Terminal statuses reported by `<task-notification>` blocks, keyed by Agent tool_use id. */
export function parseTaskNotifications(content: string): Map<string, BackgroundAgentStatus> {
  const out = new Map<string, BackgroundAgentStatus>();
  if (!content.includes("<task-notification>")) return out;
  for (const [, body] of content.matchAll(NOTIFICATION_RE)) {
    const toolUseId = body!.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/)?.[1]?.trim();
    const status = body!.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    // Orphan-scan summaries carry task ids but no tool-use-id — nothing to attach them to.
    if (!toolUseId || !isTerminalAgentStatus(status)) continue;
    out.set(toolUseId, status);
  }
  return out;
}

/** Whether a CLI-reported task status means the agent has stopped running for good. */
export function isTerminalAgentStatus(v: string | undefined): v is BackgroundAgentStatus {
  return v === "completed" || v === "failed" || v === "stopped";
}

/**
 * Stamp `bgStatus` onto every backgrounded Agent/Task tool_use in a loaded transcript.
 *
 * Notifications land in user messages that come after — sometimes many turns after — the
 * message holding the tool call, so this has to run across the whole transcript rather than
 * per message. Agents with no notification yet are left unstamped: the card reads that as
 * still running.
 */
export function applyBackgroundAgentStatus(messages: ChatMessage[]): void {
  const statuses = new Map<string, BackgroundAgentStatus>();
  for (const msg of messages) {
    if (msg.role !== "user" || !msg.content) continue;
    for (const [id, status] of parseTaskNotifications(msg.content)) statuses.set(id, status);
  }
  if (statuses.size === 0) return;

  for (const msg of messages) {
    for (const ev of msg.events ?? []) {
      if (!isSubagentToolUse(ev) || !ev.toolUseId) continue;
      const status = statuses.get(ev.toolUseId);
      if (status) ev.bgStatus = status;
    }
  }
}

function isSubagentToolUse(ev: ChatEvent): ev is Extract<ChatEvent, { type: "tool_use" }> {
  return ev.type === "tool_use" && (ev.tool === "Agent" || ev.tool === "Task");
}
