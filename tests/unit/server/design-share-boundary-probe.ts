/**
 * Probes an app for any way a design share code could stand in for PPM's sign-in.
 *
 * A share code is a credential of its own (it opens one shared design under `/s/<code>`), so
 * the risk is a route somewhere that accepts it as PPM's token: in the `Authorization`
 * header, a cookie, a query parameter, or by being reached through a `/s/<code>` path. Each
 * route is asked once per carrier, and a route answers correctly only by refusing:
 * - header, cookie and query carriers must get 401 (the code is not the token);
 * - path carriers must get 401, 403 or 404 (the invalid page), never the route's answer.
 *
 * `probeShareCode` reports what got through instead of asserting, so the same function can
 * be run against an app that deliberately leaks, to prove it notices.
 */

/** Something with Hono's `request()`: the real app, or a test double built from the real middleware. */
export interface RequestTarget {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

export interface ProbeRoute {
  method: string;
  /** A concrete path under `/api/`, with every parameter filled in. */
  path: string;
}

export interface Leak {
  route: string;
  carrier: string;
  status: number;
}

type Carrier = { name: string; kind: "credential" | "path"; build(route: ProbeRoute, code: string, slug: string): { url: string; headers: Record<string, string> } };

const COOKIE_NAMES = ["ppm_token", "token", "ppm-auth-token", "auth"];
const QUERY_NAMES = ["token", "dl_token", "code", "auth"];

const withQuery = (path: string, query: string) => `${path}${path.includes("?") ? "&" : "?"}${query}`;

/** Every carrier a code could be presented in. Exported so a test can assert the list is complete. */
export const CARRIERS: readonly Carrier[] = [
  { name: "bearer header", kind: "credential", build: (r, code) => ({ url: r.path, headers: { Authorization: `Bearer ${code}` } }) },
  { name: "raw authorization header", kind: "credential", build: (r, code) => ({ url: r.path, headers: { Authorization: code } }) },
  {
    name: "cookie", kind: "credential",
    build: (r, code) => ({ url: r.path, headers: { Cookie: COOKIE_NAMES.map((n) => `${n}=${code}`).join("; ") } }),
  },
  {
    name: "query", kind: "credential",
    build: (r, code) => ({ url: withQuery(r.path, QUERY_NAMES.map((n) => `${n}=${encodeURIComponent(code)}`).join("&")), headers: {} }),
  },
  { name: "path prefix", kind: "path", build: (r, code) => ({ url: `/s/${code}${r.path}`, headers: {} }) },
  { name: "encoded dot segment", kind: "path", build: (r, code) => ({ url: `/s/${code}/..%2F${r.path.slice(1)}`, headers: {} }) },
  { name: "dot segments from a design file", kind: "path", build: (r, code, slug) => ({ url: `/s/${code}/f/${slug}/../..${r.path}`, headers: {} }) },
];

const PATH_REFUSALS = new Set([401, 403, 404]);

/**
 * The routes `target` lets through with `code` in some carrier, or none. With
 * `stopAtFirstLeak`, the first request that gets through ends the probe: against the real app
 * a leak runs that route's handler, so one is enough to fail and more would only add side
 * effects. Callers put read-only routes first for the same reason.
 */
export async function probeShareCode(
  target: RequestTarget, routes: readonly ProbeRoute[], code: string, slug: string, opts: { stopAtFirstLeak?: boolean } = {},
): Promise<Leak[]> {
  const leaks: Leak[] = [];
  for (const route of routes) {
    for (const carrier of CARRIERS) {
      const { url, headers } = carrier.build(route, code, slug);
      const res = await target.request(`http://localhost${url}`, { method: route.method, headers });
      // Drained so no body stays open between thousands of requests.
      await res.arrayBuffer().catch(() => undefined);
      const refused = carrier.kind === "credential" ? res.status === 401 : PATH_REFUSALS.has(res.status);
      if (refused) continue;
      leaks.push({ route: `${route.method} ${route.path}`, carrier: carrier.name, status: res.status });
      if (opts.stopAtFirstLeak) return leaks;
    }
  }
  return leaks;
}

/** Sample values for a route's parameters; the first one the router accepts is used. */
const PARAM_SAMPLES = ["demo", "1", "home", "x"];

/** A value for a `:name{re}` parameter: the sample if it fits, else the pattern's first alternative. */
function fitting(re: string, sample: string): string {
  const pattern = new RegExp(`^(?:${re})$`);
  if (pattern.test(sample)) return sample;
  const first = re.split("|")[0]!.replace(/[^A-Za-z0-9_.-]/g, "");
  return pattern.test(first) ? first : sample;
}

/**
 * Candidate concrete paths for a route pattern, one per sample value; the caller keeps the
 * first the router really sends to the route. `:name` takes the sample, `:name{re}` a value
 * that fits `re`, and `*` takes `x`.
 */
export function concretePaths(pattern: string): string[] {
  const out: string[] = [];
  for (const sample of PARAM_SAMPLES) {
    out.push(pattern
      .replace(/:[A-Za-z0-9_]+(?:\{([^}]*)\})?\??/g, (_m, re?: string) => (re ? fitting(re, sample) : sample))
      .replace(/\*/g, "x"));
  }
  return [...new Set(out)];
}
