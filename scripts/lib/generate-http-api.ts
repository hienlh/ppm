// Static scan of Hono route definitions, starting from the `app` in src/server/index.ts: a router's
// own method calls, then each router it `.route()`s, resolved through that file's imports — the
// whole of /api/project/:projectName lives two levels down. Grouped by full mount prefix.
// Only calls on the mounted router itself count, and only paths starting with `/` or `*`: route
// files are full of `configService.get("auth")` and `c.get("projectPath")`, which are not routes.
// No code execution — all data comes from string parsing.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OutputFile } from "./write-output.ts";

const METHOD_RE = /\b(\w+)\s*\.(get|post|put|patch|delete|all)\s*\(\s*["'`](\/[^"'`]*|\*)["'`]/g;
const MOUNT_RE = /\b(\w+)\s*\.route\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)\s*\)/g;
const IMPORT_RE = /import\s*\{\s*([\w,\s]+)\s*\}\s*from\s*["'`]([^"'`]+)["'`]/g;
const WS_PATH_RE = /url\.pathname\s*===\s*["'`](\/ws\/[^"'`]+)["'`]/g;
const WS_PROJECT_TYPE_RE = /wsType\s*===\s*["'`]([\w-]+)["'`]/g;

interface RouteEntry {
  method: string;
  path: string;
}

export function generateHttpApi(root: string): OutputFile[] {
  const serverIndexPath = resolve(root, "src/server/index.ts");
  if (!existsSync(serverIndexPath)) {
    return [{ relPath: "references/http-api.md", content: "# PPM HTTP API\n\n_Server index not found._\n" }];
  }

  const serverSrc = readFileSync(serverIndexPath, "utf-8");

  // Group routes by mount prefix
  const grouped: Record<string, RouteEntry[]> = {};
  const warnings: string[] = [];
  scanRouter(serverIndexPath, "app", "", grouped, warnings, new Set());

  // Build markdown
  const parts: string[] = [];
  parts.push("# PPM HTTP API");
  parts.push("");
  parts.push("_Auto-generated. Do not edit._");
  parts.push("");
  parts.push("_Base URL: `http://localhost:<port>` — `port` in `ppm status --json` (8080 unless configured otherwise)._");
  parts.push("");
  parts.push("## Authentication");
  parts.push("");
  parts.push("With auth on (the default), `/api/*` needs `Authorization: Bearer <token>` (`GET /api/health` and `GET /api/info`");
  parts.push("answer without one), and a WebSocket takes it as `?token=<token>`. The token is the access password the user");
  parts.push("signs in to PPM with; `GET /api/auth/check` answers 200 when it is right.");
  parts.push("`ppm config get auth.token` deliberately does not print it: ask the user for it rather than digging it out of");
  parts.push("the config database, or use the CLI, which needs no token.");
  parts.push("");
  parts.push("JSON responses are wrapped: `{ \"ok\": true, \"data\": … }` or `{ \"ok\": false, \"error\": \"…\" }`.");
  parts.push("");

  const sortedPrefixes = Object.keys(grouped).sort();
  for (const prefix of sortedPrefixes) {
    const routes = grouped[prefix];
    if (!routes || routes.length === 0) continue;
    parts.push(`## ${prefix || "/"}`);
    parts.push("");
    for (const r of routes) {
      const method = r.method.toUpperCase().padEnd(6);
      parts.push(`- \`${method} ${r.path}\``);
    }
    parts.push("");
  }

  parts.push(...renderWebSockets(serverSrc, warnings));

  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as { version: string };
  parts.push(`<!-- Generated from src/server/routes/ for PPM v${pkg.version} -->`);

  if (warnings.length > 0) {
    parts.push("");
    parts.push("<!--");
    parts.push("Scanner warnings (build-time):");
    for (const w of warnings) parts.push(`  - ${w}`);
    parts.push("-->");
  }

  return [{ relPath: "references/http-api.md", content: parts.join("\n") + "\n" }];
}

/** Record `ident`'s routes in `file` under `prefix`, then those of every router it mounts. */
function scanRouter(
  file: string,
  ident: string,
  prefix: string,
  grouped: Record<string, RouteEntry[]>,
  warnings: string[],
  seen: Set<string>,
): void {
  if (!existsSync(file)) {
    warnings.push(`Route file not found: ${file} (router: ${ident})`);
    return;
  }
  const key = `${file}#${ident}#${prefix}`;
  if (seen.has(key)) return;
  seen.add(key);

  const src = readFileSync(file, "utf-8");
  let routeCalls = matches(METHOD_RE, src);
  let mounts = matches(MOUNT_RE, src);
  // A router built by a factory (`export const xRoutes = createXRoutes()`) is a local `routes` or
  // `app` inside it, so when nothing is called on the name itself, every router call in the file counts.
  const own = ([, receiver]: string[]) => receiver === ident;
  if (routeCalls.some(own) || mounts.some(own)) {
    routeCalls = routeCalls.filter(own);
    mounts = mounts.filter(own);
  }
  const routes = routeCalls.map(([, , method, path]) => ({ method: method!, path: joinPath(prefix, path!) }));
  if (routes.length === 0 && mounts.length === 0) {
    warnings.push(`No routes found on '${ident}' in ${file} (mount: ${prefix})`);
    return;
  }
  // The server's own routes (`/api/health`, `/api/auth/check`) have no mount: group them by first segment.
  for (const r of routes) (grouped[prefix || `/${r.path.split("/")[1] ?? ""}`] ??= []).push(r);

  const imports = parseImports(src);
  for (const [, , subPath, subIdent] of mounts) {
    const rel = imports.get(subIdent!);
    if (!rel) {
      warnings.push(`Unresolved import for router '${subIdent}' (mount: ${joinPath(prefix, subPath!)})`);
      continue;
    }
    scanRouter(resolveImport(file, rel), subIdent!, joinPath(prefix, subPath!), grouped, warnings, seen);
  }
}

/** The sockets `fetch` upgrades in src/server/index.ts, read from its own path checks. */
function renderWebSockets(serverSrc: string, warnings: string[]): string[] {
  const paths = [...new Set(matches(WS_PATH_RE, serverSrc).map(([, p]) => p))];
  const projectTypes = [...new Set(matches(WS_PROJECT_TYPE_RE, serverSrc).map(([, t]) => t))];
  if (paths.length === 0 && projectTypes.length === 0) {
    warnings.push("No WebSocket paths found in src/server/index.ts");
    return [];
  }
  const parts = ["## WebSocket", "", "Authenticate with `?token=<token>` (see Authentication).", ""];
  for (const p of paths) parts.push(`- \`${p}\``);
  if (projectTypes.length > 0) {
    const types = projectTypes.map((t) => `\`${t}\``).join(", ");
    parts.push(`- \`/ws/project/<project>/<type>/<id>\` — \`<type>\`: ${types} (for \`chat\`, \`<id>\` is the session id)`);
  }
  parts.push("");
  return parts;
}

function matches(re: RegExp, src: string): string[][] {
  return [...src.matchAll(new RegExp(re))].map((m) => m.map((g) => g ?? ""));
}

function parseImports(src: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, ids, path] of matches(IMPORT_RE, src)) {
    for (const id of ids!.split(",").map((s) => s.trim()).filter(Boolean)) map.set(id, path!);
  }
  return map;
}

function resolveImport(fromFile: string, spec: string): string {
  // Resolve relative import from a source file. Preserve `.ts` suffix if present.
  const fromDir = resolve(fromFile, "..");
  let abs = resolve(fromDir, spec);
  if (!abs.endsWith(".ts") && !abs.endsWith(".js")) {
    abs += ".ts";
  }
  return abs;
}

function joinPath(prefix: string, routePath: string): string {
  if (!prefix || prefix === "/") return routePath;
  if (routePath === "/" || routePath === "") return prefix;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const r = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return p + r;
}
