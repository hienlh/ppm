/**
 * "Can this host run an Android emulator, and if not, exactly what is missing?"
 *
 * Every negative answer carries a reason and, where one exists, the command that fixes it. Plan
 * §6: the empty state must distinguish no SDK, no emulator/system image, no AVD, and unusable
 * acceleration — never an indefinite spinner.
 */
import { discoverSdk, resolveAvdHome, type AndroidSdk } from "./sdk-discovery.ts";
import { listAvds } from "./avd-list.ts";
import { workingEncoders } from "../media-transcode/ffmpeg-capabilities.ts";

export interface AndroidRequirement {
  id: string;
  label: string;
  met: boolean;
  detail: string;
  /** A command the user can run to fix it, when one exists. Never executed by PPM. */
  fix: string | null;
}

export interface AndroidCapabilities {
  enabled: boolean;
  sdk: AndroidSdk;
  avdCount: number;
  /** H.264 encoders that really encode on this host, preference order. */
  encoders: string[];
  accelerationOk: boolean;
  accelerationDetail: string;
  requirements: AndroidRequirement[];
  ready: boolean;
}

/**
 * `emulator -accel-check` reports whether the host's hypervisor is usable. Without it an
 * emulator still "starts" and then runs at a speed nobody would call working, so this is a
 * requirement rather than a hint.
 */
async function checkAcceleration(emulatorPath: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!emulatorPath) return { ok: false, detail: "no emulator binary" };
  try {
    const proc = Bun.spawn([emulatorPath, "-accel-check"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [out, errOut] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    // `-accel-check` prints a marker line, an exit code, the human-readable verdict, then the
    // marker again — e.g. "accel:", "0", "KVM (version 12) is installed and usable.", "accel".
    // Taking the last line yields the bare marker, so pick the sentence instead.
    const lines = `${out}${errOut}`.split("\n").map((l) => l.trim()).filter(Boolean);
    const sentence = lines.filter((l) => l !== "accel" && l !== "accel:" && !/^-?\d+$/.test(l))
      .sort((a, b) => b.length - a.length)[0];
    return { ok: code === 0, detail: sentence || (code === 0 ? "usable" : "not usable") };
  } catch {
    // Bun.spawn throws synchronously when the binary is missing.
    return { ok: false, detail: "emulator binary could not be run" };
  }
}

export async function androidCapabilities(
  opts: { enabled: boolean; configuredSdkRoot?: string | null },
): Promise<AndroidCapabilities> {
  // Off — the default — answers without looking at the SDK at all. Every page load asks (the nav
  // rail and the mobile drawer decide from `enabled` whether to show the entry), and looking runs
  // `emulator` twice, `adb` and two JVMs (`avdmanager`, `sdkmanager`) on a host that has an SDK.
  if (!opts.enabled) return disabledCapabilities();

  const sdk = await discoverSdk(opts.configuredSdkRoot ?? null);
  const avds = sdk.root ? listAvds(sdk.avdHome) : [];
  const [accel, encoders] = await Promise.all([
    checkAcceleration(sdk.emulator.path),
    workingEncoders(),
  ]);

  const requirements: AndroidRequirement[] = [
    {
      id: "sdk",
      label: "Android SDK",
      met: !!sdk.root,
      detail: sdk.root ? `${sdk.root} (found via ${sdk.source})` : "no SDK found",
      fix: sdk.root ? null : "Install Android Studio, or set ANDROID_HOME to an existing SDK",
    },
    {
      id: "emulator",
      label: "Emulator",
      met: !!sdk.emulator.path,
      detail: sdk.emulator.version ?? "not installed",
      fix: sdk.emulator.path ? null : "sdkmanager --install emulator",
    },
    {
      id: "adb",
      label: "adb",
      met: !!sdk.adb.path,
      detail: sdk.adb.version ?? "not installed",
      fix: sdk.adb.path ? null : "sdkmanager --install platform-tools",
    },
    {
      id: "acceleration",
      label: "Hardware acceleration",
      met: accel.ok,
      detail: accel.detail,
      fix: accel.ok ? null : "Enable virtualisation in the BIOS, and KVM/HAXM/Hypervisor.Framework for your OS",
    },
    {
      id: "avd",
      label: "At least one AVD",
      met: avds.length > 0,
      detail: avds.length ? `${avds.length} available` : "none created yet",
      fix: avds.length ? null : "Create one in Android Studio's Device Manager, or with avdmanager",
    },
    {
      id: "encoder",
      label: "H.264 encoder",
      met: encoders.length > 0,
      detail: encoders.length ? encoders.join(", ") : "ffmpeg has no working H.264 encoder here",
      fix: encoders.length ? null : "Install ffmpeg with libx264, or a VAAPI/QSV/NVENC-capable build",
    },
  ];

  return {
    enabled: opts.enabled,
    sdk,
    avdCount: avds.length,
    encoders,
    accelerationOk: accel.ok,
    accelerationDetail: accel.detail,
    requirements,
    ready: opts.enabled && requirements.every((r) => r.met),
  };
}

function disabledCapabilities(): AndroidCapabilities {
  const none = { path: null, version: null };
  const avdHome = resolveAvdHome();
  return {
    enabled: false,
    sdk: {
      root: null, source: "not-found", emulator: none, adb: none, avdmanager: none, sdkmanager: none,
      avdHome: avdHome.dir, avdHomeFromEnv: avdHome.fromEnv,
    },
    avdCount: 0,
    encoders: [],
    accelerationOk: false,
    accelerationDetail: "not checked while Android emulator support is off",
    requirements: [{
      id: "enabled",
      label: "Android emulator support",
      met: false,
      detail: "off on this host: it runs emulators, so it has to be asked for",
      fix: "Start PPM with ANDROID_EMULATOR_ENABLED=1",
    }],
    ready: false,
  };
}
