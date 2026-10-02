/**
 * Where the Android SDK is, and which of its tools this host actually has.
 *
 * Resolution order (plan §5): the path the user configured -> the standard Android env vars ->
 * the per-OS default location -> whatever is on PATH. Everything here is read-only and safe to
 * call when no SDK exists; the answer then carries the reasons, which is what the setup screen
 * renders instead of an indefinite spinner.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export interface SdkTool {
  /** Absolute path to the binary, or null when this host does not have it. */
  path: string | null;
  /** Version string as the tool itself reports it, when it could be run. */
  version: string | null;
}

export interface AndroidSdk {
  root: string | null;
  /** Which step of the resolution order answered, for the setup screen to explain itself. */
  source: "configured" | "env" | "default-location" | "path" | "not-found";
  emulator: SdkTool;
  adb: SdkTool;
  avdmanager: SdkTool;
  sdkmanager: SdkTool;
  /** AVD home in force for this process, and whether it came from the environment. */
  avdHome: string;
  avdHomeFromEnv: boolean;
}

const exe = (name: string) => (platform() === "win32" ? `${name}.exe` : name);
const bat = (name: string) => (platform() === "win32" ? `${name}.bat` : name);

/** Per-OS default SDK locations, in the order Android's own tooling looks. */
function defaultSdkLocations(): string[] {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [join(home, "Library", "Android", "sdk")];
    case "win32":
      return [
        join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Android", "Sdk"),
      ];
    default:
      return [join(home, "Android", "Sdk"), join(home, "android-sdk")];
  }
}

function looksLikeSdk(dir: string): boolean {
  // An SDK root always has at least one of these; a bare directory that merely exists does not.
  return existsSync(join(dir, "emulator")) || existsSync(join(dir, "platform-tools"));
}

/**
 * The AVD home this process would use.
 *
 * `ANDROID_AVD_HOME` **replaces** the default rather than adding to it — measured: with it set,
 * `emulator -list-avds` shows only the AVDs under it and the user's own disappear entirely. So
 * PPM must never set it process-wide; it is read here only to report what is in force.
 */
export function resolveAvdHome(): { dir: string; fromEnv: boolean } {
  const env = process.env.ANDROID_AVD_HOME?.trim();
  if (env) return { dir: resolve(env), fromEnv: true };
  return { dir: join(homedir(), ".android", "avd"), fromEnv: false };
}

/**
 * The env an SDK **child process** needs to work in a given AVD home.
 *
 * `ANDROID_AVD_HOME` **replaces** the default rather than adding to it (measured in Phase 0), so
 * PPM must never set it process-wide — but a child that is meant to act on a non-default home
 * has no other way to be told. Measured the hard way: `avdmanager create avd` without this
 * writes into **`~/.android/avd`**, i.e. straight into the user's own AVDs, whatever home PPM
 * was asked to use.
 *
 * Left unset when the home already *is* the default, so the common case runs with the exact
 * environment the tools expect.
 */
export function avdHomeEnv(avdHome: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const defaultHome = join(homedir(), ".android", "avd");
  if (avdHome && resolve(avdHome) !== defaultHome) env.ANDROID_AVD_HOME = resolve(avdHome);
  return env;
}

async function toolVersion(path: string, args: string[], pick: (out: string) => string | null): Promise<string | null> {
  try {
    const proc = Bun.spawn([path, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [out, errOut] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return pick(`${out}\n${errOut}`);
  } catch {
    // Bun.spawn THROWS synchronously on a missing binary rather than reporting it (see
    // `host-info/spawn-runner.ts`), and the throw escapes an awaited try placed further out.
    return null;
  }
}

function firstLine(out: string): string | null {
  const line = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? null;
}

async function describeTool(
  candidate: string | null,
  args: string[],
  pick: (out: string) => string | null,
): Promise<SdkTool> {
  if (!candidate || !existsSync(candidate)) return { path: null, version: null };
  return { path: candidate, version: await toolVersion(candidate, args, pick) };
}

/** Resolve the SDK and probe its tools. Never throws: a host with no SDK gets a populated shape. */
export async function discoverSdk(configuredRoot?: string | null): Promise<AndroidSdk> {
  let root: string | null = null;
  let source: AndroidSdk["source"] = "not-found";

  const configured = configuredRoot?.trim();
  if (configured && looksLikeSdk(configured)) {
    root = resolve(configured);
    source = "configured";
  }
  if (!root) {
    for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
      const v = process.env[key]?.trim();
      if (v && looksLikeSdk(v)) { root = resolve(v); source = "env"; break; }
    }
  }
  if (!root) {
    for (const dir of defaultSdkLocations()) {
      if (looksLikeSdk(dir)) { root = dir; source = "default-location"; break; }
    }
  }

  // PATH is the last resort and only for adb: a loose `adb` on PATH (Linux distros package it
  // separately from the SDK) is usable even when no SDK root exists.
  const pathAdb = Bun.which("adb");
  if (!root && pathAdb) source = "path";

  const emulatorPath = root ? join(root, "emulator", exe("emulator")) : null;
  const adbPath = root && existsSync(join(root, "platform-tools", exe("adb")))
    ? join(root, "platform-tools", exe("adb"))
    : pathAdb;
  const cmdlineBin = root ? join(root, "cmdline-tools", "latest", "bin") : null;

  const [emulator, adb, avdmanager, sdkmanager] = await Promise.all([
    describeTool(emulatorPath, ["-version"], (o) =>
      o.split("\n").find((l) => l.includes("Android emulator version"))?.trim() ?? null),
    describeTool(adbPath, ["version"], firstLine),
    describeTool(cmdlineBin ? join(cmdlineBin, bat("avdmanager")) : null, ["list", "target"],
      () => "present"),
    describeTool(cmdlineBin ? join(cmdlineBin, bat("sdkmanager")) : null, ["--version"], firstLine),
  ]);

  const avdHome = resolveAvdHome();
  return {
    root, source, emulator, adb, avdmanager, sdkmanager,
    avdHome: avdHome.dir, avdHomeFromEnv: avdHome.fromEnv,
  };
}

/** Whether an AVD's config.ini enables the hardware keyboard. */
export function avdHasHardwareKeyboard(avdConfigIni: string): boolean {
  try {
    for (const line of readFileSync(avdConfigIni, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith("hw.keyboard=")) return t.slice("hw.keyboard=".length).trim() === "yes";
    }
  } catch {
    // An unreadable config is reported as "no" so the UI warns rather than promising a keyboard.
  }
  return false;
}
