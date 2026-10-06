/**
 * What is taken out of log text before it leaves the machine: in a GitHub issue (the Report
 * tab's "Removed before sending" switches) and in what the AI is shown.
 *
 * Secrets go whatever the switches say. `ppm.log` is redacted as it is written, but only what
 * passes through the logger: what a process prints to its own stderr (a Bun error dump, a child
 * that inherits it) lands in the file as printed, and the write-time rules key on a name
 * (`token=`, `Bearer`), so a bare `sk-ant-…` in a stack line or a logged `"access_token":"…"`
 * passes them. The switches are about what identifies a person or a machine.
 *
 * With `mark`, every replacement is wrapped in \u0001…\u0002 so the preview can highlight it.
 */
export interface RedactOptions {
  /** `/home/dev` → `~`. */
  home: boolean;
  /** `dev@example.com` → `<email>`. */
  email: boolean;
  /** `53952680-0b07-…` → `53952680`. */
  chats: boolean;
  /** Names of the person's projects → `<project>`; empty or absent leaves them. */
  projects?: readonly string[];
}

export const DEFAULT_REDACT: RedactOptions = { home: true, email: true, chats: true, projects: [] };

const TUNNEL_HOST = /\b[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com\b/gi;
/**
 * Each keeps its first group (the name, the user, the bot id) and replaces the rest. A value
 * never starts at \u0001, so a marked replacement is not taken twice, and the `[REDACTED]` the
 * write-time redactor leaves stays one `[REDACTED]`.
 */
const SECRETS: readonly RegExp[] = [
  // By their own prefix: Anthropic and OpenAI `sk-…`, GitHub `ghp_…`/`github_pat_…`, a JWT.
  /()\b(?:sk-[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*)/g,
  // A Telegram bot token, in the path of every Bot API URL: keep the bot id.
  /(\d{6,}:)[\w-]{30,}/g,
  // URL userinfo `postgres://user:pass@host`: keep the user.
  /(:\/\/[^/\s:@]*:)[^@\s/\u0001]+(?=@)/g,
  // A credential in a query or a fragment: `?token=`, `&code=`, `#access_token=`.
  /([?&#][\w.-]*(?:token|key|secret|passw|auth|code|state|ticket|sig|credential)[\w.-]*=)[^&#\s"'<>[\]\u0001]+/gi,
  // A header or a field named for what it holds: `Authorization: Basic …` (scheme and all),
  // `Cookie: …`, `Bearer …`, `Token: …`, `"access_token":"…"`, `api_key=…`.
  /(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer|digest|token)\s+)?[^\s"',;\u0001]+/gi,
  /(\b(?:set-)?cookie["']?\s*[:=]\s*["']?)(?=[^\s=;"']+=)[^\r\n"'\u0001]+/gi,
  /(\bbearer\s+)[^\s"',;[\]\u0001]+/gi,
  /((?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&,;)}[\]\u0001]+/gi,
];
// `/home/dev`, `/Users/dev`, `C:\Users\dev` — the last also as `JSON.stringify` writes it
// (`C:\\Users\\dev`) and with forward slashes.
const HOME = /(?:\/home\/|\/Users\/)[^/\s"'`]+|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"'`]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactLogText(text: string, opts: RedactOptions, mark = false): string {
  const m = (s: string) => (mark ? `\u0001${s}\u0002` : s);
  let out = text.replace(TUNNEL_HOST, () => m("<tunnel>.trycloudflare.com"));
  for (const re of SECRETS) out = out.replace(re, (_s, keep: string) => `${keep}${m("[REDACTED]")}`);
  if (opts.home) out = out.replace(HOME, () => m("~"));
  if (opts.email) out = out.replace(EMAIL, () => m("<email>"));
  if (opts.chats) out = out.replace(UUID, (_u, head: string) => m(head));
  const names = (opts.projects ?? []).filter((n) => n.trim().length >= 3);
  if (names.length) {
    const re = new RegExp(`(?<![\\w-])(?:${names.map(escapeRe).sort((a, b) => b.length - a.length).join("|")})(?![\\w-])`, "gi");
    out = out.replace(re, () => m("<project>"));
  }
  return out;
}

/** The names of what `redactLogText` took out, for the line at the foot of a report. */
export function redactedKinds(opts: RedactOptions): string[] {
  return [
    "secrets",
    opts.home && "home paths",
    opts.email && "emails",
    opts.chats && "chat ids",
    opts.projects?.length && "project names",
  ].filter((x): x is string => !!x);
}
