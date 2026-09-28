import { DESIGN_CDN_HOSTS } from "../../../shared/design-cdn-hosts.ts";

/**
 * The Content-Security-Policy every design document is served under.
 *
 * `source` is the capability's own prefix (`host/api/design-preview/content/<token>/`),
 * scheme-less so it follows the document's real scheme through a tunnel. The boundary this
 * policy draws is `connect-src`: only the design's own files, never a CDN and never `*`,
 * because `fetch`/XHR/WebSocket are how a page would send data somewhere. `'unsafe-eval'` is
 * allowed on purpose — `'unsafe-inline'` already runs any code written into the file, and
 * common CDN setups (Alpine, Vue in-DOM templates, Babel standalone) need eval.
 *
 * `allowModals` is for the print view only, which needs `print()`; a canvas never gets it.
 */
export function buildDesignCsp(source: string, opts: { allowModals?: boolean } = {}): string {
  const cdns = DESIGN_CDN_HOSTS.map((host) => `https://${host}`).join(" ");
  return [
    opts.allowModals ? "sandbox allow-scripts allow-modals" : "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${source} ${cdns}`,
    `style-src 'unsafe-inline' ${source} ${cdns}`,
    `font-src ${source} data: ${cdns}`,
    `img-src ${source} data: blob: ${cdns}`,
    `media-src ${source} blob:`,
    `connect-src ${source}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "object-src 'none'",
  ].join("; ");
}
