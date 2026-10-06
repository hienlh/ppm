/**
 * Atomic on-disk swap of the PPM binary + its `web/` dir, plus cleanup of the
 * stale `.old` files a Windows swap leaves behind.
 *
 * Unix can overwrite a running executable in place (the process keeps its open
 * inode; a re-spawn of the same path loads the new file). Windows locks a
 * running `.exe`, so the current binary is renamed aside to `*.old` first and
 * deleted on the next supervisor boot once the old process is gone.
 *
 * `renameSync` is atomic only within a filesystem, so callers must stage the
 * payload on the same volume as the target (temp dir under the PPM dir).
 */
import { renameSync, rmSync, chmodSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLogger } from "./logger.ts";

const log = createLogger("upgrade");

export const OLD_SUFFIX = ".old";

/**
 * Replace the live binary + web dir with the freshly extracted payload.
 *
 * @param payloadRoot dir containing the new `ppm`/`ppm.exe` + `web/`
 * @param execPath    absolute path of the binary to replace (`process.execPath`)
 * @param webDir      absolute path of the web dir beside it
 * @param platform    injected for cross-platform unit testing (default: host)
 */
export function swapBinaryAndWeb(
  payloadRoot: string,
  execPath: string,
  webDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const binName = platform === "win32" ? "ppm.exe" : "ppm";
  const newBinary = resolve(payloadRoot, binName);
  const newWeb = resolve(payloadRoot, "web");

  // Swap web/ first: a failure here must not touch the binary, so the install
  // stays bootable (worst case a version skew, never a missing binary).
  const oldWeb = webDir + OLD_SUFFIX;
  try { rmSync(oldWeb, { recursive: true, force: true }); } catch {}
  const hadWeb = existsSync(webDir);
  if (hadWeb) renameSync(webDir, oldWeb);
  try {
    renameSync(newWeb, webDir);
  } catch (e) {
    // The old web/ is already aside and nothing puts it back: the UI is gone until fixed by hand.
    log.error(`web/ swap failed (${e}): no UI at ${webDir}${hadWeb ? `; previous one left at ${oldWeb}` : ""}`);
    throw e;
  }
  try { rmSync(oldWeb, { recursive: true, force: true }); } catch {}

  if (platform === "win32") {
    // Can't overwrite the running .exe — move it aside, drop the new one in, and
    // restore the old one if that fails so we never leave NO binary at execPath.
    const oldBinary = execPath + OLD_SUFFIX;
    try { rmSync(oldBinary, { force: true }); } catch {}
    renameSync(execPath, oldBinary);
    try {
      renameSync(newBinary, execPath);
    } catch (e) {
      try {
        renameSync(oldBinary, execPath);
        log.warn(`Binary swap failed (${e}) — previous binary restored at ${execPath}`);
      } catch (rollbackErr) {
        log.fatal(`Binary swap failed (${e}) and rollback failed (${rollbackErr}): no binary at ${execPath}; previous binary left at ${oldBinary}`);
      }
      throw e;
    }
  } else {
    renameSync(newBinary, execPath);
    chmodSync(execPath, 0o755);
  }
}

/**
 * Best-effort removal of the `*.old` artifacts a prior Windows upgrade left
 * beside the binary. Runs at supervisor boot; a locked/missing file must never
 * block startup, so every failure is swallowed. No-op off Windows.
 */
export function cleanupStaleBinaryUpgradeArtifacts(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  try { rmSync(join(binDir, "ppm.exe" + OLD_SUFFIX), { force: true }); } catch {}
  try { rmSync(join(binDir, "web" + OLD_SUFFIX), { recursive: true, force: true }); } catch {}
}
