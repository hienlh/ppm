/**
 * Where the MediaMTX install lives, and how the binary is found.
 *
 * Everything PPM downloads sits under `<ppm dir>/mediamtx/` so uninstall is one `rm -rf` and
 * an isolated `PPM_HOME` (tests) never touches a real install.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";

export const mediamtxDir = () => resolve(getPpmDir(), "mediamtx");
export const mediamtxBinDir = () => resolve(mediamtxDir(), "bin");
export const mediamtxTmpDir = () => resolve(mediamtxDir(), "tmp");

/**
 * The generated runtime config. PPM writes this on every start and never uses the
 * `mediamtx.yml` that ships inside the archive: that one listens on every interface and
 * enables RTMP, HLS, SRT and MoQ, where PPM needs one loopback RTSP ingest and nothing else.
 *
 * One file per relay, named by its stream path. MediaMTX watches its config file and reloads
 * when it changes, so with one shared file a second session's start rewrote the first relay's
 * config under it — measured, the first relay stopped answering the moment the second came up.
 */
export const mediamtxConfigPath = (pathName: string) => resolve(mediamtxDir(), "run", `${pathName}.yml`);

export const mediamtxBinaryName = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? "mediamtx.exe" : "mediamtx";

/** The copy PPM installed, or null. The archive is flat, so this is one lookup. */
export function findBundledMediamtx(platform: NodeJS.Platform = process.platform): string | null {
  const candidate = resolve(mediamtxBinDir(), mediamtxBinaryName(platform));
  return existsSync(candidate) ? candidate : null;
}

export interface MediamtxBinary {
  path: string;
  /** `bundled` = installed by PPM and removable from Settings; `system` = the host's own. */
  source: "bundled" | "system";
}

/**
 * A host's own copy is accepted as a fallback because the release publishes no Windows ARM
 * build (`mediamtx-catalog.ts`), so on that host bringing your own is the only route. PPM
 * still generates the config either way, so a system copy cannot drag in its own listeners.
 */
export function findMediamtxBinary(platform: NodeJS.Platform = process.platform): MediamtxBinary | null {
  const bundled = findBundledMediamtx(platform);
  if (bundled) return { path: bundled, source: "bundled" };
  const onPath = Bun.which(mediamtxBinaryName(platform));
  return onPath ? { path: onPath, source: "system" } : null;
}
