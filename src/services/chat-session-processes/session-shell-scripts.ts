/**
 * The two shell scripts that put a chat's processes into its session slice.
 *
 * `run` is the CLI's `CLAUDE_CODE_SHELL_PREFIX`. The CLI calls it with ONE argument, the whole
 * command line it built for its shell (snapshot `source`, the `eval` of the command, the `pwd`
 * that tracks the working directory) — for every Bash tool call, and for every stdio MCP server
 * too. It re-runs that line in the user's shell inside a fresh scope under the session's slice.
 * `systemd-run --scope` execs the command in place, so the pid the CLI holds, the exit code and
 * the process group are all unchanged.
 *
 * `path/systemd-run` stands first on the CLI's PATH. An agent that starts something with
 * `systemd-run --user` (an emulator, a scratch server) would otherwise put it outside the slice,
 * where nothing would ever stop it; the shim adds the session's slice unless the call names a
 * slice itself, which is how a unit that must outlive the chat opts out (`--slice=app.slice`).
 *
 * Both call the real `systemd-run` by its absolute path: the shim is first on PATH, and the
 * prefix must not go through it.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_SCOPE_PREFIX, SLICE_ENV, type SessionShell } from "./session-slice.ts";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function prefixScript(systemdRun: string): string {
  return `#!/bin/sh
# Written by PPM: runs one command of an AI chat inside that chat's systemd slice, so PPM can
# stop whatever the command leaves running. $1 is the whole command line the Claude CLI built.
shell=\${CLAUDE_CODE_SHELL:-\${SHELL:-/bin/bash}}
case "$shell" in */zsh|*/bash) ;; *) shell=/bin/bash ;; esac
[ -n "$${SLICE_ENV}" ] || exec "$shell" -c "$1"
read -r id < /proc/sys/kernel/random/uuid
exec ${quote(systemdRun)} --user --scope --quiet --collect --slice="$${SLICE_ENV}" --unit="${COMMAND_SCOPE_PREFIX}$id" --description="PPM chat command" -- "$shell" -c "$1"
`;
}

export function shimScript(systemdRun: string): string {
  return `#!/bin/sh
# Written by PPM: a \`systemd-run --user\` started by an AI chat lands in that chat's slice, so PPM
# stops it with everything else the chat left running. Naming a slice yourself keeps a unit out.
if [ -n "$${SLICE_ENV}" ]; then
  user=; slice=
  for a in "$@"; do
    case "$a" in
      --) break ;;
      --user) user=1 ;;
      --slice|--slice=*|--slice-inherit) slice=1 ;;
    esac
  done
  if [ -n "$user" ] && [ -z "$slice" ]; then exec ${quote(systemdRun)} --slice="$${SLICE_ENV}" "$@"; fi
fi
exec ${quote(systemdRun)} "$@"
`;
}

function writeIfChanged(path: string, content: string): void {
  let current: string | null = null;
  try { current = readFileSync(path, "utf8"); } catch {}
  if (current !== content) writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** Writes both scripts under `dir` (rewritten only when PPM changed them) and says where they are. */
export function installSessionShell(dir: string, systemdRun: string): SessionShell {
  const pathDir = join(dir, "path");
  mkdirSync(pathDir, { recursive: true });
  const prefix = join(dir, "run");
  writeIfChanged(prefix, prefixScript(systemdRun));
  writeIfChanged(join(pathDir, "systemd-run"), shimScript(systemdRun));
  return { prefix, pathDir };
}
