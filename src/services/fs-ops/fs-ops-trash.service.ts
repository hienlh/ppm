import { lstat, stat } from "node:fs/promises";
import {
  assertAllowed,
  assertNotPpmSubtreeDeep,
  assertNotProtected,
  resolvePath,
} from "../fs-path-guard.service.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("fs");

/**
 * Move an entry to the OS trash. Every backend is an external program
 * (PowerShell / Finder / gio), so failure is expected on headless or locked
 * down machines: it surfaces as NO_TRASH and the client then asks whether to
 * delete permanently. Falling back to `rm` silently would turn an undoable
 * action into an irreversible one.
 */

export type TrashRunner = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

const TRASH_TIMEOUT_MS = 10_000;

function noTrash(reason: string): Error {
  return Object.assign(new Error(`No OS trash backend available: ${reason}`), {
    status: 409,
    code: "NO_TRASH",
  });
}

/** Default runner — argv array only, never an interpolated shell string. */
const spawnRunner: TrashRunner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TRASH_TIMEOUT_MS);
  try {
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** Single-quoted PowerShell literal — the only escape inside is a doubled quote. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** AppleScript string literal. */
function osaLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * How a backend binary is found, replaceable for the same reason `TrashRunner` is.
 *
 * Which tool is present is as much a property of the host as what running it does, and
 * leaving the lookup outside the seam meant a test could fake the run and still be refused
 * before reaching it — on any machine without `gio` or `trash-put`, which includes the
 * container the suite runs in.
 */
export type TrashLookup = (name: string) => string | null;

const defaultLookup: TrashLookup = (name) => Bun.which(name);

function windowsCommand(path: string, isDirectory: boolean, which: TrashLookup): string[] {
  const method = isDirectory ? "DeleteDirectory" : "DeleteFile";
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${psLiteral(path)},'OnlyErrorDialogs','SendToRecycleBin')`;
  const shell = which("powershell") ?? which("pwsh");
  if (!shell) throw noTrash("powershell not found on PATH");
  return [shell, "-NoProfile", "-NonInteractive", "-Command", script];
}

/** Paths are always absolute here, so no leading-dash option confusion. */
function posixCommand(path: string, which: TrashLookup): string[] {
  if (process.platform === "darwin") {
    const trash = which("trash");
    if (trash) return [trash, path];
    const osascript = which("osascript");
    if (!osascript) throw noTrash("neither trash nor osascript found on PATH");
    return [osascript, "-e", `tell application "Finder" to delete POSIX file ${osaLiteral(path)}`];
  }
  const gio = which("gio");
  if (gio) return [gio, "trash", path];
  const trashPut = which("trash-put");
  if (trashPut) return [trashPut, path];
  throw noTrash("neither gio nor trash-put found on PATH");
}

/** True when the entry should be handed to the directory-flavoured backend. */
async function isDirectoryTarget(path: string): Promise<boolean> {
  const link = await lstat(path);
  if (!link.isSymbolicLink()) return link.isDirectory();
  // A link is deleted as a link; the target's type only picks the API flavour.
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

export async function trashPath(
  path: string,
  options?: { run?: TrashRunner; which?: TrashLookup },
): Promise<{ trashed: true; path: string }> {
  const target = resolvePath(path);
  assertAllowed(target);
  // Same shield as the permanent delete: the Recycle Bin is still a removal.
  await assertNotPpmSubtreeDeep(target);
  await assertNotProtected(target);
  const isDir = await isDirectoryTarget(target);

  const which = options?.which ?? defaultLookup;
  // NO_TRASH answers 409, and the client then offers a permanent delete: the reason and the
  // backend are only in these lines.
  let cmd: string[];
  try {
    cmd = process.platform === "win32" ? windowsCommand(target, isDir, which) : posixCommand(target, which);
  } catch (e) {
    log.warn(`trash unavailable for ${target}: ${(e as Error).message}`);
    throw e;
  }

  const run = options?.run ?? spawnRunner;
  let result: { exitCode: number; stderr: string };
  try {
    result = await run(cmd);
  } catch (e) {
    log.warn(`trash unavailable for ${target}: ${(e as Error).message} (backend ${cmd[0]})`);
    throw noTrash((e as Error).message);
  }
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || `exit code ${result.exitCode}`;
    log.warn(`trash unavailable for ${target}: ${reason.split("\n")[0]} (backend ${cmd[0]})`);
    throw noTrash(reason);
  }
  log.info(`moved ${target} to trash via ${cmd[0]}`);
  return { trashed: true, path: target };
}
