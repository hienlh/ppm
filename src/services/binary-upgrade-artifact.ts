/**
 * Maps the running platform/arch to the GitHub release artifact name and builds
 * the download URLs. Pure + param-driven so the full matrix is unit-testable
 * without touching `process.*`.
 *
 * Artifact names + packaging mirror `scripts/release.sh` TARGETS and
 * `scripts/install.sh` detection. The release OS token is `linux`/`darwin`/
 * `windows` (NOT node's `win32`); arch is `x64`/`arm64`.
 */

const GH_RELEASE_BASE = "https://github.com/hienlh/ppm/releases/download";

export interface BinaryArtifact {
  /** Bare artifact name without extension, e.g. `ppm-windows-x64`. */
  artifact: string;
  /** Archive extension: `tar.gz` (Unix) or `zip` (Windows). */
  ext: "tar.gz" | "zip";
}

/** Node `process.platform` → release OS token. */
function osToken(platform: NodeJS.Platform): "linux" | "darwin" | "windows" | null {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "windows";
  return null;
}

/**
 * Resolve the release artifact for a platform/arch pair.
 * Throws for combinations that PPM does not publish a binary for.
 */
export function getBinaryArtifact(
  platform: NodeJS.Platform,
  arch: string,
): BinaryArtifact {
  const os = osToken(platform);
  if (!os) throw new Error(`Unsupported platform for binary upgrade: ${platform}`);

  // Published matrix: darwin arm64/x64, linux x64/arm64, windows x64.
  const supported: Record<string, Array<"x64" | "arm64">> = {
    darwin: ["arm64", "x64"],
    linux: ["x64", "arm64"],
    windows: ["x64"],
  };
  if (!supported[os]!.includes(arch as "x64" | "arm64")) {
    throw new Error(`Unsupported arch for binary upgrade: ${platform}/${arch}`);
  }

  return {
    artifact: `ppm-${os}-${arch}`,
    ext: os === "windows" ? "zip" : "tar.gz",
  };
}

/** Full download URL of the archive for a given version. */
export function buildAssetUrl(version: string, artifact: string, ext: string): string {
  return `${GH_RELEASE_BASE}/v${version}/${artifact}.${ext}`;
}

/** URL of the `SHA256SUMS` manifest published alongside the archives. */
export function buildSha256SumsUrl(version: string): string {
  return `${GH_RELEASE_BASE}/v${version}/SHA256SUMS`;
}
