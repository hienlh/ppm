import { createHash, timingSafeEqual } from "node:crypto";
import { configService } from "./config.service.ts";
import { ppmPasswordLockedText } from "../shared/ppm-password-limit.ts";

/**
 * PPM's password — the auth token a browser logs in with — typed again to approve a write on
 * a database (an AI's `db_execute`, a Query tab run with write access once), before secrets
 * leave the machine (account and connection exports), and to change the password itself.
 *
 * Typing it proves a person is at the screen, because an AI cannot type into PPM's page. It is
 * not a secret the AI lacks: the token sits in `ppm.db`, readable by any process of this OS
 * user, a chat's shell included. That is the trade the user chose over a separate password.
 */

/** Approving asks for the password; PPM run without auth has none to ask for. */
export function ppmPasswordRequired(): boolean {
  const auth = configService.get("auth");
  return !!auth.enabled && !!auth.token;
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Wrong guesses are capped: after `MAX_FAILURES` in a row every check fails for `LOCK_MS`, the
 * right password included, or the cap would only slow a guesser down. One counter for the whole
 * process, not per client: behind the tunnel or the supervisor every client is one address, and
 * there is one password to protect. A right password clears the count.
 */
export const PPM_PASSWORD_MAX_FAILURES = 5;
export const PPM_PASSWORD_LOCK_MS = 5 * 60_000;

let failures = 0;
let lockedUntil = 0;

/** Seconds until wrong guesses are accepted again; 0 when the password can be tried now. */
export function ppmPasswordLockSeconds(now = Date.now()): number {
  return lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0;
}

/** Whether `typed` is PPM's password; always true when none is required. Constant-time, and capped. */
export function checkPpmPassword(typed: unknown, now = Date.now()): boolean {
  if (!ppmPasswordRequired()) return true;
  if (ppmPasswordLockSeconds(now) > 0) return false;
  const right = typeof typed === "string" && typed.length > 0 && typed.length <= 1_000
    && timingSafeEqual(digest(typed), digest(configService.get("auth").token));
  if (right) {
    failures = 0;
    return true;
  }
  if (++failures >= PPM_PASSWORD_MAX_FAILURES) {
    failures = 0;
    lockedUntil = now + PPM_PASSWORD_LOCK_MS;
  }
  return false;
}

/**
 * What a route answers when the password is not PPM's: null to go on, else the status and error.
 * A locked check says so and for how long, rather than "wrong", so the user stops retrying.
 */
export function ppmPasswordRefusal(typed: unknown, now = Date.now()): { status: 403 | 429; error: string } | null {
  if (checkPpmPassword(typed, now)) return null;
  const wait = ppmPasswordLockSeconds(now);
  if (wait > 0) return { status: 429, error: ppmPasswordLockedText(wait) };
  return { status: 403, error: "Wrong PPM password" };
}

/** For tests: forget every wrong guess. */
export function _resetPpmPasswordAttempts(): void {
  failures = 0;
  lockedUntil = 0;
}
