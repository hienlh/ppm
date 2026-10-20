import { Hono } from "hono";
import { createLogger } from "../logger.ts";
import { resolveAssistantProject } from "./assistant-project-scope.ts";
import {
  ROUTE_METHODS, type CallPpmRoute, type RouteCallResult, type RouteMethod, type RouteRule,
} from "./assistant-route-rules.ts";

/**
 * The Assistant's tools calling PPM's own HTTP routes in-process — the routes the UI calls — so a
 * tool gets the same validation, logging, Undo journal and `git:changed` broadcast as a click in
 * the UI, without copying any of it.
 *
 * Nothing here goes through `authMiddleware`: the caller already proved itself with the session's
 * MCP token, and the app below mounts the routers alone. That makes the allowlist the only
 * boundary, so it is deliberately narrow and literal: one family's caller reaches only the
 * method + path templates that family declared, every path is checked for anything a router
 * would read differently from the template (dot segments, encoded slashes, double encoding, a
 * second query), and every query key must be one the rule names. A refused call never reaches a
 * router.
 */

const log = createLogger("assistant-route-call");

/** Never dialled or resolved: `app.request` hands the `Request` straight to the router. */
const INTERNAL_ORIGIN = "http://ppm.internal";
const MAX_PATH_CHARS = 4096;
/** The tools send short JSON (file lists, a commit message, a schedule); anything bigger is a bug. */
const MAX_BODY_BYTES = 1024 * 1024;
export const ROUTE_NOT_ALLOWED = "route_not_allowed";

export interface RouteApp {
  request: (input: string, init: RequestInit) => Response | Promise<Response>;
}

let appPromise: Promise<RouteApp> | null = null;

/**
 * The routers the tool families may reach, mounted at the paths and in the order
 * `src/server/index.ts` mounts them, and nothing else — no auth, CORS or gzip, and none of the
 * server's other routers, so even a rule written wrongly cannot reach `/api/fs` or `/api/settings`.
 * `projectScopedRouter` is reused as it is, so its own refusals (an unregistered project, the
 * Assistant's virtual project off the chat path) still apply.
 *
 * Imported on first use, not at the top: `project-scoped.ts` pulls in the chat routes, which reach
 * the chat service and the providers, which import the MCP endpoint that imports this file — a
 * static import here would close that cycle while the server starts.
 */
export function internalRouteApp(): Promise<RouteApp> {
  appPromise ??= (async () => {
    const [tunnels, tunnel, named, tailscale, scoped, schedules] = await Promise.all([
      import("../../server/routes/tunnels.ts"),
      import("../../server/routes/tunnel.ts"),
      import("../../server/routes/named-tunnel.ts"),
      import("../../server/routes/tailscale.ts"),
      import("../../server/routes/project-scoped.ts"),
      import("../../server/routes/schedules.ts"),
    ]);
    const app = new Hono();
    // `projectScopedRouter` also carries the chat, file, workspace, LSP and design routes, and no
    // tool needs any of them: past the project's name only `git/` is let through, so one wrong
    // git rule cannot reach a file read or write.
    app.use("/api/project/*", async (c, next) => {
      if (!isProjectGitPath(new URL(c.req.url).pathname)) {
        return c.json({ ok: false, error: "Only the git routes of a project are reachable here", code: ROUTE_NOT_ALLOWED }, 403);
      }
      await next();
    });
    app.route("/api/tunnels", tunnels.tunnelRegistryRoutes);
    app.route("/api/tunnel", tunnel.tunnelRoutes);
    app.route("/api/tunnel/named", named.namedTunnelRoutes);
    app.route("/api/tailscale", tailscale.tailscaleRoutes);
    app.route("/api/project/:projectName", scoped.projectScopedRouter);
    app.route("/api/schedules", schedules.schedulesRoutes);
    return app;
  })().catch((e: unknown) => {
    // A failed import is retried by the next call rather than remembered.
    appPromise = null;
    throw e;
  });
  return appPromise;
}

/** `/api/project/<name>/git/...`: the only project routes any tool family reaches. */
export function isProjectGitPath(pathname: string): boolean {
  const segments = pathname.split("/");
  return segments[1] === "api" && segments[2] === "project" && !!segments[3] && segments[4] === "git" && segments.length > 5;
}

