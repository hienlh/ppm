/**
 * Precompress the built frontend, so the server can send bytes instead of
 * compressing them on every request.
 *
 * PPM served its assets raw: a 2.6 MB chunk transferred 2.74 MB. The whole
 * bundle is 15.8 MB raw and 3.7 MB gzipped, so most of what a phone downloaded
 * on a cold load was compressible text nobody was compressing.
 *
 * Done at build time rather than per request because the files never change
 * after a build — the alternative is spending CPU on every asset fetch to
 * produce the same bytes. That also makes brotli quality 11 affordable: it is
 * ~20x slower than quality 9 for ~10% fewer bytes, which is a bad trade per
 * request and a good one when a release is built once and downloaded many
 * times.
 *
 * `static.ts` picks a variant from `Accept-Encoding`; a missing variant is
 * simply the original, so this step failing degrades to today's behaviour.
 */
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const DIST = resolve(import.meta.dir, "../dist/web");

/** Text formats worth compressing. Anything already compressed is skipped. */
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".json", ".svg", ".webmanifest", ".map", ".txt"]);

/**
 * Below this, a variant is not worth a separate file: the ratio is poor on tiny
 * inputs and the response is a single packet either way.
 */
const MIN_BYTES = 1024;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

let raw = 0;
let brotli = 0;
let gzip = 0;
let count = 0;

for (const path of walk(DIST)) {
  if (!COMPRESSIBLE.has(extname(path).toLowerCase())) continue;
  const size = statSync(path).size;
  if (size < MIN_BYTES) continue;

  const source = readFileSync(path);
  const br = brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      // Lets brotli size its window to the input instead of guessing.
      [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  const gz = gzipSync(source, { level: 9 });

  // Only keep a variant that actually wins; otherwise the server would serve
  // more bytes than the original and claim it was an optimisation.
  if (br.length < size) writeFileSync(`${path}.br`, br);
  if (gz.length < size) writeFileSync(`${path}.gz`, gz);

  raw += size;
  brotli += Math.min(br.length, size);
  gzip += Math.min(gz.length, size);
  count++;
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
const saved = raw === 0 ? 0 : Math.round(100 - (100 * brotli) / raw);
console.log(
  `precompress  ${count} files  ${mb(raw)} raw  ${mb(gzip)} gzip  ${mb(brotli)} brotli  (${saved}% smaller)`,
);
