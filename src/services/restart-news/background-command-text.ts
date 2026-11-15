import { redactLogText } from "../../shared/log-redact.ts";

/**
 * A background task's command line as the restart news may quote it. Commands carry credentials far
 * more often than prompts do (`mysql -pSecret`, `curl -u me:secret`, `docker login -p …`, `$env:TOKEN=…`),
 * and the news goes to the Assistant and from there possibly to Telegram, so on top of the log
 * redaction every value that follows a credential-looking flag, assignment or header is replaced.
 * Over-redacting a harmless value is the accepted cost: the chat that ran the command still has it.
 */

const R = "[REDACTED]";
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`;

const COMMAND_SECRETS: ReadonlyArray<[RegExp, string]> = [
  // scheme://user:password@host
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${R}@`],
  // curl -u user:password, --user user:password
  [/((?:^|\s)(?:-u|--user)\s+[^\s:]+:)\S+/gi, `$1${R}`],
  // --password x, --token=x, -Token x (PowerShell), --api-key x …
  [new RegExp(String.raw`((?:^|\s)--?(?:password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|client[-_]?secret|auth(?:[-_]?token)?|key|credentials?)(?:\s+|=|:))${VALUE}`, "gi"), `$1${R}`],
  // sshpass -p x; docker/podman/helm … login … -p x
  [/(\bsshpass\s+-p\s*)\S+/gi, `$1${R}`],
  [/(\blogin\b[^|;&\n]*?\s-p\s+)\S+/gi, `$1${R}`],
  // FOO_TOKEN=x, PASSWORD="x", $env:API_KEY = 'x'
  [new RegExp(String.raw`(\b[\w]*(?:token|secret|password|passwd|pass|pwd|api_?key|access_?key|credentials?)[\w]*\s*=\s*)${VALUE}`, "gi"), `$1${R}`],
  // Authorization: Bearer x
  [/(authorization:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, `$1${R}`],
];

/** mysql and friends take the password glued to `-p`, which on other tools is a port or a path. */
const GLUED_PASSWORD_TOOLS = /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b/i;

const ONLY_SECRETS = { home: false, email: false, chats: false } as const;

export function scrubCommand(command: string): string {
  let out = redactLogText(command, ONLY_SECRETS);
  for (const [re, to] of COMMAND_SECRETS) out = out.replace(re, to);
  if (GLUED_PASSWORD_TOOLS.test(out)) out = out.replace(/((?:^|\s)-p)(?!\s)(?!\[REDACTED\])\S+/g, `$1${R}`);
  return out;
}
