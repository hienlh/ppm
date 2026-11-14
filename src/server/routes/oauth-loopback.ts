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
import { normalizeLoopbackCallback } from "../../shared/loopback-callback-url.ts";

export const loopbackRoutes = new Hono();

/** A stalled CLI answers instantly; anything slower is not the listener we want. */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 2000;
/** A callback with its code is a few hundred characters; this is far past any real one. */
const MAX_URL_CHARS = 8192;

/**
 * POST /api/loopback/callback — { url } → GET that URL from this machine.
 *
 * The URL is cleaned up the way the browser's field cleans it (no scheme on a
 * phone's copy, quotes and stray punctuation around it) and then held to the
 * loopback rule here, on the server, whatever the browser decided: this is the
 * one place a request actually leaves PPM.
 *
 * Redirects are not followed: the callback's whole purpose is to hand the code
 * to the listener, and a redirect would point somewhere this endpoint has not
 * vetted.
 */
loopbackRoutes.post("/callback", async (c) => {
  let raw: unknown;
  try {
    raw = (await c.req.json<{ url?: unknown }>()).url;
  } catch {
    return c.json(err("Not a valid URL"), 400);
  }
  if (typeof raw !== "string" || !raw.trim()) return c.json(err("Missing required field: url"), 400);
  if (raw.length > MAX_URL_CHARS) return c.json(err("That address is too long to be a login callback"), 400);

  const checked = normalizeLoopbackCallback(raw);
  if (!checked.ok) return c.json(err(checked.reason), 400);
  const target = new URL(checked.url);

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
      ? `Nothing answered on port ${target.port || (target.protocol === "https:" ? "443" : "80")} within ${FETCH_TIMEOUT_MS / 1000}s`
      : `Could not reach ${target.host} — the login may have already timed out`;
    return c.json(err(reason), 502);
  }
});
