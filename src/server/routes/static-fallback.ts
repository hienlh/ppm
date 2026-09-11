/**
 * Whether a request for a file that is not on disk should be answered with the
 * app shell, or with a 404.
 *
 * Getting this wrong in one direction is the white screen. An upgrade replaces
 * `dist/web` and Vite's `emptyOutDir` deletes the previous content hashes, so a
 * tab that has been open across the upgrade asks for a lazy chunk that is gone.
 * Answered with `index.html` at `200 text/html`, the browser refuses the module
 * on its strict MIME check, the `import()` rejects, `React.lazy` throws, and
 * React unmounts the whole tree — `#root` empties and the page shows nothing but
 * the body's background. The service worker then made it permanent by caching
 * that HTML under the chunk's own URL.
 *
 * Getting it wrong in the other direction breaks every deep link and every
 * reload, so the rule has to be narrow. It cannot be written on the path's
 * shape: PPM's routes embed file paths, so `/project/x/editor/src/main.js` is a
 * navigation whose extension is `.js`.
 *
 * `Sec-Fetch-Dest` states the request's intent exactly and is the primary test.
 * Browsers omit the Fetch Metadata headers on an insecure origin, though, and
 * PPM is routinely reached over plain HTTP on a LAN — so the two directories
 * that only ever hold build output are checked as well. No app route lives
 * under either.
 */

/** Directories that hold build output and nothing else. */
const ASSET_ROOTS = ["/assets/", "/monacoeditorwork/"];

/**
 * `document` is a navigation. `empty` is `fetch`/XHR, which is left in the
 * navigation bucket deliberately: an API path that falls through to here has
 * always been answered with the shell, and narrowing that is a separate
 * question from this bug. Everything else — `script`, `style`, `worker`,
 * `font`, `image`, `serviceworker` — is a subresource, and a subresource is
 * never satisfied by HTML.
 */
const NAVIGATION_DESTS = new Set(["document", "empty"]);

export function shouldServeAppShell(urlPath: string, secFetchDest: string | undefined): boolean {
  if (secFetchDest !== undefined && !NAVIGATION_DESTS.has(secFetchDest)) return false;
  return !ASSET_ROOTS.some((root) => urlPath.startsWith(root));
}
