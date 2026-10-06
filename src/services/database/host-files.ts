/**
 * Files a connection names on the PPM host — the SSH key, the SSL certificates — read each time a
 * connection opens and never copied into `ppm.db`, so replacing one on disk needs no edit.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isAllowedPath, resolvePath } from "../fs-path-guard.service.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";

/** Far above any key or certificate; a CA bundle is a few hundred KB. */
const MAX_BYTES = 2 * 1024 * 1024;

export class HostFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostFileError";
  }
}

/** The file at `file` (`~` is the PPM host's home). `what` names it in the error: "CA certificate". */
export function readHostFile(file: string, what: string): Buffer {
  const text = file.trim();
  // Relative to the server's working folder, which for the service unit is PPM's own.
  if (!path.isAbsolute(text) && text !== "~" && !/^~[\\/]/.test(text)) {
    throw new HostFileError(`Give the ${what} as a full path on the PPM host, not ${file}.`);
  }
  const resolved = resolvePath(text);
  // A Windows share (`\\host\share`) would make PPM open a connection to whoever named it.
  if (!isAllowedPath(resolved)) throw new HostFileError(`PPM does not read the ${what} from a network share (${file}).`);
  // The folders holding PPM's own credentials (its directory, its database snapshots,
  // `~/.cloudflared`) are refused by every file route; a connection must not be the way around
  // that, by its literal path or through a symlink.
  if (isCredentialPath(resolved) || isCredentialPath(realPathOrSelfSync(resolved))) {
    throw new HostFileError(`PPM does not read the ${what} from a folder holding its own credentials (${file}). Keep it somewhere else.`);
  }
  let why: string;
  try {
    // Checked before reading: a FIFO or `/dev/zero` would hold the server's only thread for good.
    const stat = statSync(resolved);
    if (stat.isDirectory()) why = "that is a folder";
    else if (!stat.isFile()) why = "that is not a regular file";
    else if (stat.size > MAX_BYTES) why = `it is ${(stat.size / 1024 / 1024).toFixed(1)} MB, far too big for a key or certificate`;
    else return readFileSync(resolved);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    why = code === "ENOENT" ? "no such file on the PPM host"
      : code === "EACCES" || code === "EPERM" ? "PPM is not allowed to read it"
      : (e as Error).message;
  }
  throw new HostFileError(`Cannot read the ${what} ${file}: ${why}`);
}
