/**
 * The memory host (`ppm __memory__`) must never reach the database or the config: `getDb()` opens
 * the real `ppm.db` for whoever asks first, and the host is a second process beside the server.
 * The server-side client must not reach the memory code that reads files, the index or an
 * embedder either: there is no fallback that runs memory work on the server's main thread.
 *
 * The transitive graph of relative imports (static and dynamic; `import type` is erased).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const rel = (abs: string) => relative(ROOT, abs).replace(/\\/g, "/");
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) return; // JSON, CSS, text assets: no imports
    const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!path.startsWith(".")) continue;
      const target = resolveImport(file, path);
      if (target) walk(target);
    }
  };
  walk(resolve(ROOT, entry));
  return new Set([...seen].map(rel));
}

describe("memory host import graph", () => {
  it("memory-host.ts reaches no database or config module", () => {
    const graph = importGraph("src/services/memory/memory-host.ts");
    expect(graph.has("src/services/memory/memory-sync.ts")).toBe(true);
    expect(graph.has("src/services/tab-tools-mcp/memory-tools.ts")).toBe(true);
    const bad = [...graph].filter((f) =>
      /(^|\/)(db\.service|config\.service|codex-account\.service)\.ts$/.test(f)
      || (f.startsWith("src/services/db-") && !f.startsWith("src/services/db-backup/db-backup-paths")));
    expect(bad).toEqual([]);
  });

  it("the server-side client never imports the memory work itself (no fallback)", () => {
    const graph = importGraph("src/services/memory/memory-host-client.ts");
    const bad = [...graph].filter((f) =>
      /memory\/(memory-host|memory-sync|memory-index|memory-store|memory-search|memory-context|memory-runtime|import-[a-z]+)\.ts$/.test(f)
      || /memory\/embedding\/(embed-queue|local-embedder|api-embedder)\.ts$/.test(f)
      || f === "src/services/tab-tools-mcp/memory-tools.ts");
    expect(bad).toEqual([]);
  });

  it("the chat service and the tool endpoint reach memory only through the client", () => {
    for (const entry of ["src/services/chat.service.ts", "src/services/tab-tools-mcp/tab-tools-mcp-endpoint.ts", "src/server/routes/memory.ts"]) {
      const graph = importGraph(entry);
      // `memory-settings.ts` (the on/off switch) still names the embedder classes; nothing here runs one.
      const bad = [...graph].filter((f) => /memory\/(memory-host|memory-sync|memory-store|memory-search|memory-context|memory-runtime)\.ts$/.test(f)
        || /memory\/embedding\/embed-queue\.ts$/.test(f));
      expect({ entry, bad }).toEqual({ entry, bad: [] });
    }
  });
});
