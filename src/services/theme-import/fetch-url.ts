import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-hardened fetch for theme import. Only https, only public IPs, bounded
 * redirects/size/time. Every hop's host is DNS-resolved and checked against
 * private/link-local/loopback ranges before the request is made.
 *
 * Residual risk (accepted): DNS-rebinding TOCTOU — `fetch` re-resolves DNS
 * independently of our pre-check, so a hostile resolver could return a public
 * IP to the check and a private IP to `fetch`. A full fix needs IP-pinned TLS
 * (node:https with a fixed `lookup`), a larger change. Accepted because this is
 * an authenticated single-user IDE where the user supplies the URL themselves;
 * revisit if the import surface is ever exposed to untrusted callers.
 */

const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15_000;

export interface FetchLimits {
  /** Max bytes to read from the body before aborting. */
  maxBytes: number;
}

/** True if an IPv4/IPv6 literal is in a private, loopback, or link-local range. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // 127.0.0.0/8 loopback
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                       // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;          // loopback / unspecified
    if (lower.startsWith("fe80")) return true;                   // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — extract and recheck as v4
    const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m && m[1]) return isBlockedIp(m[1]);
    return false;
  }
  // Not a literal IP → treat as blocked (caller resolves DNS first)
  return true;
}

async function assertHostAllowed(hostname: string): Promise<void> {
  // If hostname is already an IP literal, check directly.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error("Blocked IP address");
    return;
  }
  const results = await lookup(hostname, { all: true });
  if (results.length === 0) throw new Error("DNS resolution failed");
  for (const r of results) {
    if (isBlockedIp(r.address)) throw new Error("Host resolves to a blocked IP");
  }
}

function assertHttps(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  return parsed;
}

export interface FetchResult {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

/**
 * Fetch a URL with SSRF protection. Manually follows up to MAX_REDIRECTS hops,
 * re-validating the host each time, and aborts if the body exceeds maxBytes.
 */
export async function safeFetch(url: string, limits: FetchLimits): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    let current = assertHttps(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertHostAllowed(current.hostname);
      const res = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "PPM-ThemeImport/1" },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("Redirect without location");
        if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
        current = assertHttps(new URL(loc, current).toString());
        continue;
      }
      if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") ?? "";
      const bytes = await readCapped(res, limits.maxBytes);
      return { bytes, contentType, finalUrl: current.toString() };
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body, aborting if it exceeds maxBytes. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error("Response exceeds size limit");
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeds size limit");
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}
