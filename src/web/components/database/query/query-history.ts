/**
 * The Query tab's History panel, the part with no React in it: the request for one page of what the
 * audit log holds for the tab's connection, a page folded into the list shown, and the words an
 * entry is shown with.
 */
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import { formatRelativeTime } from "../../../../shared/blame";
import { QUERY_HISTORY_PAGE, type QueryHistoryItem } from "../../../../shared/db-query-script";
import { countOf } from "./query-run-state";

/** `GET /history` for entries from `offset` on, holding `search` when there is one. */
export function historyUrl(target: DbTarget, search: string, offset: number): string {
  const base = targetUrl(target, "/history");
  const params = new URLSearchParams();
  if (search.trim()) params.set("search", search.trim());
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base;
}

/**
 * The list once a page read from `offset` has come: the first page is the list, a later one goes
 * after it. Entries run since the last page push the older ones down, so a later page can repeat
 * the end of the list — those it leaves out.
 */
export function mergeHistoryPage(shown: readonly QueryHistoryItem[], page: readonly QueryHistoryItem[], offset: number): QueryHistoryItem[] {
  if (offset === 0) return [...page];
  const seen = new Set(shown.map((item) => item.id));
  return [...shown, ...page.filter((item) => !seen.has(item.id))];
}

/** A full page: the log may hold more. */
export function historyHasMore(page: readonly QueryHistoryItem[]): boolean {
  return page.length >= QUERY_HISTORY_PAGE;
}

/** The line above an entry's SQL: when it ran, in which of the server's databases, how many rows, how long. */
export function historyMeta(item: QueryHistoryItem, now: number): string[] {
  const parts = [formatRelativeTime(Date.parse(item.ranAt), now)];
  if (item.database) parts.push(item.database);
  if (item.status === "ok" && item.rowCount !== null) parts.push(countOf(item.rowCount, "row"));
  if (item.durationMs !== null) parts.push(`${item.durationMs.toLocaleString("en-US")} ms`);
  return parts;
}

/** What an entry's coloured dot says to a screen reader. */
export const HISTORY_STATUS_LABEL: Readonly<Record<QueryHistoryItem["status"], string>> = {
  ok: "Ran",
  error: "Failed",
  blocked: "Blocked",
};

/** The footer: where the list comes from, and how far back it can reach. */
export function retentionNote(days: number, maxSizeMb: number): string {
  return `Read from the existing audit log. Kept as long as audit settings say (${countOf(days, "day")} / ${maxSizeMb.toLocaleString("en-US")} MB).`;
}
