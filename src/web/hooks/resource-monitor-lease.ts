/** Pure/network helpers for `use-resource-monitor.ts`'s subscriber lease and history
 *  retention — split out to keep that file under the repo's 200-line guideline and so
 *  the lease request shape and retention rule are unit-testable in isolation. */
import { getAuthToken } from "@/lib/api-client";
import type { MetricsHistoryPoint } from "../../types/system-metrics";

/** Group aggregates are only ever read for the last 60 points (process-table-model's
 *  sparklines); retaining them for the full 900-point/30-min history window wastes
 *  tens of MB of small objects on a phone for data nothing reads. System aggregates
 *  keep the full window. */
export const GROUPS_RETENTION = 60;

/** Same bearer the kill request uses — every route under `/api/*` requires it, and the
 *  lease endpoints have no `?token=` fallback (that exists only for the GET-based SSE
 *  stream itself, which cannot set headers). Without this, ping/DELETE 401 silently,
 *  the server reaps the lease at 30s, and the client reconnects forever. */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Fire-and-forget ping keeping the subscriber lease alive — a missed one just costs
 *  one server-side reap cycle. */
export async function pingLease(sid: string): Promise<void> {
  await fetch(`/api/system/resources/stream/${encodeURIComponent(sid)}/ping`, {
    method: "POST",
    headers: authHeaders(),
  }).catch(() => {});
}

/** Best-effort lease teardown — the server-side 30s reap is the real backstop (a proxy
 *  can buffer this DELETE away exactly when the client actually disconnected). */
export async function deleteLease(sid: string): Promise<void> {
  await fetch(`/api/system/resources/stream/${encodeURIComponent(sid)}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).catch(() => {});
}

/** Drops `groups` from every history point older than the last `retain` entries.
 *  Pure so the retention behaviour is unit-testable without a live EventSource. */
export function withGroupsRetention(
  history: MetricsHistoryPoint[],
  retain: number,
): MetricsHistoryPoint[] {
  const cutoff = history.length - retain;
  if (cutoff <= 0) return history;
  let changed = false;
  const next = history.map((point, i) => {
    if (i >= cutoff || Object.keys(point.groups).length === 0) return point;
    changed = true;
    return { ...point, groups: {} };
  });
  return changed ? next : history;
}
