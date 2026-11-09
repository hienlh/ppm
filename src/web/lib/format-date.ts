// Given options, `toLocaleDateString` builds a new formatter on every call — the hottest line
// when a long chat redraws its timestamps.
let shortDate: Intl.DateTimeFormat | undefined;

/**
 * Format an ISO timestamp as a short English relative time string.
 * Examples: "just now", "5m ago", "3h ago", "2d ago", "Apr 21".
 */
export function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    shortDate ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    return shortDate.format(date);
  } catch {
    return "";
  }
}
