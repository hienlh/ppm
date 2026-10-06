/**
 * SSH host keys PPM has seen, trusted the first time.
 *
 * `<ppm dir>/ssh/known_hosts`, in OpenSSH's own format (`[host]:port type key`), so `ssh-keygen
 * -lf` reads it and a line can be deleted by hand. A host PPM has never reached is recorded on the
 * first connection and the Test result shows its fingerprint; after that, a key that is not the
 * recorded one is refused. A changed key is what a machine in the middle looks like, and also what
 * a reinstalled server looks like — only the person can tell which, so the refusal names the file
 * and the line to remove.
 *
 * Kept apart from `~/.ssh/known_hosts` on purpose: PPM runs as a service as often as not, and
 * writing into a person's own file from one is a surprise.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { DEFAULT_SSH_PORT } from "../../shared/db-connection-config.ts";

const log = createLogger("db");

/** Changed keys already logged: every connection attempt checks again and is refused the same way. */
const loggedChanges = new Set<string>();

export function knownHostsPath(): string {
  return path.join(getPpmDir(), "ssh", "known_hosts");
}

/** How OpenSSH names a host in `known_hosts`: bare on port 22, `[host]:port` on any other. */
export function knownHostName(host: string, port: number): string {
  const name = host.toLowerCase();
  return port === DEFAULT_SSH_PORT ? name : `[${name}]:${port}`;
}

/** `SHA256:…` without padding, as `ssh-keygen -l` prints it. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** The key type an SSH public key blob starts with: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`. */
export function hostKeyType(key: Buffer): string | null {
  if (key.length < 5) return null;
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 64 || 4 + length > key.length) return null;
  const type = key.subarray(4, 4 + length).toString("latin1");
  return /^[A-Za-z0-9@._-]+$/.test(type) ? type : null;
}

export type HostKeyCheck =
  | { status: "known"; fingerprint: string }
  | { status: "added"; fingerprint: string }
  /** `lines` are the file's 1-based line numbers holding a different key for the host. */
  | { status: "changed"; fingerprint: string; recorded: string[]; lines: number[] };

interface KnownEntry {
  names: string[];
  key: string;
  line: number;
}

/** The plain entries. Hashed names (`|1|…`) and `@cert-authority` / `@revoked` lines are OpenSSH's; PPM writes neither. */
function readEntries(file: string): KnownEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: KnownEntry[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) return;
    const [names, , key] = line.split(/\s+/);
    if (!names || !key) return;
    entries.push({ names: names.split(",").map((n) => n.toLowerCase()), key, line: index + 1 });
  });
  return entries;
}

/**
 * Check the key `host:port` showed, recording it when the host is new. Synchronous: ssh2 asks in
 * the middle of its handshake, and the file is a few lines long.
 */
export function checkHostKey(host: string, port: number, key: Buffer): HostKeyCheck {
  const file = knownHostsPath();
  const name = knownHostName(host, port);
  const fingerprint = hostKeyFingerprint(key);
  const blob = key.toString("base64");
  const recorded = readEntries(file).filter((e) => e.names.includes(name));
  if (recorded.some((e) => e.key === blob)) return { status: "known", fingerprint };
  if (recorded.length > 0) {
    const changed: Extract<HostKeyCheck, { status: "changed" }> = {
      status: "changed",
      fingerprint,
      recorded: recorded.map((e) => hostKeyFingerprint(Buffer.from(e.key, "base64"))),
      lines: recorded.map((e) => e.line),
    };
    if (!loggedChanges.has(`${name} ${fingerprint}`)) {
      loggedChanges.add(`${name} ${fingerprint}`);
      log.warn(
        `SSH host key for ${name} changed: got ${fingerprint}, ${file} line(s) ${changed.lines.join(", ")} ` +
        `hold ${changed.recorded.join(", ")} — refused`,
      );
    }
    return changed;
  }
  const type = hostKeyType(key) ?? "ssh-unknown";
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${name} ${type} ${blob}\n`, { mode: 0o600 });
  log.info(`trusted new SSH host key for ${name}: ${type} ${fingerprint} (${file})`);
  return { status: "added", fingerprint };
}
