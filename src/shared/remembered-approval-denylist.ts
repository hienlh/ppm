/**
 * What a remembered approval may never cover. Everything here is decided again on every request,
 * so a rule made for `git status` cannot approve `git status; rm -rf x` or `git push --force`.
 *
 * The list is a floor, not the whole guard: a request whose kind is not on the allow side of
 * `remembered-approval-pattern.ts` has no pattern at all, so it is never remembered either.
 * Never shortened to make a feature work: the user chose what this list keeps out.
 */

/**
 * Commands that change or delete files, leave the machine, run code nobody read, or end processes:
 * never remembered as a first word, in any shell PPM's providers use (POSIX, PowerShell, cmd).
 */
export const DENIED_COMMANDS: ReadonlySet<string> = new Set([
  // Deleting, moving, rewriting files and disks.
  "rm", "rmdir", "del", "erase", "rd", "mv", "move", "ren", "rename", "cp", "copy", "xcopy", "robocopy",
  "dd", "shred", "truncate", "tee", "install", "ln", "mklink", "chmod", "chown", "chgrp", "icacls", "attrib",
  "mkfs", "format", "diskpart", "fdisk", "mount", "umount",
  "remove-item", "ri", "move-item", "mi", "copy-item", "set-content", "add-content", "out-file", "new-item", "rename-item",
  "clear-content", "set-itemproperty", "remove-itemproperty",
  // Privilege and processes.
  "sudo", "su", "doas", "runas", "kill", "pkill", "killall", "taskkill", "stop-process", "shutdown", "reboot",
  "systemctl", "service", "launchctl", "schtasks", "crontab", "reg", "setx",
  // The network: anything that sends, fetches or opens a path in.
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "nc", "ncat", "netcat", "telnet", "socat",
  "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "start-bitstransfer",
  "gh", "hub", "glab", "git-lfs",
  "cloudflared", "ngrok", "tailscale", "localtunnel", "lt",
  // Deploying and cloud control.
  "docker", "podman", "kubectl", "helm", "terraform", "pulumi", "ansible", "aws", "gcloud", "az", "firebase",
  "vercel", "netlify", "fly", "flyctl", "heroku", "wrangler", "railway", "deploy", "serverless", "sls",
  // Shells and inline code: what they run is not on the card.
  "sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "powershell", "pwsh", "eval", "exec", "source", ".",
  "xargs", "env", "nohup", "start", "start-process", "invoke-expression", "iex", "invoke-command", "icm",
  // Fetch-and-run package runners.
  "npx", "bunx", "pnpx", "pnpm-dlx", "uvx", "pipx",
  // Mail and messages.
  "mail", "sendmail", "mutt", "send-mailmessage",
]);

/** Package managers: their subcommands that install, remove or publish are never remembered. */
export const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm", "bun", "pnpm", "yarn", "pip", "pip3", "uv", "poetry", "cargo", "go", "gem", "bundle", "composer",
  "brew", "apt", "apt-get", "dnf", "yum", "pacman", "winget", "choco", "scoop", "dotnet", "nuget", "mvn", "gradle",
]);

/** Subcommands of a package manager that change what is installed, leave the machine or run unread code. */
export const DENIED_PACKAGE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "publish", "unpublish",
  "link", "unlink", "ci", "get", "x", "exec", "dlx", "create", "init", "login", "logout", "adduser", "deprecate",
  "dist-tag", "owner", "access", "token", "pack", "push", "deploy", "release", "yank", "clean", "prune", "dedupe",
]);

/** `git` subcommands that rewrite history, discard work, or reach a remote. */
export const DENIED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "push", "reset", "clean", "rebase", "rm", "mv", "gc", "prune", "filter-branch", "filter-repo", "reflog",
  "checkout", "switch", "restore", "stash", "cherry-pick", "revert", "merge", "pull", "fetch", "clone", "remote",
  "submodule", "worktree", "commit", "am", "apply", "tag", "branch", "update-ref", "replace", "notes", "config",
  "send-email", "request-pull", "daemon", "lfs",
]);

/** Flags that turn an ordinary command into a destructive one, wherever they appear. */
export const DENIED_FLAGS: ReadonlySet<string> = new Set([
  "--force", "--hard", "-D", "--delete", "--mirror", "--force-with-lease", "--no-verify", "-rf", "-fr",
  "--exec", "-exec", "-execdir", "-ok", "--delete-after", "-delete", "--remove-files",
]);

/** `-f` is "force" to git and harmless elsewhere (`tail -f`, `grep -f`): denied for git alone. */
export const DENIED_GIT_FLAGS: ReadonlySet<string> = new Set(["-f"]);

/** Editors that rewrite a file in place with `-i`; `-i` means something harmless to `grep`. */
export const IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl", "ruby", "awk", "gawk"]);
export const IN_PLACE_FLAG = /^(-i\S*|--in-place\S*|-pi|-pie)$/;

/** Interpreters: run with inline code (`-c`, `-e`) what they run is not on the card. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  "python", "python3", "py", "node", "deno", "ruby", "perl", "php", "lua", "tsx", "ts-node", "bun", "osascript",
]);
export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(["-c", "-e", "--eval", "-p", "--print", "-m", "-r", "--command"]);

/** Characters that join commands, redirect output or substitute one command into another. */
export const COMMAND_JOINERS = /[;&|<>`\n\r]|\$\(|\$\{/;

/** Built-in tools that may be remembered as a whole: they read, plan or hand work to a subagent. */
export const REMEMBERABLE_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "Agent", "Task", "Skill", "TodoWrite", "ToolSearch",
]);

/** Tools that are never remembered, whatever their name suggests. */
export const DENIED_TOOLS: ReadonlySet<string> = new Set([
  "AskUserQuestion", "ExitPlanMode", "WebFetch", "WebSearch", "KillShell", "KillBash",
]);

/**
 * Words that mark an MCP tool as acting on the world rather than reading it: sending, publishing,
 * deleting, deploying, writing, paying. A tool named with any of them is never remembered.
 */
export const DENIED_MCP_WORDS = /send|post|publish|delete|remove|destroy|drop|push|deploy|write|create|update|edit|modify|set_|insert|upsert|execute|exec|run|merge|upload|share|forward|tunnel|email|mail|message|slack|reply|comment|transfer|pay|invoice|charge|refund|approve|reject|grant|revoke|invite|kill|stop|start|restart|shutdown|install|move|rename|archive|close|open_|submit|book|order|buy|sell|trade|eval|shell|terminal|browser_|navigate|click|type|fill/i;

/** Path parts a remembered file edit never covers: secrets, git's own folder, PPM's folder. */
export const DENIED_PATH_PARTS = /(^|\/)(\.git|\.ppm|\.ssh|\.aws|\.gnupg|\.cloudflared|node_modules)(\/|$)|(^|\/)\.env(\.|$)|(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|\/|$)|\.(pem|key|p12|pfx|kdbx)$/i;

/** A command whose own name says it ships or publishes something (`deploy.sh`, `release-all`). */
export const DENIED_COMMAND_NAME_WORDS = /deploy|publish|release|push|upload|send/i;

/**
 * Commands whose second word names what they do (`git status`, `bun test`, `make build`): a rule
 * keeps it. For any other command the second word is only an argument (`grep foo`), so a rule
 * covers the command by its name alone.
 */
export const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set([
  "git", "make", "just", "task", "rustup", "conda", "tsc", "turbo", "nx", "vite", "vitest", "jest", "pytest", "ruff", "eslint",
]);
