/**
 * One raw NUL byte makes git call a whole source file binary.
 *
 * `packages/ext-git-graph/src/panel-registry.ts` used a literal NUL as the
 * separator in a composite map key. It worked — and `git diff --numstat`
 * answered `- -` for that file from then on, so every change to it rendered as
 * "Binary files a/… and b/… differ" in `git log -p`, in a pull request, and in
 * PPM's own diff views. The file was still there and still correct; it had just
 * stopped being reviewable, which nothing reports.
 *
 * Writing the separator as an escape is the same value at runtime and costs
 * nothing.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const ROOTS = ["src", "packages", "scripts", "tests"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js|jsx|css|json|md)$/.test(name)) out.push(path);
  }
  return out;
}

describe("source files stay text", () => {
  test("no checked-in source file contains a NUL byte", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const at = readFileSync(file).indexOf(0);
        if (at !== -1) offenders.push(`${relative(ROOT, file)} (offset ${at})`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
