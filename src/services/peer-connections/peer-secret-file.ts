/**
 * Secret files for peer connections, kept in the PPM directory beside the database and named
 * after it (`ppm.db` → `<name>.ppm.<ext>`, `ppm.dev.db` → `<name>.ppm.dev.<ext>`), so a dev server
 * and the live one never share an identity.
 *
 * Unlike the design share secret, a damaged file is never replaced, and a missing one is created
 * only while no peer state exists yet: a new identity or storage key would silently break every
 * existing connection (sealed rows would no longer open, peers would refuse every signature), so
 * the error is surfaced instead.
 */
import { basename, resolve } from "node:path";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { getPpmDir } from "../ppm-dir.ts";
import { getDb, getDbPath } from "../db.service.ts";

export class PeerKeyFileError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${basename(path)}: ${reason}. Peer connections cannot be used until it is restored from a backup or the connections are removed.`);
    this.name = "PeerKeyFileError";
  }
}

/** `ppm` for `ppm.db`, `ppm.dev` for `ppm.dev.db`. */
export function peerDbStem(): string {
  return basename(getDbPath()).replace(/\.db$/, "");
}

export function peerSecretPath(name: string, ext: string): string {
  return resolve(getPpmDir(), `${name}.${peerDbStem()}.${ext}`);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return false;
    throw e;
  }
}

/** True once anything was stored that depends on the identity and the storage key. */
export function peerStateExists(): boolean {
  try {
    const row = getDb().query(`SELECT EXISTS (SELECT 1 FROM peer_connections) OR EXISTS (SELECT 1 FROM peer_invites)
      OR EXISTS (SELECT 1 FROM peer_relay_mailboxes) AS found`).get() as { found: number } | null;
    return row?.found === 1;
  } catch (e) {
    // Tables not there yet: nothing depends on the files. Anything else (a busy database) must not
    // be read as "no state", or a new key would be made over existing connections.
    if (e instanceof Error && /no such table/i.test(e.message)) return false;
    throw e;
  }
}

/**
 * Write `content` to a new file, 0600. Written in full to a private temporary file and then
 * linked into place, so a crash never leaves a half-written file under the real name, and two
 * processes starting at once cannot both win: false means another one got there first and its
 * content stands.
 */
export function createSecretFile(path: string, content: Uint8Array | string): boolean {
  mkdirSync(getPpmDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Read a secret file, waiting briefly while another process that claimed it is still writing.
 * `accept` decides whether the content is complete; a file that never becomes acceptable throws.
 */
export function readSecretFile<T>(path: string, accept: (data: Buffer) => T | null, reason: string): T {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = accept(readFileSync(path));
    if (value !== null) return value;
    pause(5);
  }
  throw new PeerKeyFileError(path, reason);
}
