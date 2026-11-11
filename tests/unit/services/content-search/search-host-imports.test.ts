/**
 * The search host (`ppm __search__`) must never reach the database or the config: `getDb()` opens
 * the real `ppm.db` for whoever asks first, and the host is a second process beside the server.
 * The main-thread client must not reach the search code either: there is no fallback that runs a
 * search inside the server process.
 *
 * The transitive graph of relative imports, resolved to repository paths.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const rel = (abs: string) => relative(ROOT, abs).replace(/\\/g, "/");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every repository file `entry` reaches through relative imports (static and dynamic). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!path.startsWith(".")) continue;
      const target = resolveImport(file, path);
      if (target) walk(target);
    }
  };
  walk(resolve(ROOT, entry));
  return new Set([...seen].map(rel));
}

describe("search host import graph", () => {
  it("search-host.ts reaches no database or config module", () => {
    const graph = importGraph("src/services/content-search/search-host.ts");
    expect(graph.has("src/services/content-search/search-run.ts")).toBe(true);
    expect(graph.has("src/services/content-search/replace-run.ts")).toBe(true);
    const bad = [...graph].filter((f) => /(^|\/)(db\.service|config\.service)\.ts$/.test(f) || f.startsWith("src/services/db-") && !f.startsWith("src/services/db-backup/db-backup-paths"));
    expect(bad).toEqual([]);
  });

  it("the main-thread client never imports the search or replace code (no fallback)", () => {
    const graph = importGraph("src/services/content-search/search-host-client.ts");
    const bad = [...graph].filter((f) =>
      /content-search\/(search-run|replace-run|rg-json-parse|grep-matches|search-args|search-host)\.ts$/.test(f)
      || f === "src/services/project-content-search.service.ts");
    expect(bad).toEqual([]);
  });
});
