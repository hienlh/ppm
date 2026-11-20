/**
 * What still asks when the Assistant acts on its own (Full mode, or "Let the Assistant act on its
 * own"): a provider tool call that sends something off the machine or to other people — a push, a
 * publish, a comment or message, an upload, a remote login. The user chose Full as "like a bypass
 * chat, except that pushing, publishing and sending to others still needs me".
 *
 * A denylist over the command's text, so it is not a security boundary: a command spelled through
 * a variable, an alias or a script file gets past it. It stops the Assistant's own mistakes and
 * the obvious forms; the boundary against injected text is that a turn PPM started never acts on
 * its own at all. Pure.
 */

/** An HTTP method that writes, in any case, after an optional quote. */
const METHOD = "['\"]?([Pp][Oo][Ss][Tt]|[Pp][Uu][Tt]|[Pp][Aa][Tt][Cc][Hh]|[Dd][Ee][Ll][Ee][Tt][Ee])\\b";

/** Longer than this is not scanned: the command asks instead. */
export const OUTBOUND_SCAN_MAX_CHARS = 32_000;

/**
 * Each rule runs on one command of the line at a time (split at `;`, `&`, `|` and line breaks,
 * runs of spaces collapsed). A rule is the program (`lead`, found once) and, when it needs one,
 * what follows it (`tail`, tested once on the rest), so no pattern rescans the text from every
 * place a program name appears. Program names match in any case; flags whose case matters
 * (`curl -F` is a form upload, `-f` only "fail quietly") are matched as written.
 */
const OUTBOUND_RULES: ReadonlyArray<{ lead: RegExp; tail?: RegExp; what: string }> = [
  { lead: /\bgit\b/i, tail: / push\b/i, what: "a git push" },
  { lead: /\bgit send-email\b/i, what: "an email" },
  { lead: /\bgh (pr|issue) (create|comment|review|merge|close|reopen|edit|ready|lock|unlock|delete|transfer|develop)\b/i, what: "a GitHub pull request or issue change" },
  { lead: /\bgh (release|gist|repo|secret|variable|label|workflow|run|cache|ruleset|project) (create|upload|edit|delete|set|run|rerun|cancel|enable|disable|fork|rename|archive|sync|close|copy|item-add|item-edit|item-delete)\b/i, what: "a GitHub change" },
  { lead: /\bgh api\b/i, tail: new RegExp(` (-X|--method)[ =]?${METHOD}| (-f|-F|--field|--raw-field|--input)[ =]`), what: "a GitHub API write" },
  { lead: /\b(npm|pnpm|yarn|bun) publish\b|\bcargo publish\b|\btwine upload\b|\bgem push\b|\bdotnet nuget push\b|\bdocker (image )?push\b|\bvsce publish\b/i, what: "a publish" },
  { lead: /\bcurl\b/i, tail: new RegExp(` -[A-Za-z]*X[ =]?${METHOD}| --request[ =]?${METHOD}| -[A-Za-z]*[dFT]| --(data|form|upload-file|json)\\b`), what: "an HTTP upload" },
  { lead: /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b/i, tail: /-method ['"]?(post|put|patch|delete)\b|-body\b|-infile\b/i, what: "an HTTP upload" },
  { lead: /\bwget\b/i, tail: /--(post-data|post-file|method)/i, what: "an HTTP upload" },
  { lead: /(^|[\s(])(ssh|scp|sftp|rsync) /i, what: "a remote login or copy" },
  { lead: /\b(sendmail|send-mailmessage)\b|(^|[\s(])mail /i, what: "an email" },
];

/** What a command sends out, or null when its text names nothing on the list. */
export function commandSendsOut(command: string): string | null {
  if (command.length > OUTBOUND_SCAN_MAX_CHARS) return "a command too long for PPM to check";
  for (const part of command.split(/[;&|\r\n]+/)) {
    const text = part.replace(/[ \t]+/g, " ").trim();
    if (!text) continue;
    for (const rule of OUTBOUND_RULES) {
      const lead = rule.lead.exec(text);
      if (lead && (!rule.tail || rule.tail.test(text.slice(lead.index + lead[0].length)))) return rule.what;
    }
  }
  return null;
}

/**
 * Verbs that start the name of a tool that only reads, the way MCP servers name them
 * (`list_channels`, `get-issue`, `searchMessages`). A user's own MCP server is where Slack, email,
 * Jira and GitHub reach the Assistant, and its other tools may post: those ask.
 */
// Not `query` or `run`: a database server's `query` tool runs writes as readily as reads.
const READ_VERBS = ["get", "list", "search", "read", "fetch", "find", "describe", "view", "show", "lookup", "status", "whoami", "count", "browse"];

/** Whether a user MCP server's tool, by its bare name, reads by the naming convention above. */
export function mcpToolNameReads(bare: string): boolean {
  const first = bare.split(/[_\-.]|(?<=[a-z])(?=[A-Z])/)[0]?.toLowerCase() ?? "";
  return READ_VERBS.includes(first);
}

/**
 * For a Claude tool name of a user MCP server (`mcp__<server>__<tool>`): why it asks while the
 * Assistant acts on its own, or null when it may run. Not one of those names → null.
 */
export function mcpToolSendsOut(toolName: string): string | null {
  const m = /^mcp__.+?__(.+)$/.exec(toolName);
  if (!m) return null;
  return mcpToolNameReads(m[1]!) ? null : "a tool of your own MCP server that may post or send";
}
