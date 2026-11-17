/**
 * The pure half of the quick view's compact layout: what a property chip says (and says to a
 * screen reader), and how many of a task's links the quick view draws before "+N".
 */

/** How many links the quick view draws before it folds the rest into "+N". */
export const PEEK_LINK_LIMIT = 4;

/**
 * The links drawn and how many are folded away. Up to `limit` links are all drawn; past it the
 * first `limit - 1` are, and "+N" takes the last place, so it never stands in for a single link
 * that would have fitted where it is.
 */
export function peekLinks<T>(links: readonly T[], expanded: boolean, limit: number = PEEK_LINK_LIMIT): { shown: readonly T[]; hidden: number } {
  if (expanded || links.length <= limit) return { shown: links, hidden: 0 };
  const shown = links.slice(0, Math.max(0, limit - 1));
  return { shown, hidden: links.length - shown.length };
}

/** The name a member chip shows: null when nobody is picked, `unnamed` for a member not listed. */
export function peekMemberName(memberId: string | null, people: readonly { id: string; name: string }[], unnamed = "Unknown member"): string | null {
  if (!memberId) return null;
  return people.find((m) => m.id === memberId)?.name ?? unnamed;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` plus `days`, by the calendar (no clock, so no daylight-saving hour to trip on). */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The dates Due's menu offers, from the user's today, each with its day: "Tomorrow · Wed 19 Nov". */
export function peekDuePresets(todayYmd: string): { label: string; ymd: string; hint: string }[] {
  return ([["Today", 0], ["Tomorrow", 1], ["In a week", 7]] as const).map(([label, days]) => {
    const ymd = addDaysYmd(todayYmd, days);
    const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
    return { label, ymd, hint: `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTH[m - 1]}` };
  });
}

/**
 * A chip's accessible name and tooltip: "Urgency: Today" for a set field, "Add due date" for an
 * empty one (its chip is drawn faint, as the place to set it).
 */
export function peekChipTitle(field: string, value: string | null): string {
  return value ? `${field}: ${value}` : `Add ${field.toLowerCase()}`;
}
