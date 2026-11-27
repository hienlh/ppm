/**
 * Secret files for peer connections, kept in the PPM directory beside the database and named
 * after it (`ppm.db` → `<name>.ppm.<ext>`, `ppm.dev.db` → `<name>.ppm.dev.<ext>`), so a dev server
 * and the live one never share an identity.
 *
 * Unlike the design share secret, a damaged file is never replaced: a new identity or storage key
 * would silently break every existing connection, so the error is surfaced instead.
 */
import { basename, resolve } from "node:path";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { getPpmDir } from "../ppm-dir.ts";
import { getDbPath } from "../db.service.ts";

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

/**
 * Write `content` to a new file, 0600. Claimed with `wx`, so two processes starting at once
 * cannot both write: false means another one got there first and its content stands.
 */
export function createSecretFile(path: string, content: Uint8Array | string): boolean {
  mkdirSync(getPpmDir(), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  } finally {
    closeSync(fd);
  }
  return true;
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
