import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extensionHostWorkerSpec } from "../../../src/services/extension.service.ts";

/**
 * How the extension host worker is named decides whether extensions run at all, and the two
 * modes need different spellings. The parameter exists because `bun test` always runs under
 * bun: `isCompiledBinary()` is false here, so a plain call never reaches the compiled branch.
 */
describe("extensionHostWorkerSpec", () => {
  test("compiled: resolves against the build's main entry directory, not this module", () => {
    // `src/index.ts` is the entry, so the embedded graph names the worker `./services/...`.
    // Every other spelling was refused by Bun: `./extension-host-worker.ts`,
    // `src/services/extension-host-worker.ts`, and the `/$bunfs/root/...` URL.
    expect(extensionHostWorkerSpec(true)).toBe("./services/extension-host-worker.ts");
  });

  test("compiled: never a $bunfs URL — Bun refuses a worker entry point there", () => {
    expect(extensionHostWorkerSpec(true)).not.toContain("$bunfs");
    expect(extensionHostWorkerSpec(true)).not.toStartWith("file:");
  });

  test("from source: anchored to this module, so the service's cwd cannot break it", () => {
    // The service runs with WorkingDirectory=~/.ppm; a relative specifier would resolve there.
    const spec = extensionHostWorkerSpec(false);
    expect(spec).toStartWith("file://");
    expect(spec).toEndWith("/src/services/extension-host-worker.ts");
  });

  test("the worker is a second entry point of the compiled build", () => {
    // The specifier above only resolves because the worker is compiled into the binary. A
    // worker reached only through `new URL` is not pulled in, and the fix silently reverts.
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../package.json"), "utf8"));
    expect(pkg.scripts.build).toContain("src/services/extension-host-worker.ts");
  });
});
