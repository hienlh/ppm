/**
 * Download + integrity-verify + extract of a GitHub release archive into a temp
 * dir, returning the "payload root" (the dir that directly contains the new
 * `ppm`/`ppm.exe` + `web/`).
 *
 * Packaging is asymmetric (verified against `scripts/release.sh`):
 *   - tar.gz extracts FLAT      → `./ppm` + `./web`
 *   - zip has a top-level dir   → `ppm-windows-x64/ppm.exe` + `ppm-windows-x64/web`
 * so the payload root is located by a depth-≤1 search, not assumed to be the
 * extract root. The SHA-256 check runs BEFORE extraction — a bad hash aborts
 * before anything is unpacked. Temp lifecycle (delete on failure) is owned by
 * the caller.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyChecksum, parseSha256Sums } from "./binary-upgrade-verify.ts";

export type FetchFn = typeof fetch;

export interface DownloadExtractOptions {
  assetUrl: string;
  sha256sumsUrl: string;
  /** Bare archive filename as it appears in SHA256SUMS, e.g. `ppm-windows-x64.zip`. */
  artifactFilename: string;
  ext: "tar.gz" | "zip";
  tmpDir: string;
  platform?: NodeJS.Platform;
  fetchFn?: FetchFn;
}

const HEAD_TIMEOUT_MS = 10_000;
const SUMS_TIMEOUT_MS = 10_000;
const ARCHIVE_TIMEOUT_MS = 120_000;

/** HEAD the asset URL to confirm the GH release actually has it (npm-ahead-of-GH guard). */
export async function headCheckAsset(url: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, { method: "HEAD", signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Find the dir containing `binName` at depth 0 or 1 under `extractRoot`. */
export function locatePayloadRoot(extractRoot: string, binName: string): string {
  if (existsSync(join(extractRoot, binName))) return extractRoot;
  for (const entry of readdirSync(extractRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(extractRoot, entry.name, binName))) {
      return join(extractRoot, entry.name);
    }
  }
  throw new Error(`incomplete extract: ${binName} not found under ${extractRoot}`);
}

async function extractArchive(
  archivePath: string,
  ext: "tar.gz" | "zip",
  destDir: string,
  platform: NodeJS.Platform,
): Promise<void> {
  // Windows ships bsdtar as tar.exe (reads zip); Unix uses gnu tar for tar.gz
  // and unzip for the (rare) zip case.
  const cmd =
    ext === "tar.gz"
      ? ["tar", "-xzf", archivePath, "-C", destDir]
      : platform === "win32"
        ? ["tar", "-xf", archivePath, "-C", destDir]
        : ["unzip", "-o", "-q", archivePath, "-d", destDir];

  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`extract failed (${cmd[0]} exit ${code}): ${errText.slice(0, 200)}`);
  }
}

/**
 * Download the archive, verify its SHA-256 against the SHA256SUMS manifest,
 * extract it, and return the verified payload root. Throws on any failure
 * (download error, checksum mismatch/missing, extract error, missing payload).
 */
export async function downloadAndExtract(opts: DownloadExtractOptions): Promise<string> {
  const { assetUrl, sha256sumsUrl, artifactFilename, ext, tmpDir } = opts;
  const platform = opts.platform ?? process.platform;
  const fetchFn = opts.fetchFn ?? fetch;

  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, `archive.${ext}`);

  const res = await fetchFn(assetUrl, { signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

  const sumsRes = await fetchFn(sha256sumsUrl, { signal: AbortSignal.timeout(SUMS_TIMEOUT_MS) });
  if (!sumsRes.ok) throw new Error(`SHA256SUMS download failed: HTTP ${sumsRes.status}`);
  verifyChecksum(archivePath, parseSha256Sums(await sumsRes.text(), artifactFilename));

  const extractRoot = join(tmpDir, "x");
  mkdirSync(extractRoot, { recursive: true });
  await extractArchive(archivePath, ext, extractRoot, platform);

  const binName = platform === "win32" ? "ppm.exe" : "ppm";
  const payloadRoot = locatePayloadRoot(extractRoot, binName);
  if (!existsSync(join(payloadRoot, "web"))) {
    throw new Error("incomplete extract: web/ missing from payload");
  }
  return payloadRoot;
}
