/**
 * Parse a hard usage/session-limit reset hint from SDK error text.
 * Returns the human-readable reset text and a best-effort absolute timestamp,
 * or null if no reset time is present (caller treats that as a transient rate limit).
 *
 * Examples it handles: "resets 10:10am", "resets at 3pm", "resets 10:10am (Asia/Saigon)".
 */
export function parseUsageLimitReset(text: string): { text?: string; atMs?: number } | null {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  const rawText = m[0].replace(/^resets?\s+(?:at\s+)?/i, "").trim();

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (Number.isNaN(hour) || hour > 23 || minute > 59) {
    return { text: rawText || undefined };
  }
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const now = new Date();
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  // If the computed time already passed today, it must mean the next occurrence.
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);

  return { text: rawText || undefined, atMs: reset.getTime() };
}
