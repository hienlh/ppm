/**
 * Letting PPM show a forwarded page that refuses to be framed.
 *
 * Open in a tab puts the forward in an iframe on PPM's origin, so a page sending
 * `X-Frame-Options: SAMEORIGIN` (Rails' default), `DENY` (Django's) or a CSP `frame-ancestors`
 * rendered as a blocked frame. The hop rewrites those headers on the way out so that the origins
 * PPM is open at may frame the page and nobody else gains anything: whatever the page allowed
 * stays allowed, and whatever it refused stays refused for every other site.
 *
 * Only `frame-ancestors` can name an origin (`X-Frame-Options: ALLOW-FROM` is ignored by every
 * current browser), and an enforced `frame-ancestors` makes a browser skip `X-Frame-Options`
 * altogether (HTML, "check a navigation response's adherence to `X-Frame-Options`"). So the
 * header is translated rather than stripped: SAMEORIGIN becomes `frame-ancestors 'self' <PPM>`
 * and DENY becomes `frame-ancestors <PPM>`.
 *
 * The origins come from the browser: a web-preview tab names its own `location.origin` before it
 * loads (`POST /api/tunnels/frame-ancestors`), because the server cannot know every name it is
 * reached by (a LAN address, a tunnel, a reverse proxy). They live in memory, as the hops do.
 */

/** Oldest dropped first. */
const MAX_FRAMERS = 16;
const framers = new Set<string>();

/**
 * `value` as an origin a CSP source list can name, or null: an http(s) origin, exactly as a
 * browser serializes it, whose host is letters, digits, dots and dashes. CSP's grammar has no
 * IPv6 literal, so a PPM opened at `http://[::1]:<port>` cannot be named.
 */
export function cspOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin !== value) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(url.hostname)) return null;
  return value;
}

/** Let the PPM page at `value` frame forwarded pages. The origin as stored, or null if no CSP can name it. */
export function allowFramingFrom(value: unknown): string | null {
  const origin = cspOrigin(value);
  if (!origin) return null;
  framers.delete(origin);
  framers.add(origin);
  for (const old of framers) {
    if (framers.size <= MAX_FRAMERS) break;
    framers.delete(old);
  }
  return origin;
}

/** The origins PPM has been opened at, oldest first. */
export function framingOrigins(): string[] {
  return [...framers];
}

export function forgetFramingOriginsForTest(): void {
  framers.clear();
}

type Restriction = "none" | "self" | "deny";

/** What `X-Frame-Options` asks of a browser, read the way HTML reads it. */
function xfoRestriction(raw: string | null): Restriction {
  if (raw === null) return "none";
  const values = new Set(raw.split(",").map((v) => v.trim().toLowerCase()));
  // Two different values, one of them meaningful, block the frame outright.
  if (values.size > 1) return ["deny", "sameorigin", "allowall"].some((v) => values.has(v)) ? "deny" : "none";
  if (values.has("deny")) return "deny";
  if (values.has("sameorigin")) return "self";
  return "none";
}

/** One policy with `origins` added to its `frame-ancestors`, or null when it has none. */
function extendFrameAncestors(policy: string, origins: readonly string[]): string | null {
  const directives = policy.split(";");
  // A browser obeys the first one and ignores any repeat.
  const at = directives.findIndex((d) => d.trim().split(/\s+/)[0]?.toLowerCase() === "frame-ancestors");
  if (at < 0) return null;
  const [, ...sources] = directives[at]!.trim().split(/\s+/);
  // 'none' must stand alone, so it goes once anything is added.
  const kept = sources.filter((s) => s.toLowerCase() !== "'none'");
  const added = origins.filter((o) => !kept.includes(o));
  directives[at] = `${directives[at]!.match(/^\s*/)![0]}frame-ancestors ${[...kept, ...added].join(" ")}`;
  return directives.join(";");
}

/**
 * Rewrite a response's framing headers so `origins` may frame it. Nothing changes while no
 * origin is known, nor for a page that restricts nothing. `Content-Security-Policy-Report-Only`
 * blocks nothing and is left as it is.
 */
export function letOriginsFrame(headers: Headers, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const restriction = xfoRestriction(headers.get("x-frame-options"));
  headers.delete("x-frame-options");
  let extended = false;
  const csp = headers.get("content-security-policy");
  if (csp !== null) {
    // Each comma-separated policy is enforced on its own, so every one that limits framing must allow PPM.
    const policies = csp.split(",").map((policy) => {
      const next = extendFrameAncestors(policy, origins);
      if (next === null) return policy;
      extended = true;
      return next;
    });
    if (extended) headers.set("content-security-policy", policies.join(","));
  }
  if (extended || restriction === "none") return;
  const sources = restriction === "self" ? ["'self'", ...origins] : [...origins];
  headers.append("content-security-policy", `frame-ancestors ${sources.join(" ")}`);
}
