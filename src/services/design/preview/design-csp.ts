import { DESIGN_CDN_HOSTS } from "../../../shared/design-cdn-hosts.ts";

/**
 * The Content-Security-Policy every design document is served under.
 *
 * `source` is the capability's own prefix (`host/api/design-preview/content/<token>/`), written
 * out under both `https://` and `http://` because behind a tunnel the browser's scheme is not
 * the one the request reached PPM on. It must not go out scheme-less: that takes its scheme
 * from the document's origin, which WebKit reads off the sandboxed frame's opaque origin, so
 * it matches nothing there — WebKit 26.4 and 26.5 refused every file of the page, and 26.6
 * still refuses the page's `fetch` of its own files. The boundary this policy draws is
 * `connect-src`: only the design's own files, never a CDN and never `*`, because
 * `fetch`/XHR/WebSocket are how a page would send data somewhere. `'unsafe-eval'` is
 * allowed on purpose — `'unsafe-inline'` already runs any code written into the file, and
 * common CDN setups (Alpine, Vue in-DOM templates, Babel standalone) need eval.
 *
 * `allowModals` is for the print view only, which needs `print()`; a canvas never gets it.
 */
export function buildDesignCsp(source: string, opts: { allowModals?: boolean } = {}): string {
  const own = `https://${source} http://${source}`;
  const cdns = DESIGN_CDN_HOSTS.map((host) => `https://${host}`).join(" ");
  return [
    opts.allowModals ? "sandbox allow-scripts allow-modals" : "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${own} ${cdns}`,
    `style-src 'unsafe-inline' ${own} ${cdns}`,
    `font-src ${own} data: ${cdns}`,
    `img-src ${own} data: blob: ${cdns}`,
    `media-src ${own} blob:`,
    `connect-src ${own}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "object-src 'none'",
  ].join("; ");
}
