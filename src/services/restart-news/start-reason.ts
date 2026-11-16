import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { START_REASON_KINDS, type StartReasonKind } from "../../shared/restart-news.ts";

/**
 * Why a server process started, as the process that started it knows it. The supervisor decides
 * at every spawn (it saw the upgrade, the health-check kill, the crash) and hands the answer to
 * the child in two environment variables; the server reads them once at boot. A `ppm restart
 * --reason …` (an external RAM watchdog, a script) leaves a small request file the supervisor
 * consumes at its next spawn, because a signal carries no words and the Windows command file is
 * read by a supervisor that may be older than this code.
 *
 * Kept free of anything but `node:fs`: the supervisor and the CLI import it.
 */

export const START_REASON_ENV = "PPM_START_REASON";
export const START_DETAIL_ENV = "PPM_START_DETAIL";
export const START_REQUESTED_BY_ENV = "PPM_START_REQUESTED_BY";

/** A request older than this is a leftover of a restart that never happened, not this one's. */
export const RESTART_REQUEST_MAX_AGE_MS = 5 * 60_000;

const DETAIL_MAX = 200;
const REQUEST_FILE = ".restart-reason";

export interface StartReason {
  kind: StartReasonKind;
  /** A short, single-line note: an exit code and signal, a user's words. */
  detail?: string;
  /**
   * Who asked, when a `ppm restart`/`stop`/`upgrade` did: the command, its pid and the processes
   * above it, and the AI chat it ran in (`restart-caller.ts`). Never the user's words.
   */
  requestedBy?: string;
}

export const isStartReasonKind = (v: unknown): v is StartReasonKind =>
  typeof v === "string" && (START_REASON_KINDS as readonly string[]).includes(v);

/** One line, printable, capped: this text ends up in a model's context and in a log line. */
export function cleanDetail(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  // Control and format characters (bidi overrides, zero-width) are dropped, not shown.
  const one = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return one ? Array.from(one).slice(0, DETAIL_MAX).join("") : undefined;
}

/** The two variables a spawned server is given. */
export function startReasonEnv(reason: StartReason): Record<string, string> {
  const detail = cleanDetail(reason.detail);
  const by = cleanDetail(reason.requestedBy);
  return {
    [START_REASON_ENV]: reason.kind,
    ...(detail ? { [START_DETAIL_ENV]: detail } : {}),
    ...(by ? { [START_REQUESTED_BY_ENV]: by } : {}),
  };
}

/** What the supervisor said, or null when the server was not started by one (or by an older one). */
export function readStartReasonEnv(env: Record<string, string | undefined>): StartReason | null {
  const kind = env[START_REASON_ENV];
  if (!isStartReasonKind(kind)) return null;
  const detail = cleanDetail(env[START_DETAIL_ENV]);
  const by = cleanDetail(env[START_REQUESTED_BY_ENV]);
  return { kind, ...(detail ? { detail } : {}), ...(by ? { requestedBy: by } : {}) };
}

/**
 * `ppm restart --reason <text>`: one of the kinds by name (`watchdog`, `recycle`…), anything else
 * a manual restart carrying the words as its note.
 */
export function parseReasonArg(text: string | undefined): StartReason {
  const clean = cleanDetail(text);
  if (!clean) return { kind: "manual" };
  const word = clean.toLowerCase();
  if (isStartReasonKind(word)) return { kind: word };
  const [head, ...rest] = clean.split(/[:\s]+/);
  if (head && isStartReasonKind(head.toLowerCase()) && rest.length) {
    const detail = cleanDetail(clean.slice(head.length).replace(/^[:\s]+/, ""));
    return { kind: head.toLowerCase() as StartReasonKind, ...(detail ? { detail } : {}) };
  }
  return { kind: "manual", detail: clean };
}

const requestPath = (ppmDir: string) => resolve(ppmDir, REQUEST_FILE);

/** Written by the CLI just before it asks the supervisor to restart the server. */
export function writeRestartRequest(ppmDir: string, reason: StartReason, now = Date.now()): void {
  if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
  const file = requestPath(ppmDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const detail = cleanDetail(reason.detail);
  const by = cleanDetail(reason.requestedBy);
  writeFileSync(tmp, JSON.stringify({ kind: reason.kind, ...(detail ? { detail } : {}), ...(by ? { requestedBy: by } : {}), at: now }), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Removes the request: the CLI that wrote it did not get its restart through. Never throws. */
export function clearRestartRequest(ppmDir: string): void {
  try { unlinkSync(requestPath(ppmDir)); } catch { /* none left */ }
}

/**
 * Removes a request too old to be anyone's, unread. Most spawns never read it (a crash must not
 * wear one), so without this a leftover would sit in the folder until the next manual restart.
 */
export function dropStaleRestartRequest(ppmDir: string, now = Date.now()): void {
  const file = requestPath(ppmDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as { at?: unknown };
    const at = typeof parsed.at === "number" ? parsed.at : -Infinity;
    if (now - at <= RESTART_REQUEST_MAX_AGE_MS && at - now <= 60_000) return;
  } catch {
    if (!existsSync(file)) return; // nothing there; an unreadable one is dropped below
  }
  try { unlinkSync(file); } catch { /* another reader took it */ }
}

/**
 * Who the pending request says asked, without consuming it: the supervisor names the asker in its
 * log line when the restart command arrives, and the request is taken later, at the spawn.
 */
export function peekRestartRequester(ppmDir: string, now = Date.now()): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(requestPath(ppmDir), "utf8").replace(/^﻿/, "")) as { requestedBy?: unknown; at?: unknown };
    if (typeof parsed.at !== "number" || now - parsed.at > RESTART_REQUEST_MAX_AGE_MS || parsed.at - now > 60_000) return undefined;
    return cleanDetail(parsed.requestedBy);
  } catch {
    return undefined;
  }
}

/**
 * The tail of the supervisor's line for a restart, stop or upgrade command. "No caller recorded"
 * is itself a finding: whatever sent it was not a `ppm` command that records its caller (a
 * hand-written command file, a bare signal, an older `ppm`).
 */
export function requesterNote(requestedBy: unknown): string {
  const by = cleanDetail(requestedBy);
  return by ? ` (requested by ${by})` : " (no caller recorded: not sent by a ppm command that records one)";
}

/**
 * The request the CLI left, consumed: read once and deleted, so a later spawn for another reason
 * never wears it. Null when there is none, it is stale, or it cannot be read.
 */
export function takeRestartRequest(ppmDir: string, now = Date.now()): StartReason | null {
  const file = requestPath(ppmDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try { unlinkSync(file); } catch { /* another reader took it */ }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as { kind?: unknown; detail?: unknown; requestedBy?: unknown; at?: unknown };
    if (!isStartReasonKind(parsed.kind) || typeof parsed.at !== "number") return null;
    if (now - parsed.at > RESTART_REQUEST_MAX_AGE_MS || parsed.at - now > 60_000) return null;
    const detail = cleanDetail(parsed.detail);
    const by = cleanDetail(parsed.requestedBy);
    return { kind: parsed.kind, ...(detail ? { detail } : {}), ...(by ? { requestedBy: by } : {}) };
  } catch {
    return null;
  }
}
