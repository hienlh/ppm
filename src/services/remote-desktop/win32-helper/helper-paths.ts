/**
 * Names and places of the Windows remote-desktop helper: a few Task Scheduler tasks that run a
 * fixed PowerShell script as SYSTEM, so PPM (which never runs as an administrator) can bring
 * its own disconnected session back to the console without a monitor or a person at the PC.
 *
 * Everything the SYSTEM side reads or writes lives under Program Files, where a normal user can
 * create, rename or replace nothing. That includes the state files: under ProgramData a user
 * can pre-create the folder and swap a child for a junction, and a SYSTEM write would then land
 * wherever the junction points.
 */
import { join, win32 } from "node:path";
import { getPpmDir } from "../../ppm-dir.ts";

/** Bumped whenever the generated scripts change, so an older install reports "update needed". */
export const HELPER_VERSION = 2;

/** Each action is its own task with a fixed command line: a task cannot be handed anything. */
export const HELPER_ACTIONS = ["Reattach", "DisplayOn", "DisplayOff"] as const;
export type HelperAction = typeof HELPER_ACTIONS[number];

/** One top-level folder. Not `\PPM\…`: `\PPM` is already PPM's own autostart *task* on every
 *  Windows install, so a folder of that name cannot exist (found on a real host — registering
 *  under `\PPM\RemoteDesktop\` failed with "path not found", creating `\PPM` with "already exists"). */
export const TASK_FOLDER_NAME = "PPM-RemoteDesktop";
export const TASK_FOLDER = `\\${TASK_FOLDER_NAME}\\`;
export function taskName(action: HelperAction): string {
  return `${TASK_FOLDER}${action}`;
}

function systemRoot(): string {
  return process.env.SystemRoot || "C:\\Windows";
}

/** Always the absolute path: a task or an elevated launch must not resolve PowerShell on PATH. */
export function powershellExe(): string {
  return win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function schtasksExe(): string {
  return win32.join(systemRoot(), "System32", "schtasks.exe");
}

export function whoamiExe(): string {
  return win32.join(systemRoot(), "System32", "whoami.exe");
}

export interface HelperPaths {
  /** `%ProgramFiles%\PPM\RemoteDesktopHelper` — admin-writable only. */
  installDir: string;
  helperScript: string;
  stateDir: string;
  installRecord: string;
  lastRun: string;
  log: string;
  /** Where PPM (unelevated) stages the payload the elevated bootstrap reads and re-verifies. */
  stagingDir: string;
}

export function helperPaths(): HelperPaths {
  const installDir = win32.join(process.env.ProgramFiles || "C:\\Program Files", "PPM", "RemoteDesktopHelper");
  const stateDir = win32.join(installDir, "state");
  return {
    installDir,
    helperScript: win32.join(installDir, "helper.ps1"),
    stateDir,
    installRecord: win32.join(stateDir, "install.json"),
    lastRun: win32.join(stateDir, "last-run.json"),
    log: win32.join(stateDir, "helper.log"),
    stagingDir: join(getPpmDir(), "remote-desktop-helper"),
  };
}
