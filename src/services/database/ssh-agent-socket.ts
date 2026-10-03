/**
 * Which SSH agent the PPM host has, if any.
 *
 * `SSH_AUTH_SOCK` is not enough. A PPM started by its systemd unit, or by launchd, gets none even
 * while the desktop it runs beside has an agent, so the per-user sockets the common agents create
 * are looked for as well. Without this the SSH agent option fails with ssh2's "Failed to connect
 * to agent", which says nothing about why.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** Relative to the user's runtime directory: systemd's own agent unit, GNOME (gcr, then keyring), gpg-agent. */
const RUNTIME_SOCKETS = ["ssh-agent.socket", "gcr/ssh", "keyring/ssh", "gnupg/S.gpg-agent.ssh"];

/** The Windows OpenSSH agent service's pipe. */
const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

function isSocket(file: string): boolean {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
}

/** Where the per-user agent sockets live: the session's runtime directory, and systemd's for this uid. */
function runtimeDirsOf(env: NodeJS.ProcessEnv): string[] {
  const dirs = new Set<string>();
  if (env.XDG_RUNTIME_DIR) dirs.add(env.XDG_RUNTIME_DIR);
  const uid = process.getuid?.();
  if (uid !== undefined) dirs.add(`/run/user/${uid}`);
  return [...dirs];
}

/** The agent socket (a named pipe on Windows) to authenticate with, or null when the host has none. */
export function findSshAgent(env: NodeJS.ProcessEnv = process.env, runtimeDirs: string[] = runtimeDirsOf(env)): string | null {
  const given = env.SSH_AUTH_SOCK?.trim();
  if (process.platform === "win32") {
    if (given) return given;
    return existsSync(WINDOWS_AGENT_PIPE) ? WINDOWS_AGENT_PIPE : null;
  }
  if (given && isSocket(given)) return given;
  for (const dir of runtimeDirs) {
    for (const name of RUNTIME_SOCKETS) {
      const candidate = path.join(dir, name);
      if (isSocket(candidate)) return candidate;
    }
  }
  return null;
}
