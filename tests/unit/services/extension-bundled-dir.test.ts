import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { bundledExtensionsDir } from "../../../src/services/extension.service.ts";

/**
 * Bundled `packages/ext-*` extensions are loaded as source from disk, so they sit beside the
 * install rather than inside the executable. A compiled binary reports `/$bunfs/root` for
 * `import.meta.dir` — its embedded filesystem — so walking up two levels lands on `/packages`,
 * an absolute path at the filesystem root. Discovery found nothing there and said so in no way
 * at all: no error, no log, just an empty extensions panel.
 *
 * The parameters exist so this can be checked: `import.meta.dir` cannot be faked from a test,
 * and under `bun test` it always has a real on-disk value, so a plain call exercises only the
 * source path.
 */
describe("bundledExtensionsDir", () => {
  test("uses the source tree when the relative walk lands on a real directory", () => {
    const moduleDir = resolve(import.meta.dir, "../../../src/services");
    expect(bundledExtensionsDir(moduleDir, "/anything/ppm")).toBe(
      resolve(import.meta.dir, "../../../packages"),
    );
  });

  test("falls back to the executable's directory when compiled", () => {
    // What a compiled binary actually reports — verified against `bun build --compile`.
    expect(bundledExtensionsDir("/$bunfs/root", "/opt/ppm/dist/ppm")).toBe("/opt/ppm/packages");
  });

  test("does not resolve to the filesystem root, which is what the bug produced", () => {
    expect(bundledExtensionsDir("/$bunfs/root", "/opt/ppm/dist/ppm")).not.toBe("/packages");
  });
});
