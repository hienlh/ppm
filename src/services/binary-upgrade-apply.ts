/**
 * Orchestrates a binary self-upgrade: resolve the release artifact, guard that
 * the GitHub asset exists, download+verify+extract into a temp dir on the same
 * filesystem as the binary, then atomically swap the binary + web dir.
 *
 * A binary install re-spawns via the supervisor's saved argv, whose argv[0] is
 * the binary path — so replacing the on-disk file is enough for the restart to
 * load the new version. Every failure before the swap leaves the live install
 * untouched (temp is always deleted).
 *
 * `checkFn` is injected (not imported) to avoid a cycle with upgrade.service.ts;
 * the other deps default to the real helpers and are overridable for tests.
 */
import { resolve, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { getBinaryArtifact, buildAssetUrl, buildSha256SumsUrl } from "./binary-upgrade-artifact.ts";
import { headCheckAsset, downloadAndExtract } from "./binary-upgrade-download.ts";
import { swapBinaryAndWeb } from "./binary-upgrade-swap.ts";

export interface UpdateCheck {
  available: boolean;
  current: string;
  latest: string | null;
}

export interface BinaryUpgradeDeps {
  checkFn: () => Promise<UpdateCheck>;
  headCheckFn?: typeof headCheckAsset;
  downloadFn?: typeof downloadAndExtract;
  swapFn?: typeof swapBinaryAndWeb;
  execPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface UpgradeResult {
  success: boolean;
  error?: string;
  newVersion?: string;
}

export async function applyBinaryUpgrade(deps: BinaryUpgradeDeps): Promise<UpgradeResult> {
  const headCheckFn = deps.headCheckFn ?? headCheckAsset;
  const downloadFn = deps.downloadFn ?? downloadAndExtract;
  const swapFn = deps.swapFn ?? swapBinaryAndWeb;
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const update = await deps.checkFn();
  if (!update.available || !update.latest) {
    return { success: false, error: "Already on latest version" };
  }

  let artifact: { artifact: string; ext: "tar.gz" | "zip" };
  try {
    artifact = getBinaryArtifact(platform, arch);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  const assetUrl = buildAssetUrl(update.latest, artifact.artifact, artifact.ext);
  const sha256sumsUrl = buildSha256SumsUrl(update.latest);
  if (!(await headCheckFn(assetUrl))) {
    return { success: false, error: "Release asset not yet available on GitHub — try again shortly" };
  }

  const tmpDir = mkdtempSync(resolve(getPpmDir(), ".upgrade-tmp-"));
  try {
    const payloadRoot = await downloadFn({
      assetUrl,
      sha256sumsUrl,
      artifactFilename: `${artifact.artifact}.${artifact.ext}`,
      ext: artifact.ext,
      tmpDir,
      platform,
    });
    swapFn(payloadRoot, execPath, resolve(dirname(execPath), "web"), platform);
    return { success: true, newVersion: update.latest };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
