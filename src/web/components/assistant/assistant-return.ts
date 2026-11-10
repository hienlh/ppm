/**
 * Where a manager chat a phone opened from the Assistant goes back to: kept in the chat tab's
 * metadata (`returnTo`), with `returnNote` while the one-time "Switched to…" note is due. Kept
 * apart from the opening flow so the chat tab can read it without loading project switching.
 */

export interface AssistantReturn {
  kind: "assistant";
  /** The project that was active when the chip was tapped; null when it was the same one. */
  project: string | null;
}

/** The return a phone-opened manager chat carries, or null. */
export function assistantReturnOf(metadata: Record<string, unknown> | undefined): AssistantReturn | null {
  const r = metadata?.returnTo;
  if (!r || typeof r !== "object" || (r as { kind?: unknown }).kind !== "assistant") return null;
  const project = (r as { project?: unknown }).project;
  return { kind: "assistant", project: typeof project === "string" && project ? project : null };
}

/** The note shown once after the switch. */
export function switchedNote(projectName: string): string {
  return `Switched to ${projectName}. Tap ‹ Assistant to go back.`;
}
