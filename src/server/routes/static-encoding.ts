/**
 * Choosing which precompressed copy of an asset to send.
 *
 * `scripts/precompress-web.ts` writes `<file>.br` and `<file>.gz` beside each
 * text asset at build time. This decides which one a given request gets, and
 * deliberately treats a missing variant as "send the original" — so a build
 * that skipped the compression step still serves a working site, just with the
 * bytes PPM sent before any of this existed.
 */

export type ContentEncoding = "br" | "gzip";

export interface ChosenVariant {
  /** The file to send. The original when no variant applies. */
  path: string;
  /** What to declare in `Content-Encoding`, or null when sending the original. */
  encoding: ContentEncoding | null;
}

/** Extension for each encoding, matching what the build writes. */
const EXTENSION: Record<ContentEncoding, string> = { br: ".br", gzip: ".gz" };

/**
 * Which encodings a client will accept, best first.
 *
 * `q=0` means *refuses* rather than "no preference", so it has to be honoured —
 * a client that sends `gzip;q=0` and receives gzip cannot read the response.
 * Beyond that the order here is PPM's preference, not the client's: brotli is
 * ~20% smaller than gzip on this bundle and every browser that sends `br`
 * handles it.
 */
export function acceptedEncodings(header: string | undefined): ContentEncoding[] {
  if (!header) return [];
  const refused = new Set<string>();
  const offered = new Set<string>();

  for (const part of header.split(",")) {
    const [rawToken, ...params] = part.split(";");
    const token = rawToken?.trim().toLowerCase();
    if (!token) continue;
    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) refused.add(token);
    else offered.add(token);
  }

  return (["br", "gzip"] as const).filter(
    // `*` stands in for anything not named, which is how a client says "any".
    (e) => !refused.has(e) && (offered.has(e) || (offered.has("*") && !refused.has("*"))),
  );
}

/**
 * The variant to send for `filePath`.
 *
 * `exists` is injected so this stays a pure decision — the caller owns the
 * filesystem, and the tests do not need one.
 */
export function chooseVariant(
  filePath: string,
  acceptEncoding: string | undefined,
  exists: (path: string) => boolean,
): ChosenVariant {
  // A request for the variant itself is not a request to encode it again.
  if (filePath.endsWith(".br") || filePath.endsWith(".gz")) {
    return { path: filePath, encoding: null };
  }

  for (const encoding of acceptedEncodings(acceptEncoding)) {
    const candidate = filePath + EXTENSION[encoding];
    if (exists(candidate)) return { path: candidate, encoding };
  }
  return { path: filePath, encoding: null };
}
