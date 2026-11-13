/**
 * Whether a database URL carries a password, and the URL as it may be shown: on a card, in a
 * listing, in a log line. Shared by the CLI, the Assistant's connection tools and the server, so
 * one rule decides what counts as a password everywhere.
 *
 * A password can sit in two places: the login (`user:secret@host`) and, for libpq-style URLs, a
 * `password` query parameter. Both count.
 */
import { buildDbUrl, parseDbUrl, type DbUrlParts } from "./db-connection-url.ts";

const PASSWORD_PARAM = /^pass(word)?$/i;
const SHOWN = "***";

/** The parts with every password in them replaced by `value` (or taken out, for ""). */
function withPasswords(parts: DbUrlParts, value: string): DbUrlParts {
  return {
    ...parts,
    password: parts.password ? value : "",
    params: parts.params.flatMap(([name, v]) => (PASSWORD_PARAM.test(name) ? (value ? [[name, value] as [string, string]] : []) : [[name, v] as [string, string]])),
  };
}

/** True when the URL's own text holds a password PPM would keep. */
export function hasPassword(url: string): boolean {
  const parsed = parseDbUrl(url);
  if (parsed.kind === "url") return !!parsed.parts.password || parsed.parts.params.some(([name, v]) => PASSWORD_PARAM.test(name) && !!v);
  // A string PPM cannot read: anything shaped like `scheme://user:secret@` is treated as one.
  return parsed.kind === "error" && /:\/\/[^/?#]*:[^/?#]*@/.test(url);
}

/** The URL with every password shown as `***`; a URL with none is returned as it was written. */
export function redactUrl(url: string): string {
  if (!hasPassword(url)) return url.trim();
  const parsed = parseDbUrl(url);
  if (parsed.kind === "url") return buildDbUrl(withPasswords(parsed.parts, SHOWN));
  return url.trim().replace(/(:\/\/[^/?#:]*:)[^/?#]*(@)/, `$1${SHOWN}$2`);
}

/** The parts without any password, for a URL that must keep everything else. */
export function withoutPasswords(parts: DbUrlParts): DbUrlParts {
  return withPasswords(parts, "");
}
