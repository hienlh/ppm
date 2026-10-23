/**
 * The share host's request handler: the review pages, and nothing else of PPM.
 *
 * A request is forwarded to the PPM server on loopback only when its path is part of the
 * reviewer surface: `/s` and everything under it (the page, its info, the pinned design's files
 * and the comment threads, see `design-share-guest*.ts`) and the review page's own build,
 * `/assets/share-*`. Every other path — the IDE, `/api`, sign-in, WebSockets, the app shell —
 * is answered here with a 404 and never reaches PPM, so a public share host is not a public
 * PPM. The decision is made on the parsed URL, whose dot segments are already resolved, and the
 * same parsed path is what gets forwarded, so PPM cannot route anything other than what was
 * checked.
 *
 * What is forwarded:
 * - `Host`, untouched: the design files' CSP is built from it, and the rate limiter believes
 *   `CF-Connecting-IP` only for the public hostnames it knows (`design-share-client-key.ts`).
 * - Never `Authorization` or `Cookie`: nothing on the reviewer surface reads them, and a
 *   credential from the internet has no business reaching PPM.
 * - Bodies as they are, compressed ones included (`decompress: false`), so a `.br` asset is
 *   not inflated under a `Content-Encoding: br` header.
 */

/** The reviewer surface's paths, decided on an already-parsed pathname. */
export function isShareHostPath(pathname: string): boolean {
  if (pathname === "/s" || pathname.startsWith("/s/")) return true;
  // The review page's own Vite build (`vite.share.config.ts`): `assets/share-[hash][ext]`.
  return /^\/assets\/share-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)+$/.test(pathname);
}

const ASSET_METHODS = new Set(["GET", "HEAD"]);
/** What the `/s` routes answer to: reads, and the reviewer's comment writes. */
const SHARE_METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "DELETE"]);

/** Request headers that describe this hop, or carry a credential, and stop here. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "authorization", "cookie", "content-length", "expect",
]);
/** Response headers that describe the hop from PPM, not the one to the browser. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

/** A reviewer write is at most 16 KB (`GUEST_WRITE_MAX_BYTES`); anything near this is not one. */
export const MAX_FORWARDED_BODY_BYTES = 64 * 1024;
/** How long a request waits for PPM to come back while it restarts. */
const CONNECT_WINDOW_MS = 5000;
const CONNECT_RETRY_MS = 250;
/** No reviewer request takes this long; a hung one is cut off rather than held open. */
const UPSTREAM_TIMEOUT_MS = 60_000;

export interface ShareHostGatewayDeps {
  /** PPM's loopback port now (`.server-port`), or null while it is not up. */
  targetPort: () => number | null;
  /** Forget a cached port after a failed connect, so the next try reads it again. */
  resetTargetPort?: () => void;
  fetch?: typeof fetch;
  connectWindowMs?: number;
  timeoutMs?: number;
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

function page(status: number, title: string, text: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#333}@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style></head><body><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;
  return new Response(body, { status, headers: PAGE_HEADERS });
}

export const notFoundPage = () => page(404, "Not found", "There is nothing at this address.");
const unavailablePage = () => {
  const res = page(503, "Temporarily unavailable", "This review page cannot be reached right now. Try again in a moment.");
  res.headers.set("Retry-After", "5");
  return res;
};
const timeoutPage = () => page(504, "Took too long", "This review page did not answer in time. Try again in a moment.");
const tooLargePage = () => page(413, "Too large", "That request is larger than a review page accepts.");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for the error a refused or reset connection raises, as opposed to a timeout. */
function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ConnectionRefused" || code === "ECONNREFUSED" || code === "ConnectionClosed" || code === "ECONNRESET";
}

export function createShareHostHandler(deps: ShareHostGatewayDeps): (req: Request) => Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const connectWindowMs = deps.connectWindowMs ?? CONNECT_WINDOW_MS;
  const timeoutMs = deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!isShareHostPath(url.pathname)) return notFoundPage();
    const isAsset = url.pathname.startsWith("/assets/");
    if (!(isAsset ? ASSET_METHODS : SHARE_METHODS).has(req.method)) return notFoundPage();

    const headers = new Headers();
    req.headers.forEach((value, name) => {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });

    let body: ArrayBuffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_FORWARDED_BODY_BYTES) return tooLargePage();
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_FORWARDED_BODY_BYTES) return tooLargePage();
    }

    const deadline = Date.now() + connectWindowMs;
    for (;;) {
      const port = deps.targetPort();
      if (port !== null) {
        try {
          const upstream = await doFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            body,
            redirect: "manual",
            decompress: false,
            signal: AbortSignal.timeout(timeoutMs),
          } as RequestInit);
          const out = new Headers();
          upstream.headers.forEach((value, name) => {
            if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out.append(name, value);
          });
          const noBody = req.method === "HEAD" || upstream.status === 204 || upstream.status === 304;
          return new Response(noBody ? null : upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: out,
          });
        } catch (error) {
          if ((error as { name?: unknown })?.name === "TimeoutError") return timeoutPage();
          if (!isConnectFailure(error)) return unavailablePage();
          // PPM is restarting, or moved to another port: read the port again and retry.
          deps.resetTargetPort?.();
        }
      }
      if (Date.now() >= deadline) return unavailablePage();
      await sleep(CONNECT_RETRY_MS);
    }
  };
}
