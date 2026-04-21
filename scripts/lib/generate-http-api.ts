// Static scan of Hono route definitions. Two-pass:
//   1. Parse src/server/index.ts → mount map { mountPath: routerIdent } + import { routerIdent: relFile }.
//   2. For each mounted route file, regex-scan HTTP method calls, group by mount prefix.
// No code execution — all data comes from string parsing.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OutputFile } from "./write-output.ts";

const METHOD_RE = /\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const MOUNT_RE = /\.route\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)\s*\)/g;
const IMPORT_RE = /import\s*\{\s*([\w,\s]+)\s*\}\s*from\s*["'`]([^"'`]+)["'`]/g;

interface RouteEntry {
  method: string;
  path: string;
  desc?: string;
}

export function generateHttpApi(root: string): OutputFile[] {
  const serverIndexPath = resolve(root, "src/server/index.ts");
  if (!existsSync(serverIndexPath)) {
    return [{ relPath: "references/http-api.md", content: "# PPM HTTP API\n\n_Server index not found._\n" }];
  }

  const serverSrc = readFileSync(serverIndexPath, "utf-8");
  const importMap = parseImports(serverSrc);
  const mounts = parseMounts(serverSrc);

  // Group routes by mount prefix
  const grouped: Record<string, RouteEntry[]> = {};
  const warnings: string[] = [];

  for (const [prefix, routerIdent] of mounts) {
    const rel = importMap.get(routerIdent);
    if (!rel) {
      warnings.push(`Unresolved import for router '${routerIdent}' (mount: ${prefix})`);
      continue;
    }
    const routeFile = resolveImport(serverIndexPath, rel);
    if (!existsSync(routeFile)) {
      warnings.push(`Route file not found: ${routeFile} (router: ${routerIdent})`);
      continue;
    }
    const entries = scanRoutes(readFileSync(routeFile, "utf-8"));
    if (!grouped[prefix]) grouped[prefix] = [];
    grouped[prefix].push(...entries);
  }

  // Build markdown
  const parts: string[] = [];
  parts.push("# PPM HTTP API");
  parts.push("");
  parts.push("_Auto-generated. Do not edit._");
  parts.push("");
  parts.push("_Base URL: `http://localhost:8080` (default; override via `ppm config set port <n>`)._");
  parts.push("");

  const sortedPrefixes = Object.keys(grouped).sort();
  for (const prefix of sortedPrefixes) {
    const routes = grouped[prefix];
    if (!routes || routes.length === 0) continue;
    parts.push(`## ${prefix || "/"}`);
    parts.push("");
    for (const r of routes) {
      const fullPath = joinPath(prefix, r.path);
      const method = r.method.toUpperCase().padEnd(6);
      parts.push(`- \`${method} ${fullPath}\`${r.desc ? ` — ${r.desc}` : ""}`);
    }
    parts.push("");
  }

  parts.push("## WebSocket");
  parts.push("");
  parts.push("- `ws://<host>/ws/chat` — AI chat stream (Claude Agent SDK)");
  parts.push("- `ws://<host>/ws/terminal` — PTY terminal multiplexer");
  parts.push("- `ws://<host>/ws/extensions` — extension host channel");
  parts.push("");

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

function parseImports(src: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(IMPORT_RE);
  while ((m = re.exec(src)) !== null) {
    const ids = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const path = m[2] ?? "";
    for (const id of ids) map.set(id, path);
  }
  return map;
}

function parseMounts(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MOUNT_RE);
  while ((m = re.exec(src)) !== null) {
    out.push([m[1] ?? "", m[2] ?? ""]);
  }
  return out;
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

function scanRoutes(src: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(METHOD_RE);
  while ((m = re.exec(src)) !== null) {
    const method = m[1] ?? "";
    const path = m[2] ?? "";
    // Skip obviously-bogus matches (e.g. "http://" in URLs — regex already avoids these since path can't start with http:).
    if (path.startsWith("http:") || path.startsWith("https:")) continue;
    entries.push({ method, path });
  }
  return entries;
}

function joinPath(prefix: string, routePath: string): string {
  if (!prefix || prefix === "/") return routePath;
  if (routePath === "/" || routePath === "") return prefix;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const r = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return p + r;
}
