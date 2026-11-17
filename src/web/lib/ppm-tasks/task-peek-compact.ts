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

/** The name a member chip shows: null when nobody is picked, a fallback for a member no longer listed. */
export function peekMemberName(memberId: string | null, people: readonly { id: string; name: string }[]): string | null {
  if (!memberId) return null;
  return people.find((m) => m.id === memberId)?.name ?? "Unknown member";
}

/**
 * A chip's accessible name and tooltip: "Urgency: Today" for a set field, "Add due date" for an
 * empty one (its chip is drawn faint, as the place to set it).
 */
export function peekChipTitle(field: string, value: string | null): string {
  return value ? `${field}: ${value}` : `Add ${field.toLowerCase()}`;
}
