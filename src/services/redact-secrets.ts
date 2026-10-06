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
 * `key=value`, `--key value`, and URL userinfo `scheme://user:pass@host` — and three
 * secrets that travel inside ordinary-looking text: a Telegram bot token (`123456789:AAH…`),
 * which sits in the path of every Bot API URL (`/bot<token>/sendMessage`) and so in any
 * fetch error that quotes one, an ntfy topic quoted in a refusal, and a MediaMTX path name.
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
  // Telegram bot token `<bot id>:<35 chars>` → keep the bot id, drop the secret half.
  [/(\d{6,}):[A-Za-z0-9_-]{30,}/g, "$1:[REDACTED]"],
  // An ntfy topic is the only thing between a public server and the messages on it, and a
  // refusal quotes it (`may not publish to "<topic>" on ntfy.sh`).
  [/(publish to ")[^"]*"/gi, '$1[topic]"'],
  // A MediaMTX path name (`s` + 32 hex, mediamtx-config.ts) is the per-session secret of the
  // relay's publish and WHEP URLs.
  [/\bs[0-9a-f]{32}\b/g, "[stream]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/**
 * For log text that ends up in a bug report (`/api/logs/recent`, `ppm report`), which is posted
 * as a public issue: `redactSecrets` plus a quick tunnel's hostname. A dev server forwarded
 * through a quick tunnel answers anyone holding that URL, so it is a credential there — while
 * in `ppm.log`, the owner's own record, it stays.
 */
export function redactForBugReport(text: string): string {
  return redactSecrets(text).replace(/\b[a-z0-9-]+\.trycloudflare\.com\b/gi, "[tunnel].trycloudflare.com");
}
