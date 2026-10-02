import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileIndexWorkerSpec } from "../../../src/services/file-index/file-index-runner.ts";
import { extensionHostWorkerSpec } from "../../../src/services/extension.service.ts";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** The entry points of every `bun build … --compile` in `text`: the words before the first flag. */
function compileEntries(text: string): string[][] {
  const joined = text.replace(/\\\r?\n/g, " "); // shell line continuations
  return [...joined.matchAll(/bun build ((?:[^\s-]\S*\s+)+)--compile/g)].map((m) => m[1]!.trim().split(/\s+/));
}

const buildScript = JSON.parse(read("package.json")).scripts.build as string;
const [buildEntries] = compileEntries(buildScript);

describe("compiled binary entry points", () => {
  it("the build script compiles every worker the server starts", () => {
    // A Worker is in a compiled binary only if it is an entry point, and its compiled spec is
    // relative to the main entry's directory (`src/`), so the spec names the entry it needs.
    expect(buildEntries).toBeDefined();
    expect(buildEntries![0]).toBe("src/index.ts");
    for (const spec of [fileIndexWorkerSpec(true), extensionHostWorkerSpec(true)]) {
      expect(buildEntries).toContain(join("src", spec).split("\\").join("/"));
    }
  });

  // The release binaries are built by these two, not by `bun run build`. A worker missing here
  // fails only at runtime in the shipped binary: the file index falls back to the main thread
  // and the extension host never starts.
  it.each(["scripts/release.sh", ".github/workflows/release.yml"])("%s compiles the same entry points as the build script", (path) => {
    const commands = compileEntries(read(path));
    expect(commands.length).toBeGreaterThan(0);
    for (const entries of commands) expect(entries).toEqual(buildEntries!);
  });
});
