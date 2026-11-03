/** Wording shared by a turn chip, its tooltip and its preview sheet. */

export const TOOLS_OFF_WARNING = "The AI can't read this turn — turn read_session_turns back on in Settings → Tools";

let timeFormat: Intl.DateTimeFormat | undefined;

/** The turn's start in local time; empty when the stored time cannot be read. */
export function turnRefTime(iso: string): string {
  try {
    timeFormat ??= new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "" : timeFormat.format(at);
  } catch {
    return "";
  }
}
