/**
 * Where Monaco's AMD build is, and which of its files PPM does not serve.
 *
 * Shared by the two places that answer for `/assets/monaco/vs`: `copy-monaco.ts`, which stages
 * it into `dist/web` for a real install, and `vite-monaco-dev-assets.ts`, which serves it
 * straight out of `node_modules` under `bun dev:web`. Keeping the exclusions in one place is
 * what stops dev from succeeding on a file production does not ship — a difference that would
 * only ever surface in an installed copy, which is the hardest place to notice it.
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * Monaco's AMD build, as npm installs it.
 *
 * Resolved through the package rather than as `../node_modules/...`: Vite bundles
 * `vite.config.ts` — and everything it imports — into a temporary `.mjs` under `node_modules`
 * before loading it, where `import.meta.dir` is undefined and a path relative to this file
 * points somewhere else entirely.
 */
export const MONACO_VS = dirname(createRequire(import.meta.url).resolve("monaco-editor/min/vs/loader.js"));

/**
 * True for a file this build has no way to request. See `copy-monaco.ts` for the reasoning.
 *
 * `ts.worker-*.js` was on this list and is not any more: Monaco's TypeScript service is now
 * unregistered only while a real language server is coming, so on a machine with no server —
 * the default, and every phone — that worker is what answers completions and hovers.
 */
export function isUnused(path: string): boolean {
  return /[/\\]nls\.messages\.[a-z-]+\.js/.test(path);
}
