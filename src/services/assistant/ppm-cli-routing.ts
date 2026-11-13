/**
 * How each `ppm` command reaches PPM, keyed by its command path (`db add`, `cloud login`):
 *
 * - `server`: goes through the running PPM that holds the database (`ppm-server-client.ts`),
 *   with the same checks and live updates as PPM's screens; it writes directly only when no
 *   server holds the database, and says so.
 * - `direct-allowed`: needs no server — process control, setup, reading, or work on something
 *   other than PPM's live data (a repository, a backup file, the cloud account).
 * - `direct-pending`: still writes PPM's data itself. A running server may not see the change
 *   until it restarts, and may write its own copy back over it.
 *
 * A test walks the real command tree and fails when a command is missing here or an entry names
 * a command that no longer exists, so a new command has to be placed on purpose.
 */
export type CliRouting = "server" | "direct-allowed" | "direct-pending";

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
];

const DIRECT_ALLOWED = [
  "start", "stop", "down", "restart", "status", "open", "logs", "report", "init", "upgrade",
  "autostart enable", "autostart disable", "autostart status",
  "cloud login", "cloud logout", "cloud status", "cloud devices", "cloud alias get",
  "skills list", "skills search", "skills info", "export skill",
  "backup", "restore",
  "config get", "projects list", "accounts add",
  "chat list", "chat send", "chat resume",
  "db list", "db tables", "db schema", "db data", "db query", "db driver list",
  "ext list",
  "jira config show", "jira config test", "jira watch list",
  "schedule list", "schedule runs",
];

const DIRECT_PENDING = [
  "cloud alias set", "cloud alias remove",
  "ext install", "ext remove", "ext enable", "ext disable", "ext dev",
  "db run", "db driver install", "db driver remove",
  "jira config set", "jira config remove",
  "jira watch add", "jira watch enable", "jira watch disable", "jira watch remove", "jira watch test", "jira watch pull",
  "jira results delete", "jira track",
  "schedule add", "schedule rm", "schedule enable", "schedule disable",
];

export const CLI_COMMAND_ROUTING: Readonly<Record<string, CliRouting>> = Object.freeze({
  ...Object.fromEntries(SERVER.map((p) => [p, "server" as const])),
  ...Object.fromEntries(DIRECT_ALLOWED.map((p) => [p, "direct-allowed" as const])),
  ...Object.fromEntries(DIRECT_PENDING.map((p) => [p, "direct-pending" as const])),
});

export function commandPathsWithRouting(kind: CliRouting): string[] {
  return Object.entries(CLI_COMMAND_ROUTING).filter(([, k]) => k === kind).map(([p]) => p);
}
