/**
 * Messages a person sent while the AI was working, waiting to reach it (Claude Code's queue).
 *
 * The server holds the list per session and sends the whole of it as `queue_state` whenever it
 * changes and in every greeting, so every device shows the same stack. A message leaves the list
 * when the provider starts reading it (it then appears in the conversation), when it is taken
 * back, or when it is removed.
 */

export interface QueuedMessage {
  /** The id the provider knows it by (Claude's command uuid); stable for the message's life. */
  id: string;
  content: string;
  imageCount: number;
  /** The sending browser's id for it, so that browser can tie the echo to its own send. */
  clientMessageId?: string;
  queuedAt: string;
}

/** What a provider reports about one queued message: Claude's `command_lifecycle` states. */
export type QueueLifecycleState = "queued" | "started" | "completed" | "cancelled";

export const QUEUE_LIFECYCLE_STATES: readonly QueueLifecycleState[] = ["queued", "started", "completed", "cancelled"];

/** Server → browser: the session's queue, in the order it will be read. */
export interface QueueStateEvent {
  type: "queue_state";
  queue: QueuedMessage[];
}

/** Queued messages held by PPM go out as one message, the way Claude coalesces what it had queued. */
export function joinQueuedContent(contents: readonly string[]): string {
  return contents.map((c) => c.trim()).filter(Boolean).join("\n\n");
}
