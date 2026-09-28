/**
 * Where the Whisper install lives, and how the binary is found.
 *
 * Everything PPM downloads sits under `<ppm dir>/whisper/` so uninstall is one
 * `rm -rf` and an isolated `PPM_HOME` (tests) never touches a real install.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";

export const whisperDir = () => resolve(getPpmDir(), "whisper");
export const whisperBinDir = () => resolve(whisperDir(), "bin");
export const whisperModelDir = () => resolve(whisperDir(), "models");
export const whisperTmpDir = () => resolve(whisperDir(), "tmp");

export const cliName = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

/**
 * The extracted archive keeps its own top-level directory — `whisper-bin-ubuntu-x64/`
 * on Linux, `Release/` on Windows — and those names carry the build tag, so the
 * binary is located by looking one level down rather than assumed.
 */
export function findBundledBinary(platform: NodeJS.Platform = process.platform): string | null {
  const root = whisperBinDir();
  if (!existsSync(root)) return null;
  const name = cliName(platform);
  if (existsSync(resolve(root, name))) return resolve(root, name);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = resolve(root, entry.name, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Homebrew's `whisper.cpp` is how a Mac gets a `whisper-cli` (the release has no
 * macOS CLI to download), and a PPM started by launchd/systemd inherits a PATH
 * that usually has neither Homebrew prefix in it — so both are checked directly
 * rather than trusting `PATH` alone.
 */
const SYSTEM_PATHS = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", "/usr/bin/whisper-cli"];

export function findSystemBinary(): string | null {
  const onPath = Bun.which("whisper-cli");
  if (onPath) return onPath;
  return SYSTEM_PATHS.find((p) => existsSync(p)) ?? null;
}

export interface WhisperBinary {
  path: string;
  /** `bundled` = installed by PPM and removable from Settings; `system` = the host's own. */
  source: "bundled" | "system";
}

export function findWhisperBinary(platform: NodeJS.Platform = process.platform): WhisperBinary | null {
  const bundled = findBundledBinary(platform);
  if (bundled) return { path: bundled, source: "bundled" };
  const system = findSystemBinary();
  return system ? { path: system, source: "system" } : null;
}
