/**
 * How each `ppm` command reaches PPM, keyed by its command path (`db add`, `cloud login`):
 *
 * - `server`: goes through the running PPM that holds the database (`ppm-server-client.ts`),
 *   with the same checks and live updates as PPM's screens; it writes directly only when no
 *   server holds the database, and says so.
 * - `direct-allowed`: needs no server — process control, setup, reading, or work on something
 *   other than PPM's live data (a repository, a backup file, the cloud account).
 *
 * There is no third kind: no command writes PPM's data behind a running server. A test walks the
 * real command tree and fails when a command is missing here or an entry names a command that no
 * longer exists, so a new command has to be placed on purpose, in one of these two lists.
 */
export type CliRouting = "server" | "direct-allowed";

const SERVER = [
  "config set",
  "projects add", "projects remove", "projects rename", "projects move", "projects color", "projects icon",
  "projects reorder", "projects clone", "projects settings get", "projects settings set",
  "schedule run-now", "schedule export", "schedule import", "schedule state", "schedule set-state",
  "chat create", "chat rename", "chat pin", "chat unpin", "chat tag", "chat untag", "chat read", "chat unread",
  "chat stop", "chat delete", "chat fork", "chat account", "chat cleanup",
  "chat changes list", "chat changes diff", "chat changes keep", "chat changes reopen", "chat changes revert",
  "chat changes undo", "chat turns", "chat revert-turn",
  "tags list", "tags add", "tags rename", "tags remove",
  "manager list", "manager assign", "manager unassign",
  "git status", "git log", "git diff", "git stage", "git unstage", "git discard", "git commit",
  "git undo discard", "git undo commit", "git fetch", "git pull", "git push", "git publish",
  "git branch create", "git branch checkout", "git branch delete", "git branch merge",
  "git cherry-pick", "git revert", "git tag", "git abort", "git continue",
  "git stash save", "git stash list", "git stash apply", "git stash pop", "git stash drop",
  "git worktree list", "git worktree add", "git worktree remove", "git worktree prune",
  "db add", "db edit", "db remove", "db test", "db duplicate", "db import",
  "theme get", "theme set", "theme list", "theme import", "theme remove", "theme rename",
  "ai get", "ai set", "ai providers", "ai probe", "ai models",
  "keybindings list", "keybindings set", "keybindings reset",
  "proxy get", "proxy set", "proxy key generate", "device-name",
  "settings files get", "settings files set",
  "settings query-audit get", "settings query-audit set", "settings query-audit clear", "settings trace set",
  "notify get", "notify set", "notify delay", "notify ntfy set", "notify ntfy remove", "notify ntfy test",
  "notify telegram chats", "notify telegram remove", "notify telegram connect", "notify push test",
  "telegram-bot get", "telegram-bot set", "telegram-bot remove", "telegram-bot test",
  "ppmbot get", "ppmbot set", "ppmbot token", "ppmbot chats", "ppmbot revoke", "ppmbot connect",
  "mcp list", "mcp add", "mcp edit", "mcp remove", "mcp import",
  "accounts list", "accounts pick", "accounts verify", "accounts rename", "accounts enable", "accounts disable",
  "accounts remove", "accounts settings",
  "ext list", "ext install", "ext remove", "ext enable", "ext disable", "ext dev", "ext run",
  "lsp list", "lsp install", "lsp remove",
  "speech status", "speech install", "speech remove",
  "db driver list", "db driver install", "db driver remove",
  "jira config set", "jira config show", "jira config remove", "jira config test",
  "jira watch add", "jira watch list", "jira watch enable", "jira watch disable", "jira watch remove",
  "jira watch test", "jira watch pull", "jira results", "jira results delete", "jira track",
  "system processes", "system process", "system kill", "system signal", "system resources",
  "system services", "system service",
  "design list", "design create", "design rename", "design delete", "design history", "design restore", "design export",
  "logs issues", "logs issues analyze", "logs issues auto", "logs issues dismiss", "logs issues undismiss", "logs report draft",
  "schedule add", "schedule edit", "schedule rm", "schedule enable", "schedule disable",
  "group-chat list", "group-chat show", "group-chat create", "group-chat set",
  "group-chat members add", "group-chat members edit", "group-chat members remove",
  "group-chat message", "group-chat stop", "group-chat resume", "group-chat delete",
  "teams list", "teams delete",
  "cloud link", "cloud unlink", "cloud alias set", "cloud alias remove",
  "forward list", "forward start", "forward stop",
];

const DIRECT_ALLOWED = [
  "start", "stop", "down", "restart", "status", "open", "logs", "report", "init", "upgrade",
  "autostart enable", "autostart disable", "autostart status",
  "cloud login", "cloud logout", "cloud status", "cloud devices", "cloud alias get",
  "skills", "skills list", "skills search", "skills info", "export skill",
  "backup", "restore",
  "config get", "projects list", "accounts add",
  "chat list", "chat send", "chat resume",
  // `db run` and `db query` run SQL on the user's own database, not PPM's data.
  "db list", "db tables", "db schema", "db data", "db query", "db run",
  "schedule list", "schedule runs",
];

export const CLI_COMMAND_ROUTING: Readonly<Record<string, CliRouting>> = Object.freeze({
  ...Object.fromEntries(SERVER.map((p) => [p, "server" as const])),
  ...Object.fromEntries(DIRECT_ALLOWED.map((p) => [p, "direct-allowed" as const])),
});

/** A path listed twice would be silently decided by whichever list spreads last. */
export function duplicateRoutingPaths(): string[] {
  const all = [...SERVER, ...DIRECT_ALLOWED];
  return all.filter((p, i) => all.indexOf(p) !== i);
}

export function commandPathsWithRouting(kind: CliRouting): string[] {
  return Object.entries(CLI_COMMAND_ROUTING).filter(([, k]) => k === kind).map(([p]) => p);
}
