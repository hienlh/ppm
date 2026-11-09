/**
 * A script schedule's secret input values: one JSON object, encrypted with PPM's account key
 * (`secrets_enc`). Only the process that runs the script ever sees them in the clear.
 */
import { decrypt, encrypt } from "../../lib/account-crypto.ts";
import { isPlainObject } from "../../shared/schedule-definition.ts";
import type { Schedule } from "../../types/scheduler.ts";

export function readSecrets(schedule: Pick<Schedule, "secrets_enc">): Record<string, string> {
  if (!schedule.secrets_enc) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(schedule.secrets_enc));
  } catch {
    throw new Error("This schedule's secrets cannot be read with this PPM's key; enter them again");
  }
  if (!isPlainObject(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export function encryptSecrets(secrets: Record<string, string>): string | null {
  return Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null;
}
