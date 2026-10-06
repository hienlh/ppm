/**
 * The address a web-preview tab may load, or null.
 *
 * Only http(s), and never PPM's own origin. The tab's metadata is persisted and restored,
 * and the frame keeps `allow-same-origin` so the forwarded app has its own cookies and
 * storage. That is safe only while the frame is cross-origin to PPM: given a `javascript:`
 * URL, or PPM's own origin, the same frame could read the session token out of PPM's
 * localStorage.
 */
export function safePreviewUrl(value: unknown, appOrigin: string): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.origin === appOrigin) return null;
  return url.href;
}

/** The tab's title: the dev server as the host knows it. */
export function previewTitle(port: number | null | undefined, url: string): string {
  if (port) return `localhost:${port}`;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
