/**
 * Is this code block a shell command a person could run? Decides whether a chat's code block
 * gets the Run and Run in terminal buttons.
 *
 * A block tagged as shell always is. An AI often writes a one-off command with no tag at all
 * (```` ``` ```` + `grep '^KEY=' .env`), so an untagged (or `text`) block counts too when it is
 * short and every line starts like a command: a `$ ` prompt, a path to a program (`./x`, `~/x`,
 * `/usr/bin/x`), or a program people type, optionally after `sudo` or `VAR=value`. Anything
 * else — code, a config file, prose — stays a plain block with only Copy.
 */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "shellsession", "shell-session"]);
const UNTAGGED_LANGS = new Set(["", "text", "txt", "plaintext", "plain"]);
const MAX_UNTAGGED_LINES = 8;

const COMMANDS = new Set([
  "adb", "agy", "apt", "apt-get", "awk", "brew", "bun", "bunx", "cargo", "cat", "cd", "chmod", "chown", "claude",
  "cmake", "code", "codex", "cp", "curl", "cut", "deno", "df", "diff", "dig", "docker", "du", "echo", "env",
  "export", "fd", "find", "free", "gh", "git", "go", "gradle", "grep", "head", "htop", "ip", "journalctl", "jq",
  "kill", "kubectl", "less", "ln", "ls", "lsof", "make", "mkdir", "mv", "mysql", "nc", "node", "npm", "npx",
  "open", "pacman", "paru", "pgrep", "ping", "pip", "pip3", "pnpm", "podman", "ppm", "printenv", "ps", "psql",
  "pwd", "python", "python3", "readlink", "rg", "rm", "rmdir", "rsync", "rustc", "scp", "sed", "sort", "source",
  "sqlite3", "ss", "ssh", "stat", "systemctl", "tail", "tar", "tee", "touch", "tree", "uname", "uniq", "unzip",
  "uv", "wc", "wget", "which", "xargs", "xdg-open", "yarn", "yay", "zip",
]);

/** `sudo`, `VAR=value` and `time` in front of the program do not decide what it is. */
const PREFIX_RE = /^(?:(?:sudo|time|nohup)\s+|[A-Za-z_][A-Za-z0-9_]*=(?:\$\([^)]*\)|"[^"]*"|'[^']*'|\S*)\s+)+/;

function looksLikeCommandLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith("#")) return true; // a blank line or a comment between commands
  if (/^\$\s/.test(t)) return true;
  const rest = t.replace(PREFIX_RE, "");
  if (/^(?:\.{1,2}\/|~\/|\/)[\w.~/-]+(?:\s|$)/.test(rest)) return true;
  const program = rest.split(/\s/, 1)[0] ?? "";
  return COMMANDS.has(program);
}

/** A line ending in `\` or `|`, `&&`, `||` goes on to the next one: that next line is not a command of its own. */
const CONTINUES = /(?:\\|\||&&)\s*$/;

export function isShellCodeBlock(lang: string | undefined, text: string): boolean {
  const l = (lang ?? "").toLowerCase();
  if (SHELL_LANGS.has(l)) return true;
  if (!UNTAGGED_LANGS.has(l)) return false;
  const lines = text.replace(/\s+$/, "").split("\n");
  if (!lines[0]?.trim() || lines.length > MAX_UNTAGGED_LINES) return false;
  let continued = false;
  for (const line of lines) {
    if (!continued && !looksLikeCommandLine(line)) return false;
    continued = CONTINUES.test(line);
  }
  return true;
}
