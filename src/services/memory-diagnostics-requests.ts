/**
 * Counts HTTP requests by route for the memory monitor, so growth can be put next to traffic.
 *
 * The server's 26/10/2026 leak kept about a file's size of native memory per *file response*
 * and per transcript read. Spawn counts could not show that: it rose with requests, not with
 * child processes. A per-route count and the bytes each route sent, logged beside private
 * bytes, is what lets the next reader say "it grows by N MB per `/api/files/raw`".
 *
 * Counters are cumulative; each reader keeps its own previous copy and diffs (`diffRequestCounts`),
 * because the 30-second monitor and the 30-minute summary read the same counters at different rates.
 *
 * A route key is the method plus the path with anything that is data — a project name, an id,
 * a file path, a token — replaced by a placeholder, so the log never carries one.
 */

export interface RouteCount {
  count: number;
  /** Bytes declared by `Content-Length`; a streamed body has none and is counted in `streamed`. */
  bytes: number;
  streamed: number;
}

/** Segments after which the next one is a name or a token, never a route word. */
const NAME_BEFORE = new Set(["project", "projects", "session", "sessions", "content", "grid-export", "whep", "designs", "accounts", "connections", "extensions"]);
/** A segment that reads as a route word rather than data. */
const ROUTE_WORD = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_SEGMENTS = 4;
/** Distinct keys kept; a path pattern we failed to normalise must not grow the map forever. */
const MAX_KEYS = 500;

/** `GET /api/project/ppm/files/raw?path=…` → `GET /api/project/:name/files`. Exported for tests. */
export function requestRouteKey(method: string, pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] !== "api" && segs[0] !== "ws") {
    const ext = pathname.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
    return `${method} static${ext ? ` .${ext}` : ""}`;
  }
  const out: string[] = [];
  for (let i = 0; i < segs.length && out.length < MAX_SEGMENTS; i++) {
    const seg = segs[i]!;
    const prev = segs[i - 1];
    if (prev && NAME_BEFORE.has(prev)) out.push(":name");
    else out.push(ROUTE_WORD.test(seg) ? seg : ":x");
  }
  return `${method} /${out.join("/")}`;
}

export class RequestTracker {
  private readonly counts = new Map<string, RouteCount>();
  private total = 0;

  record(method: string, pathname: string, contentLength: string | null): void {
    this.total++;
    const key = requestRouteKey(method, pathname);
    let entry = this.counts.get(key);
    if (!entry) {
      if (this.counts.size >= MAX_KEYS) return;
      entry = { count: 0, bytes: 0, streamed: 0 };
      this.counts.set(key, entry);
    }
    entry.count++;
    const n = contentLength === null ? NaN : Number(contentLength);
    if (Number.isFinite(n)) entry.bytes += n; else entry.streamed++;
  }

  /** A copy of the cumulative counters. */
  read(): { total: number; routes: Map<string, RouteCount> } {
    const routes = new Map<string, RouteCount>();
    for (const [k, v] of this.counts) routes.set(k, { ...v });
    return { total: this.total, routes };
  }
}

/** What happened between two readings: the busiest routes, by count, with MB sent. */
export function diffRequestCounts(
  prev: ReturnType<RequestTracker["read"]> | undefined,
  now: ReturnType<RequestTracker["read"]>,
  limit: number,
): { total: number; top: Record<string, { n: number; mb: number; streamed: number }> } {
  const rows: Array<[string, number, number, number]> = [];
  for (const [key, v] of now.routes) {
    const p = prev?.routes.get(key);
    const n = v.count - (p?.count ?? 0);
    if (n <= 0) continue;
    rows.push([key, n, v.bytes - (p?.bytes ?? 0), v.streamed - (p?.streamed ?? 0)]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  const top: Record<string, { n: number; mb: number; streamed: number }> = {};
  for (const [key, n, bytes, streamed] of rows.slice(0, limit)) {
    top[key] = { n, mb: Math.round((bytes / (1024 * 1024)) * 10) / 10, streamed };
  }
  return { total: now.total - (prev?.total ?? 0), top };
}

export const requestTracker = new RequestTracker();