const LITERAL_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const PARAM_SEGMENT = /^:[A-Za-z][A-Za-z0-9]*$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Printable ASCII without space: a tool's path is built by `projectRoute`, which encodes the rest. */
const PATH_CHARS = /^[\x21-\x7e]+$/;
// eslint-disable-next-line no-control-regex -- control characters are what this pattern is for
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Why `rule` is not a rule this caller can enforce, or null. A literal segment cannot start with a
 * dot (so no `.`/`..`), a placeholder is a whole segment, and a project route names its project
 * by the `:project` placeholder, which the caller then checks against the registered projects.
 */
export function ruleProblem(rule: RouteRule): string | null {
  if (!ROUTE_METHODS.includes(rule.method)) return `unknown method ${String(rule.method)}`;
  if (typeof rule.path !== "string" || !rule.path.startsWith("/api/")) return "the path must start with /api/";
  const segments = rule.path.split("/").slice(1);
  for (const segment of segments) {
    if (!LITERAL_SEGMENT.test(segment) && !PARAM_SEGMENT.test(segment)) return `bad segment "${segment}"`;
  }
  if (segments[1] === "project" && segments[2] !== ":project") return "a project route names its project with :project";
  if (segments[1] === "project" && !isProjectGitPath(rule.path)) return "a project route may only reach the project's git routes";
  const keys = new Set<string>();
  for (const key of rule.query) {
    if (!QUERY_KEY.test(key) || keys.has(key)) return `bad or repeated query key "${key}"`;
    keys.add(key);
  }
  return null;
}

type Checked =
  | { ok: true; json: string | undefined }
  | { ok: false; status: number; error: string; code: string };

const refuse = (error: string): Checked => ({ ok: false, status: 403, error, code: ROUTE_NOT_ALLOWED });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A path segment decoded, or null when it is malformed or names something other than one segment. */
function decodeSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // `%` survives one decoding only when it was encoded twice, and a router decoding once more
  // would then read a different path (`%252F` → `%2F` → `/`).
  if (!decoded || decoded === "." || decoded === ".." || /[/\\%?#]/.test(decoded) || CONTROL_CHARS.test(decoded)) return null;
  return decoded;
}

/**
 * Checks one call against `rules` (already validated). Exported for tests; `createRouteCaller`
 * is the only production user.
 */
export function checkRouteCall(
  rules: readonly RouteRule[],
  method: unknown,
  path: unknown,
  body: unknown,
  isProject: (name: string) => string | null,
): Checked {
  if (typeof method !== "string" || !ROUTE_METHODS.includes(method as RouteMethod)) return refuse(`Method ${String(method).slice(0, 10)} is not allowed`);
  if (typeof path !== "string" || path.length > MAX_PATH_CHARS || !PATH_CHARS.test(path)) return refuse("The path is malformed");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) return refuse("The path is malformed");
  const at = path.indexOf("?");
  const pathname = at < 0 ? path : path.slice(0, at);
  const rawQuery = at < 0 ? null : path.slice(at + 1);
  if (rawQuery !== null && (!rawQuery || rawQuery.includes("?"))) return refuse("The query is malformed");

  // The URL parser is what the router sees: a path it would normalise (dot segments, a
  // re-encoded character) is not the path the rule was matched against.
  let url: URL;
  try {
    url = new URL(path, INTERNAL_ORIGIN);
  } catch {
    return refuse("The path is malformed");
  }
  if (url.origin !== INTERNAL_ORIGIN || url.pathname !== pathname || url.search !== (rawQuery === null ? "" : `?${rawQuery}`)) {
    return refuse("The path is not in canonical form");
  }

  const segments = pathname.split("/").slice(1);
  const decoded: string[] = [];
  for (const segment of segments) {
    const value = decodeSegment(segment);
    if (value === null) return refuse("The path has an empty, dot or encoded-separator segment");
    decoded.push(value);
  }

  // Literal segments compare raw, so `st%61ge` is not `stage` even though a router would decode it.
  const rule = rules.find((r) => {
    if (r.method !== method) return false;
    const template = r.path.split("/").slice(1);
    return template.length === segments.length && template.every((t, i) => t.startsWith(":") || t === segments[i]);
  });
  if (!rule) return refuse(`${method} ${pathname.slice(0, 200)} is not a route this tool may call`);

  if (rawQuery !== null) {
    const seen = new Set<string>();
    for (const [key, value] of new URLSearchParams(rawQuery)) {
      if (!rule.query.includes(key)) return refuse(`The query key "${key.slice(0, 40)}" is not allowed on this route`);
      if (seen.has(key)) return refuse(`The query key "${key.slice(0, 40)}" is given twice`);
      if (CONTROL_CHARS.test(value)) return refuse(`The query value of "${key}" has control characters`);
      seen.add(key);
    }
  }

  // The project route's own resolver would also accept a path inside a project as its "name";
  // no tool needs that, so only a registered project's exact name passes.
  if (segments[1] === "project") {
    const problem = isProject(decoded[2]!);
    if (problem) return { ok: false, status: 404, error: problem, code: "project_not_found" };
  }

  if (method === "GET" || method === "DELETE") {
    if (body !== undefined) return refuse(`A ${method} call takes no body`);
    return { ok: true, json: undefined };
  }
  if (body !== undefined && !isPlainObject(body)) return refuse("The body must be a JSON object");
  let json: string;
  try {
    json = JSON.stringify(body ?? {});
  } catch {
    return refuse("The body is not serialisable as JSON");
  }
  if (Buffer.byteLength(json) > MAX_BODY_BYTES) return refuse("The body is too large");
  return { ok: true, json };
}

