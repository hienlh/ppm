/**
 * Credentials out of memory text before it is written (requirements 10.1, 10.2).
 *
 * Every rule replaces a value with `[REDACTED]` and counts it. Order matters: a PEM block, a
 * Bearer value and a JWT go first so a key-shaped value inside them is counted once, and the
 * assignment rule runs last and skips a value already redacted — so `api_key = "sk-…"` is one
 * redaction and running the function on its own output changes nothing.
 *
 * Prose stays as it is: an assignment needs `=` or `:` and a value of 8+ characters with no
 * spaces, a Bearer value needs a digit ("Bearer authentication" is a phrase, not a token), and
 * `sk-` must start a word ("task-runner" is not a key).
 */

export const REDACTED = "[REDACTED]";

const PEM_PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const BEARER = /\b(Bearer[ \t]+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const API_KEY = /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
// key (optionally quoted), `=` or `:`, then a quoted value closed by the same quote or a bare one.
const ASSIGNMENT =
  /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:password|passwd|token|secret|api_key|apikey)["']?[ \t]*[:=][ \t]*)(?:(["'])(?!\[REDACTED\])[^\s"']{8,}\2|(?![\[\]"'/])(?!\[REDACTED\])[^\s"'`,;&)}\]>(=]{8,}={0,2}(?=$|[\s"'`,;&)}\]>]))/gim;

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  const swap = (prefix = "", quote = ""): string => {
    count++;
    return `${prefix}${quote}${REDACTED}${quote}`;
  };

  const out = text
    .replace(PEM_PRIVATE_KEY, () => swap())
    .replace(BEARER, (_m, scheme: string) => swap(scheme))
    .replace(JWT, () => swap())
    .replace(API_KEY, () => swap())
    .replace(ASSIGNMENT, (_m, key: string, quote: string | undefined) => swap(key, quote ?? ""));

  return { text: out, count };
}
