import { createHash, timingSafeEqual } from "node:crypto";
import { configService } from "./config.service.ts";

/**
 * PPM's password — the auth token a browser logs in with — typed again to approve a write on
 * a database: an AI's `db_execute`, or a Query tab run with write access once.
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

/** Whether `typed` is PPM's password; always true when none is required. Constant-time. */
export function checkPpmPassword(typed: unknown): boolean {
  if (!ppmPasswordRequired()) return true;
  if (typeof typed !== "string" || typed.length === 0 || typed.length > 1_000) return false;
  return timingSafeEqual(digest(typed), digest(configService.get("auth").token));
}