const registeredProjectProblem = (name: string): string | null => {
  const project = resolveAssistantProject(name);
  return project.ok ? null : project.error;
};

/** A route's JSON envelope read into a `RouteCallResult`. */
async function readAnswer<T>(res: Response): Promise<RouteCallResult<T>> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    return { status: res.status, ok: false, error: `The route answered ${res.status} with a body that is not JSON` };
  }
  const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const ok = res.ok && envelope.ok !== false;
  return {
    status: res.status,
    ok,
    ...("data" in envelope ? { data: envelope.data as T } : {}),
    ...(typeof envelope.error === "string" ? { error: envelope.error } : !ok ? { error: `The route answered ${res.status}` } : {}),
    ...(typeof envelope.code === "string" ? { code: envelope.code } : {}),
  };
}

/**
 * A caller confined to `rules`. Rules that cannot be enforced exactly as written are dropped (and
 * logged), so a mistake in a family's list refuses calls rather than widening them.
 */
export function createRouteCaller(
  rules: readonly RouteRule[],
  deps: { app?: () => Promise<RouteApp>; isProject?: (name: string) => string | null } = {},
): CallPpmRoute {
  const valid = rules.filter((rule) => {
    const problem = ruleProblem(rule);
    if (problem) log.error(`route rule ${String(rule.method)} ${String(rule.path)} dropped: ${problem}`);
    return !problem;
  });
  const app = deps.app ?? internalRouteApp;
  const isProject = deps.isProject ?? registeredProjectProblem;
  return async <T = unknown>(method: RouteMethod, path: string, body?: Record<string, unknown>): Promise<RouteCallResult<T>> => {
    const checked = checkRouteCall(valid, method, path, body, isProject);
    if (!checked.ok) {
      if (checked.code === ROUTE_NOT_ALLOWED) log.warn(`refused ${String(method).slice(0, 10)} ${String(path).slice(0, 200)}: ${checked.error}`);
      return { status: checked.status, ok: false, error: checked.error, code: checked.code };
    }
    try {
      const res = await (await app()).request(`${INTERNAL_ORIGIN}${path}`, {
        method,
        headers: checked.json === undefined ? {} : { "content-type": "application/json" },
        ...(checked.json === undefined ? {} : { body: checked.json }),
      });
      return await readAnswer<T>(res);
    } catch (e) {
      log.error(`${method} ${path.slice(0, 200)} failed: ${(e as Error).message}`);
      return { status: 500, ok: false, error: `PPM could not run that route: ${(e as Error).message}` };
    }
  };
}
