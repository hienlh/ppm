/**
 * The vocabulary a tool family uses to reach PPM's own HTTP routes in-process: how it declares
 * which routes it may call (`allowRoute`), how it spells a project route (`projectRoute`), and
 * the shape of the answer. A leaf module on purpose — it imports nothing — so a family's files
 * can import it without ever forming a cycle with the caller (`assistant-route-call.ts`) or the
 * dispatcher (`assistant-tool-family.ts`), which both import the families.
 */

export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

/**
 * One route a family may call: the method, a path template, and the query keys that route may
 * be sent. The template is literal segments and `:name` placeholders, each standing for exactly
 * one path segment — never a regular expression, so a rule cannot be written to match more than
 * it says (an unanchored pattern, a `.` that also matches `/`).
 */
export interface RouteRule {
  readonly method: RouteMethod;
  /** e.g. `/api/project/:project/git/stage`, `/api/tunnels/:pid`. */
  readonly path: string;
  /** Query keys this route may be given; any other key, or a key given twice, refuses the call. */
  readonly query: readonly string[];
}

/** Declares one allowed route. Validated when a caller is built; a bad rule refuses every call of its family. */
export const allowRoute = (method: RouteMethod, path: string, query: readonly string[] = []): RouteRule => ({
  method, path, query,
});

export type RouteQuery = Record<string, string | number | boolean | null | undefined>;

/**
 * The path of a project-scoped route: `/api/project/<name>/<sub>` with `query` appended. The
 * project name is encoded as one segment, and `null`/`undefined` values are left out, so a tool
 * can pass `{ repo: scope.query }` whether or not a repository was chosen.
 */
export function projectRoute(project: string, sub: string, query: RouteQuery = {}): string {
  return withQuery(`/api/project/${encodeURIComponent(project)}/${sub.replace(/^\/+/, "")}`, query);
}

/** `path` with `query` appended, encoded the way the caller checks it. */
export function withQuery(path: string, query: RouteQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * A route's answer. `ok` is the HTTP status and the route's own `{ ok }` envelope together;
 * `data`, `error` and `code` are the envelope's fields. A call the allowlist refused never
 * reached a route and says so with `code: "route_not_allowed"`.
 */
export interface RouteCallResult<T = unknown> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/** A caller bound to one family's routes; what a family's handler receives as `ctx.callRoute`. */
export type CallPpmRoute = <T = unknown>(method: RouteMethod, path: string, body?: Record<string, unknown>) => Promise<RouteCallResult<T>>;
