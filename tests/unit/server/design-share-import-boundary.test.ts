/**
 * The public share surface stays out of the rest of PPM by construction: the guest routes
 * (`src/server/routes/design-share-guest*.ts`) and the share services
 * (`src/services/design/share/**`) import nothing from chat, terminals, the filesystem
 * routes, git, the database tools, the AI providers, the WebSocket handlers, or any other
 * route module. A reviewer's request can then only reach code written for reviewers.
 *
 * Direct imports, resolved to real paths: the transitive graph reaches most of PPM through
 * the config and notification services, so it cannot say anything useful.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const rel = (abs: string) => relative(ROOT, abs).replace(/\\/g, "/");

/** Where nothing on the share surface may import from. */
const FORBIDDEN: readonly RegExp[] = [
  /^src\/services\/chat[^/]*\.ts$/,
  /^src\/services\/(terminal|fs-ops|git[^/]*|db-ai-tools|database|tab-tools-mcp|session-file-baselines|remote-desktop|system-metrics|system-services)\//,
  /^src\/services\/(terminal|file|fs-path-guard|git)[^/]*\.ts$/,
  /^src\/providers\//,
  /^src\/server\/ws\//,
  /^src\/server\/index\.ts$/,
];

/** Route modules the guest routes may use: their own, the static route's build folder, and the shared guards. */
const ALLOWED_ROUTES: readonly RegExp[] = [
  /^src\/server\/routes\/design-share-guest[^/]*\.ts$/,
  /^src\/server\/routes\/static\.ts$/,
  /^src\/server\/routes\/cross-origin-guard\.ts$/,
];

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The share-surface file's imports that break the boundary, as repository paths. */
function forbiddenImports(file: string, source: string): string[] {
  const bad: string[] = [];
  for (const { path } of transpiler.scanImports(source)) {
    if (!path.startsWith(".")) continue;
    const target = rel(resolve(dirname(file), path));
    const isRoute = target.startsWith("src/server/routes/");
    if (FORBIDDEN.some((re) => re.test(target)) || (isRoute && !ALLOWED_ROUTES.some((re) => re.test(target)))) bad.push(target);
  }
  return bad;
}

function shareSurface(): string[] {
  const routes = join(ROOT, "src/server/routes");
  const share = join(ROOT, "src/services/design/share");
  return [
    ...readdirSync(routes).filter((n) => /^design-share-guest.*\.ts$/.test(n)).map((n) => join(routes, n)),
    ...readdirSync(share, { recursive: true }).map(String).filter((n) => n.endsWith(".ts")).map((n) => join(share, n)),
  ];
}

describe("design share import boundary", () => {
  const files = shareSurface();

  it("covers the guest routes and every share service", () => {
    const names = files.map(rel);
    for (const known of ["src/server/routes/design-share-guest.ts", "src/server/routes/design-share-guest-comments.ts",
      "src/services/design/share/design-share-resolve.ts", "src/services/design/share/design-share-comments.service.ts"]) {
      expect(names).toContain(known);
    }
  });

  it("imports nothing from chat, terminals, files, git, database tools, providers or other routes", () => {
    const found = files.flatMap((f) => forbiddenImports(f, readFileSync(f, "utf8")).map((t) => `${rel(f)} -> ${t}`));
    expect(found).toEqual([]);
  });

  it("the scan sees a forbidden import, including a dynamic one and one through a re-export", () => {
    const file = join(ROOT, "src/services/design/share/design-share-example.ts");
    const source = [
      'import { chatService } from "../../chat.service.ts";',
      'export { fsWrite } from "../../fs-ops/fs-ops-read-write.service.ts";',
      'const git = await import("../../git-changes/git-events.ts");',
      'import { projectRoutes } from "../../../server/routes/projects.ts";',
      'import { resolveShareCode } from "./design-share-resolve.ts";',
    ].join("\n");
    expect(forbiddenImports(file, source)).toEqual([
      "src/services/chat.service.ts",
      "src/services/fs-ops/fs-ops-read-write.service.ts",
      "src/services/git-changes/git-events.ts",
      "src/server/routes/projects.ts",
    ]);
  });
});
