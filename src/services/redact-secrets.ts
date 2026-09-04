/**
 * Shared secret redactor for text that leaves the server: the public
 * `/api/logs/recent` tail and process command lines in the metrics stream.
 *
 * Kept in one place so both consumers agree on what counts as a secret. Apply
 * it BEFORE any truncation — secrets sit at the front of argv (`--token=…`,
 * `postgres://user:pass@…`, `ANTHROPIC_API_KEY=… node x.js`), so truncating
 * first would keep the secret and leave the redactor nothing to find.
 *
 * Rules: the six log-line forms (`Token: x`, `Bearer x`, `password: x`,
 * `api_key: x`, `ANTHROPIC_API_KEY=x`, `secret: x`), then the argv forms —
 * `key=value`, `--key value`, and URL userinfo `scheme://user:pass@host`.
 */
const RULES: ReadonlyArray<[RegExp, string]> = [
  [/Token:\s*\S+/gi, "Token: [REDACTED]"],
  [/Bearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/password['":\s]+\S+/gi, "password: [REDACTED]"],
  [/api[_-]?key['":\s]+\S+/gi, "api_key: [REDACTED]"],
  [/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]"],
  [/secret['":\s]+\S+/gi, "secret: [REDACTED]"],
  // argv `--token=abc`, `API_KEY=abc`, `DB_PASSWORD=abc`.
  [/((?:token|api[_-]?key|secret|password)=)\S+/gi, "$1[REDACTED]"],
  // argv space form `--token abc`, `-p abc` is too ambiguous and is left alone.
  [/(--?(?:token|api[_-]?key|secret|password)\s+)\S+/gi, "$1[REDACTED]"],
  // URL userinfo `postgres://user:pass@host` → keep the user, drop the password.
  [/(:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[REDACTED]@"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
