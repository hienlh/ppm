/**
 * Delivers an OAuth loopback callback to the CLI waiting on this machine.
 *
 * Tools like `aws sso login`, `gcloud auth login` and `gh auth login` listen on
 * 127.0.0.1:<port> and print an authorization URL. Signing in from a phone sends
 * the browser's redirect to the *phone's* loopback address, so the CLI never
 * hears back and blocks forever — and it cannot be finished by typing into the
 * terminal either, because the CLI is holding it open waiting.
 *
 * This server runs on the same machine as the CLI, so it can make the request
 * the phone cannot. Restricted to loopback addresses: it exists to reach a
 * process on this host, and must not become a way to probe the wider network.
 */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";

export const loopbackRoutes = new Hono();

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);
/** A stalled CLI answers instantly; anything slower is not the listener we want. */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 2000;

/** Whether a hostname addresses this machine. Covers all of 127.0.0.0/8. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * POST /api/loopback/callback — { url } → GET that URL from this machine.
 *
 * Redirects are not followed: the callback's whole purpose is to hand the code
 * to the listener, and a redirect would point somewhere this endpoint has not
 * vetted.
 */
loopbackRoutes.post("/callback", async (c) => {
  let target: URL;
  try {
    const body = await c.req.json<{ url?: string }>();
    if (!body.url) return c.json(err("Missing required field: url"), 400);
    target = new URL(body.url);
  } catch {
    return c.json(err("Not a valid URL"), 400);
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return c.json(err(`Unsupported protocol: ${target.protocol}`), 400);
  }
  if (!isLoopbackHostname(target.hostname)) {
    return c.json(
      err(`Only loopback addresses are allowed, got "${target.hostname}"`),
      400,
    );
  }

  try {
    const res = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return c.json(
      ok({ status: res.status, body: text.slice(0, MAX_BODY_CHARS) }),
    );
  } catch (e) {
    // Nothing listening is the common case — the CLI already gave up, or the
    // port in the URL belongs to an older attempt.
    const reason = (e as Error).name === "TimeoutError"
      ? `Nothing answered on port ${target.port} within ${FETCH_TIMEOUT_MS / 1000}s`
      : `Could not reach ${target.host} — the login may have already timed out`;
    return c.json(err(reason), 502);
  }
});
