/**
 * Stage Monaco next to the built frontend, so PPM serves it itself.
 *
 * The editor was loaded from `cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs`:
 * `@monaco-editor/react` falls back to that CDN unless its loader is told
 * otherwise, and nothing told it. A self-hosted tool that cannot open a file
 * without the public internet is broken on a plane, on an air-gapped LAN, and
 * on any network that blocks the CDN — and it was also PPM's only third-party
 * runtime dependency for a core feature.
 *
 * Copied under `assets/` on purpose: `static.ts` serves that prefix
 * `immutable`, the service worker caches it on first use, and
 * `precompress-web.ts` gives it brotli siblings — all three of which this gets
 * for free by living there rather than in a directory of its own.
 *
 * One thing is left behind: `nls.messages.<locale>.js`, 1.7 MB across 14
 * languages. Monaco fetches one only when the loader is given a locale, and PPM
 * never sets one.
 *
 * `assets/ts.worker-*.js` used to be left behind too — 6.7 MB, the largest
 * single file in the package — on the grounds that
 * `monaco-builtin-typescript.ts` unregistered every provider of Monaco's
 * TypeScript service, so nothing could ever ask for it. That is now only true
 * while a real language server is coming. With the setting off, which is the
 * default and the only state a phone has, that worker is the thing answering
 * completions and hovers, and dropping it was the difference between a fallback
 * and nothing at all. It costs 1.2 MB brotli over the wire, fetched once, on
 * first use, by the machines that have no other answer.
 *
 * The other `assets/*.worker-*.js` files stay, and the reason they nearly did
 * not is instructive: `MonacoEnvironment.getWorkerUrl` mapped worker labels to
 * a separate `/monacoeditorwork/` build, which made these copies look
 * redundant. They are not — this is the AMD build, and it loads its workers
 * from `vs/assets/` without consulting that map at all. Dropping them did not
 * fail loudly either: Monaco warned once and ran the worker on the main thread,
 * which is a UI freeze rather than an error.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
// Shared with the dev server, which serves the same files from `node_modules` — see
// `monaco-staging.ts` for why the exclusion list cannot live in only one of the two.
import { MONACO_VS as SOURCE, isUnused } from "./monaco-staging.ts";

const TARGET = resolve(import.meta.dir, "../dist/web/assets/monaco/vs");

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
cpSync(SOURCE, TARGET, {
  recursive: true,
  filter: (source) => !isUnused(source),
});

function totalBytes(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    bytes += entry.isDirectory() ? totalBytes(path) : statSync(path).size;
  }
  return bytes;
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
console.log(`monaco       staged ${mb(totalBytes(TARGET))} (from ${mb(totalBytes(SOURCE))} on disk)`);
