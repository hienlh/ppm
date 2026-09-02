import { lstat, stat } from "node:fs/promises";
import {
  assertAllowed,
  assertNotProtected,
  resolvePath,
} from "../fs-path-guard.service.ts";

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

function windowsCommand(path: string, isDirectory: boolean): string[] {
  const method = isDirectory ? "DeleteDirectory" : "DeleteFile";
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${psLiteral(path)},'OnlyErrorDialogs','SendToRecycleBin')`;
  const shell = Bun.which("powershell") ?? Bun.which("pwsh");
  if (!shell) throw noTrash("powershell not found on PATH");
  return [shell, "-NoProfile", "-NonInteractive", "-Command", script];
}

/** Paths are always absolute here, so no leading-dash option confusion. */
function posixCommand(path: string): string[] {
  if (process.platform === "darwin") {
    const trash = Bun.which("trash");
    if (trash) return [trash, path];
    const osascript = Bun.which("osascript");
    if (!osascript) throw noTrash("neither trash nor osascript found on PATH");
    return [osascript, "-e", `tell application "Finder" to delete POSIX file ${osaLiteral(path)}`];
  }
  const gio = Bun.which("gio");
  if (gio) return [gio, "trash", path];
  const trashPut = Bun.which("trash-put");
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
  options?: { run?: TrashRunner },
): Promise<{ trashed: true; path: string }> {
  const target = resolvePath(path);
  assertAllowed(target);
  await assertNotProtected(target);
  const isDir = await isDirectoryTarget(target);

  const cmd =
    process.platform === "win32" ? windowsCommand(target, isDir) : posixCommand(target);

  const run = options?.run ?? spawnRunner;
  let result: { exitCode: number; stderr: string };
  try {
    result = await run(cmd);
  } catch (e) {
    throw noTrash((e as Error).message);
  }
  if (result.exitCode !== 0) {
    throw noTrash(result.stderr.trim() || `exit code ${result.exitCode}`);
  }
  return { trashed: true, path: target };
}
