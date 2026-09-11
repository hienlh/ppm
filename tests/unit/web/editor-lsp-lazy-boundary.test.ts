/**
 * The language service must stay behind a dynamic import.
 *
 * The saving is not only the ~18 KB of client, providers and conversions that
 * a session which never turns it on no longer downloads. It is that the code
 * which asks the host for a server is unreachable until the setting is on, so
 * no server process exists — one `typescript-language-server` on one project
 * was 854 MB resident.
 *
 * A single `import { something } from "@/hooks/use-lsp"` anywhere on the
 * editor's static path silently undoes all of it: the bundle merges the chunk
 * back in and nothing about the UI looks different. Hence this test rather than
 * a comment.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = "src/web";
const EDITOR = `${WEB}/components/editor`;

/** Modules that pull in the LSP client, its providers or the WebSocket. */
function isLspModule(specifier: string): boolean {
  return /hooks\/use-lsp$|lib\/lsp\//.test(specifier);
}

/**
 * The one LSP module that is safe to import statically: it unregisters
 * Monaco's bundled TypeScript service, has no imports of its own, and has to
 * run whether or not a server is coming.
 */
const STATIC_EXCEPTION = "@/lib/lsp/monaco-builtin-typescript";

/** Files allowed to reach the LSP code directly, being the lazy side of the boundary. */
const INSIDE = [
  `${WEB}/hooks/use-lsp.ts`,
  `${EDITOR}/editor-language-service.tsx`,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

interface StaticImport { file: string; specifier: string }

/** Static imports that survive compilation — `import type` is erased, `import(...)` is deferred. */
function runtimeImports(files: string[]): StaticImport[] {
  const found: StaticImport[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
      if (match[1]) continue; // `import type` — erased
      found.push({ file, specifier: match[3]! });
    }
  }
  return found;
}

describe("the editor's LSP boundary", () => {
  const files = sourceFiles(WEB).filter((f) => !f.startsWith(`${WEB}/lib/lsp/`) && !INSIDE.includes(f));

  it("is crossed statically by nothing but the built-in-TypeScript switch", () => {
    const offenders = runtimeImports(files)
      .filter((i) => isLspModule(i.specifier) && i.specifier !== STATIC_EXCEPTION)
      .map((i) => `${i.file} imports ${i.specifier}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the statically-imported exception free of imports of its own", () => {
    const source = readFileSync(`${WEB}/lib/lsp/monaco-builtin-typescript.ts`, "utf8");
    expect(runtimeImports([`${WEB}/lib/lsp/monaco-builtin-typescript.ts`])).toEqual([]);
    // Not even a type import, so it can never grow one by accident.
    expect(/^import /m.test(source)).toBe(false);
  });

  it("has the editor mount the service through lazy() and nothing else", () => {
    const source = readFileSync(`${EDITOR}/code-editor.tsx`, "utf8");
    expect(source).toContain('lazy(() =>\n  import("./editor-language-service")');
    // A static import of even a constant from that module would defeat it.
    expect(runtimeImports([`${EDITOR}/code-editor.tsx`]).map((i) => i.specifier))
      .not.toContain("./editor-language-service");
  });

  it("notifies a save through a dynamic import, not the client itself", () => {
    const source = readFileSync(`${EDITOR}/code-editor.tsx`, "utf8");
    expect(source).toContain('import("@/hooks/use-lsp").then((m) => m.notifyLspSave(');
  });
});
