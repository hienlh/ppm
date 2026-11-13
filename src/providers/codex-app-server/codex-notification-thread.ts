/** The app-server puts the owner thread on every item notification.  An
 * `agentThreadId` inside a SubAgentActivity is the newly spawned child, so it
 * must never be used here: that would nest the launch card inside itself. */
export function threadIdFromNotification(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const direct = p.threadId ?? p.thread_id;
  if (typeof direct === "string" && direct) return direct;
  const thread = p.thread;
  if (thread && typeof thread === "object" && typeof (thread as Record<string, unknown>).id === "string") {
    return (thread as Record<string, unknown>).id as string;
  }
  return null;
}
