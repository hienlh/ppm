/**
 * What the address bar turns typed text into. Only http(s) ever reaches Chrome from here:
 * `file:`, `chrome:`, `devtools:`, `view-source:`, `javascript:`, `data:` and friends are
 * refused, which — with Chrome's own refusal of web pages navigating to `file:` — keeps the
 * host's disk and the browser's internal pages out of reach. Text that is not an address
 * becomes a search.
 */

export const SEARCH_URL = "https://duckduckgo.com/?q=";

export type AddressResult = { ok: true; url: string } | { ok: false; reason: "scheme" | "empty" };

const HTTP = /^https?:\/\//i;
/** `name:` not followed by a digit: a scheme. `localhost:3000` is a host and port, not a scheme. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const HOSTLIKE = /^(localhost|\[[0-9a-f:.]+\]|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?([/?#]\S*)?$/i;
const PRIVATE_HOST = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i;

export function resolveAddress(input: string): AddressResult {
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text === "about:blank") return { ok: true, url: text };
  if (HTTP.test(text)) {
    try {
      return { ok: true, url: new URL(text).href };
    } catch {
      return { ok: true, url: SEARCH_URL + encodeURIComponent(text) };
    }
  }
  if (OTHER_SCHEME.test(text)) return { ok: false, reason: "scheme" };
  if (HOSTLIKE.test(text)) {
    // A home router or dev server rarely has a certificate; a public name almost always does.
    const scheme = PRIVATE_HOST.test(text) ? "http" : "https";
    try {
      return { ok: true, url: new URL(`${scheme}://${text}`).href };
    } catch {}
  }
  return { ok: true, url: SEARCH_URL + encodeURIComponent(text) };
}

/** True for a URL the browser may be told to open (used by tools that take a URL as given). */
export function isNavigableUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
