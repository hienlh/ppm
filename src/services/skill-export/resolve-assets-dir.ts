// Resolve the bundled skill assets dir. Works both in dev (`bun src/index.ts`)
// and installed npm package. Throws a clear error if assets are missing.
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

const ASSETS_REL = "assets/skills/ppm";

/**
 * Walks up from this file to find the repo/package root that contains
 * `assets/skills/ppm/SKILL.md`. Covers both:
 *   - dev:     src/services/skill-export/*.ts      → repo root is ../../..
 *   - bundled: compiled binary walks up similarly when `bun build --compile` preserves structure
 */
export function resolveAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../..", ASSETS_REL),
    resolve(here, "../..", ASSETS_REL),
    resolve(here, "..", ASSETS_REL),
    resolve(process.cwd(), ASSETS_REL),
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, "SKILL.md"))) return c;
  }
  throw new Error(
    `Bundled PPM skill assets not found. Searched:\n  ${candidates.join(
      "\n  ",
    )}\nRun \`bun run generate:skill\` (dev) or reinstall PPM.`,
  );
}
