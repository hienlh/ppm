/**
 * The address a CLI login handed back to the browser, cleaned up and checked.
 *
 * Tools like `aws sso login` listen on 127.0.0.1:<port> and wait for the
 * browser to be redirected there. When the browser is on another device, that
 * redirect lands nowhere, so PPM lets the user paste the address and makes the
 * request from the machine the CLI runs on (`POST /api/loopback/callback`).
 *
 * What gets pasted is rarely clean. A phone's address bar hides the scheme, so
 * copying gives `127.0.0.1:54132/oauth/callback?code=…`; a copy out of a chat
 * or a note brings quotes, brackets, a trailing full stop or a line break with
 * it. This module turns all of that into one URL — and then holds it to the
 * rule that matters: the request may only go to this machine's own loopback
 * addresses. The browser and the server run the same function, so the field's
 * verdict and the server's always agree; the server's is the one that counts.
 */

const LOOPBACK_NAMES = new Set(["localhost", "::1"]);

/** Whether a hostname addresses this machine. Covers all of 127.0.0.0/8, `localhost` and `::1`. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_NAMES.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Whitespace a copy can leave anywhere in a URL — line breaks from wrapping, zero-width marks. */
const ANYWHERE_JUNK = /[\s\u200B-\u200D\u2060\uFEFF]+/g;
/** Quote marks a URL never starts or ends with, straight or typographic. */
const QUOTES = "\"'`\u2018\u2019\u201C\u201D\u00AB\u00BB";
/** Punctuation a sentence leaves after a URL (or a list puts before one). */
const LOOSE_PUNCT = ".,;:!?\u2026";
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const BARE_IPV6 = /^\[[0-9a-f:.]*\]$/i;

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * The pasted text without what came along with the URL: whitespace and line
 * breaks anywhere, and quotes, unmatched brackets and sentence punctuation at
 * either end. A bracket the URL itself needs — the `[` and `]` around an IPv6
 * host — is kept, because it is matched.
 */
export function cleanPastedCallback(raw: string): string {
  let text = raw.replace(ANYWHERE_JUNK, "");
  for (;;) {
    const before = text;
    const first = text[0];
    const last = text[text.length - 1];
    if (first === undefined || last === undefined) return text;

    if (PAIRS[first] && PAIRS[first] === last && text.length > 1 && !BARE_IPV6.test(text)) {
      // `(…)`, `<…>`: wrapped whole. A bare `[::1]` is a host, not a wrapper.
      text = text.slice(1, -1);
    } else {
      if (QUOTES.includes(first) || LOOSE_PUNCT.includes(first)) {
        text = text.slice(1);
      } else if (PAIRS[first] && count(text, first) > count(text, PAIRS[first]!)) {
        text = text.slice(1);
      }
      const end = text[text.length - 1];
      if (end !== undefined && (QUOTES.includes(end) || LOOSE_PUNCT.includes(end))) {
        text = text.slice(0, -1);
      } else if (end !== undefined && CLOSERS[end] && count(text, end) > count(text, CLOSERS[end]!)) {
        text = text.slice(0, -1);
      }
    }
    if (text === before) return text;
  }
}

/** A scheme written out in full: `http://`, `HTTPS://`, `file://`… */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `http:` or `https` with its `//` or its colon mangled: `http:127.0.0.1`, `http:/…`, `http//…`. */
const MANGLED_HTTP = /^(https?)(?::\/{0,2}|\/\/)/i;

export type LoopbackCallbackResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * The URL the server may call for this pasted text, or why it may not.
 *
 * Text without a `scheme://` is read as http — that is what a phone's address
 * bar drops, and the CLI's listener is plain http. The verdict is taken on the
 * URL as WHATWG parses it, the same parse `fetch` makes, so a host that only
 * looks local (`localhost.evil.com`, `127.0.0.1@evil.com`, `evil.com#127.0.0.1`)
 * is judged by the host it really names.
 */
export function normalizeLoopbackCallback(raw: string): LoopbackCallbackResult {
  const cleaned = cleanPastedCallback(raw);
  if (!cleaned) return { ok: false, reason: "Paste the address the sign-in page sent you to" };

  const repaired = HAS_SCHEME.test(cleaned) ? cleaned : cleaned.replace(MANGLED_HTTP, "$1://");
  const withScheme = HAS_SCHEME.test(repaired)
    ? repaired
    : repaired.startsWith("//") ? `http:${repaired}` : `http://${repaired}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "Not a valid address" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Only http addresses can be delivered, not ${url.protocol}` };
  }
  // A name and password in front of the host have no place in a callback, and
  // they are how `127.0.0.1@evil.com` dresses another host up as a local one.
  if (url.username || url.password) {
    return { ok: false, reason: "The address has a user name in front of the host" };
  }
  if (!isLoopbackHostname(url.hostname)) {
    return {
      ok: false,
      reason: `Only this machine's own addresses (localhost, 127.0.0.1, [::1]) are allowed, not "${url.hostname}"`,
    };
  }
  // Port 0 is not a port anything listens on; an out-of-range port fails to parse above.
  if (url.port === "0") return { ok: false, reason: "Port 0 is not a port a login listens on" };

  return { ok: true, url: url.href };
}
