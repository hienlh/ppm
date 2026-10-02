/**
 * Creating, wiping and deleting AVDs.
 *
 * Every SDK tool is called as an **argv array**, never a shell string (plan §Phase 4: "Các API
 * typed bọc SDK tools, không nối chuỗi shell"). The browser names a profile and an image out of
 * lists this file produced; it never supplies a flag.
 *
 * Two things here exist only because the defaults are wrong for PPM:
 *
 *  - **`hw.keyboard=yes` is written after creation, always.** `avdmanager` writes `no` (Android
 *    Studio writes `yes`), and with it off the gRPC `sendKey` path returns `OK` and **not one
 *    character reaches the guest** — no error, no log, while touch keeps working perfectly.
 *    Measured in Phase 0 after ruling out the allowlist and `-no-window`.
 *  - **A device profile is not optional.** `avdmanager create avd` with no `--device` produces a
 *    **320×640** AVD (measured: `hw.lcd.width=320`), which looks like a broken emulator rather
 *    than a missing argument.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { avdIdFor, listAvds, type AvdSummary } from "./avd-list.ts";
import type { SystemImage } from "./system-images.ts";
import { avdHomeEnv } from "./sdk-discovery.ts";
import { AVD_LIMITS, validateAvdName } from "../../shared/android-avd.ts";
import type { AvdDeviceProfile, CreateAvdRequest } from "../../shared/android-avd.ts";

// The name rule and the bounds are shared with the browser's create form (see
// `src/shared/android-avd.ts`) and re-exported here so callers keep one import.
export { AVD_LIMITS, validateAvdName };
export type { CreateAvdRequest };
export type DeviceProfile = AvdDeviceProfile;

export interface ToolResult {
  ok: boolean;
  message: string;
  output: string;
}

// ---------------------------------------------------------------------------------------------
// Device profiles
// ---------------------------------------------------------------------------------------------

/**
 * Parse `avdmanager list device`.
 *
 * Shape, measured on cmdline-tools for emulator 36.5.10 (88 entries):
 *
 * ```
 * id: 46 or "pixel_9"
 *     Name: Pixel 9
 *     OEM : Google
 * ---------
 * ```
 *
 * `Tag :` is **optional** and absent on most phone profiles including every Pixel, so a parser
 * that requires it silently drops the entries people actually want.
 */
export function parseDeviceProfiles(output: string): DeviceProfile[] {
  const profiles: DeviceProfile[] = [];
  let current: { id: string; name: string; oem: string; tag: string | null } | null = null;

  const flush = () => {
    if (current && current.id) profiles.push({ ...current, kind: kindOf(current.id, current.name) });
    current = null;
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    const idMatch = /^id:\s*\d+\s+or\s+"([^"]+)"\s*$/.exec(line.trim());
    if (idMatch) {
      flush();
      current = { id: idMatch[1]!, name: idMatch[1]!, oem: "", tag: null };
      continue;
    }
    if (!current) continue;
    const name = /^\s*Name:\s*(.+)$/.exec(line);
    if (name) { current.name = name[1]!.trim(); continue; }
    const oem = /^\s*OEM\s*:\s*(.+)$/.exec(line);
    if (oem) { current.oem = oem[1]!.trim(); continue; }
    const tag = /^\s*Tag\s*:\s*(.+)$/.exec(line);
    if (tag) { current.tag = tag[1]!.trim(); continue; }
    if (line.startsWith("---")) flush();
  }
  flush();
  return profiles;
}

function kindOf(id: string, name: string): DeviceProfile["kind"] {
  const haystack = `${id} ${name}`.toLowerCase();
  if (/\btv\b|television/.test(haystack)) return "tv";
  if (/wear|watch/.test(haystack)) return "wear";
  if (/automotive|\bcar\b/.test(haystack)) return "automotive";
  if (/desktop|freeform|chromebook/.test(haystack)) return "desktop";
  if (/tablet|\bpad\b|nexus (7|9|10)|fold/.test(haystack)) return "tablet";
  if (/phone|pixel|galaxy|nexus|\bxl\b/.test(haystack)) return "phone";
  return "other";
}

/**
 * ~730 ms measured, so it is cached for the life of the process — the SDK's stock profile list
 * does not change while PPM runs, and the create dialog would otherwise pay it on every open.
 */
let profileCache: DeviceProfile[] | null = null;

export async function listDeviceProfiles(avdmanagerPath: string | null): Promise<DeviceProfile[]> {
  if (profileCache) return profileCache;
  if (!avdmanagerPath) return [];
  const result = await runTool(avdmanagerPath, ["list", "device"], 60_000);
  if (!result.ok) return [];
  const parsed = parseDeviceProfiles(result.output);
  if (parsed.length > 0) profileCache = parsed;
  return parsed;
}

export function _resetProfileCache(): void { profileCache = null; }

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

function clamp(value: number | undefined, bounds: { min: number; max: number; default: number }): number {
  if (value === undefined || !Number.isFinite(value)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

export async function createAvd(
  opts: CreateAvdRequest & { avdmanagerPath: string; avdHome: string; images: SystemImage[] },
): Promise<ToolResult & { avd: AvdSummary | null }> {
  const nameProblem = validateAvdName(opts.name);
  if (nameProblem) return { ok: false, message: nameProblem, output: "", avd: null };

  // The image and the profile must be ones *this* host has, named out of the lists PPM issued —
  // never a string the browser made up, which is what keeps this from being an argument proxy.
  const image = opts.images.find((i) => i.id === opts.systemImage);
  if (!image) return { ok: false, message: "that system image is not installed on this host", output: "", avd: null };
  if (!/^[A-Za-z0-9._-]+$/.test(opts.deviceProfile)) {
    return { ok: false, message: "that is not a device profile id", output: "", avd: null };
  }
  if (listAvds(opts.avdHome).some((a) => a.name === opts.name)) {
    return { ok: false, message: `an AVD called ${opts.name} already exists`, output: "", avd: null };
  }

  // No `--force`: overwriting an existing AVD is a destructive act wearing a create's clothes,
  // and the duplicate check above is what the user should see instead.
  const args = [
    "create", "avd",
    "--name", opts.name,
    "--package", image.id,
    "--device", opts.deviceProfile,
    "--abi", image.abi,
  ];
  const sdCardMb = clamp(opts.sdCardMb, AVD_LIMITS.sdCardMb);
  if (sdCardMb > 0) args.push("--sdcard", `${sdCardMb}M`);

  // `ANDROID_AVD_HOME` has to name a directory that **exists**. Pointed at a missing one,
  // `avdmanager` does not fail — it falls back to `~/.android/avd` and writes the AVD into the
  // user's own directory, which is the same silent outcome as not setting the variable at all
  // (measured both ways). One `mkdir` is the whole fix; the config check below is what catches
  // it if some other cause puts the AVD somewhere else again.
  mkdirSync(opts.avdHome, { recursive: true });

  // `avdmanager` asks "Do you wish to create a custom hardware profile?" on stdin and blocks
  // forever without an answer. `no` is the answer, and it is given rather than left to a tty.
  const result = await runTool(opts.avdmanagerPath, args, 180_000, "no\n", avdHomeEnv(opts.avdHome));
  if (!result.ok) return { ...result, avd: null };

  const dir = join(opts.avdHome, `${opts.name}.avd`);
  if (!existsSync(join(dir, "config.ini"))) {
    return {
      ok: false,
      message: `avdmanager exited cleanly but wrote no config under ${opts.avdHome}`,
      output: result.output,
      avd: null,
    };
  }

  applyPpmDefaults(join(dir, "config.ini"), {
    ramMb: clamp(opts.ramMb, AVD_LIMITS.ramMb),
    storageMb: clamp(opts.storageMb, AVD_LIMITS.storageMb),
  });

  const avd = listAvds(opts.avdHome).find((a) => a.avdId === avdIdFor(dir)) ?? null;
  return { ok: true, message: `created ${opts.name}`, output: result.output, avd };
}

/**
 * The settings PPM needs that `avdmanager` does not write.
 *
 * Rewrites only the keys named here and leaves every other line byte-identical, so a config this
 * code does not understand survives untouched.
 */
export function applyPpmDefaults(configPath: string, opts: { ramMb: number; storageMb: number }): void {
  const wanted: Record<string, string> = {
    // The whole reason this function exists — see the file header.
    "hw.keyboard": "yes",
    "hw.ramSize": `${opts.ramMb}M`,
    "disk.dataPartition.size": `${opts.storageMb}M`,
    // Touch, not a d-pad: the viewer sends pointer events.
    "hw.screen": "multi-touch",
  };
  writeConfigKeys(configPath, wanted);
}

/** Read-modify-write of a `key=value` file, preserving order and unknown keys. */
export function writeConfigKeys(configPath: string, values: Record<string, string>): void {
  let lines: string[];
  try { lines = readFileSync(configPath, "utf8").split("\n"); } catch { return; }

  const remaining = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0) return line;
    const key = line.slice(0, eq).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  // A file that ends in a newline splits to a trailing empty string; appending after it opens a
  // blank line in the middle of the config rather than at its end.
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  for (const [key, value] of remaining) out.push(`${key}=${value}`);

  // Keep the file newline-terminated; emulator's own parser is fine either way but a diff is not.
  const text = out.join("\n").replace(/\n*$/, "\n");
  writeFileSync(configPath, text);
}

// ---------------------------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------------------------

/**
 * What a wipe removes, by name.
 *
 * An **allowlist**, not a glob: a file this code has never heard of is *kept*, because the
 * alternative is a future emulator version quietly losing something with no way to notice. Also
 * never `config.ini` or the sibling `<name>.ini` — those are the AVD's definition, and removing
 * them is a delete wearing a wipe's clothes.
 *
 * `emulator -avd <n> -wipe-data` is the documented route and does the same thing, but it *boots*
 * the AVD to do it, which contradicts the plan's "chỉ khi stopped".
 *
 * **`userdata.img` is deliberately not in this list.** `emulator -help-disk-images` groups it
 * with `system.img` under the *initial* images and spells out what a wipe is: "Copy the content
 * of the *initial* user data image (userdata.img) into the writable one (userdata-qemu.img)".
 * Deleting it is deleting the factory copy a wipe restores from. A current AVD keeps it in the
 * system-image directory instead — measured: a fresh AVD here has none, and boots fine after a
 * wipe that removed it — so this only bites an AVD made by older tooling, silently, on its next
 * boot. Exactly what the allowlist exists to prevent.
 */
const WIPE_FILES = [
  "userdata-qemu.img", "userdata-qemu.img.qcow2",
  "cache.img", "cache.img.qcow2",
  "sdcard.img", "sdcard.img.qcow2",
  "encryptionkey.img.qcow2",
  "version_num.cache", "bootcompleted.ini", "read-snapshot.txt",
  "hardware-qemu.ini", "emu-launch-params.txt", "multiinstance.lock",
];
const WIPE_DIRS = ["snapshots", "tmpAdbCmds"];

export interface WipeOutcome {
  ok: boolean;
  message: string;
  /** What was actually removed, so the report is the truth rather than the intent. */
  removed: string[];
  freedBytes: number;
}

export function wipeAvdData(avdDir: string): WipeOutcome {
  if (!existsSync(join(avdDir, "config.ini"))) {
    return { ok: false, message: "that is not an AVD directory", removed: [], freedBytes: 0 };
  }
  const removed: string[] = [];
  let freed = 0;

  for (const name of WIPE_FILES) {
    const path = join(avdDir, name);
    if (!existsSync(path)) continue;
    try {
      freed += Bun.file(path).size;
      rmSync(path, { force: true });
      removed.push(name);
    } catch { /* locked by something; the caller checks the AVD is stopped first */ }
  }
  for (const name of WIPE_DIRS) {
    const path = join(avdDir, name);
    if (!existsSync(path)) continue;
    try {
      freed += dirBytes(path);
      rmSync(path, { recursive: true, force: true });
      removed.push(`${name}/`);
    } catch { /* same */ }
  }

  return {
    ok: true,
    message: removed.length > 0 ? `wiped ${removed.length} item(s)` : "there was nothing to wipe",
    removed,
    freedBytes: freed,
  };
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += dirBytes(full);
      else { try { total += Bun.file(full).size; } catch { /* gone */ } }
    }
  } catch { /* gone */ }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export async function deleteAvd(avdmanagerPath: string, name: string, avdHome: string): Promise<ToolResult> {
  const problem = validateAvdName(name);
  if (problem) return { ok: false, message: problem, output: "" };
  // Without the home, `delete` looks in `~/.android/avd` and answers "there is no AVD named X"
  // for one that plainly exists in the listing — the same trap as create, read backwards.
  return runTool(avdmanagerPath, ["delete", "avd", "--name", name], 60_000, "", avdHomeEnv(avdHome));
}

// ---------------------------------------------------------------------------------------------

/**
 * One SDK tool run, argv only.
 *
 * `avdmanager` writes its progress bar and most of its diagnostics to **stderr** while still
 * exiting 0, so success cannot be read off stderr being empty; and it prompts on stdin, so
 * `stdin` is always fed rather than inherited — a prompt with no tty is a hang, not an error.
 */
async function runTool(
  path: string,
  args: string[],
  timeoutMs: number,
  stdin = "",
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolResult> {
  let proc: ReturnType<typeof spawnTool>;
  try {
    proc = spawnTool(path, args, stdin, env);
  } catch (e) {
    // Bun.spawn throws synchronously on a missing binary (CLAUDE.md, host-info/spawn-runner.ts).
    return { ok: false, message: `could not run ${path}: ${(e as Error).message}`, output: "" };
  }

  const collected = (async () => {
    const [out, errOut] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { text: `${out}${errOut}`, exitCode: await proc.exited };
  })();
  collected.catch(() => { /* abandoned on timeout */ });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve("expired"); }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([collected, expired]);
    if (outcome === "expired") {
      return { ok: false, message: `${basenameOf(path)} did not finish in ${Math.round(timeoutMs / 1000)}s`, output: "" };
    }
    // The progress bar is carriage-return animation; keeping it makes every error message a wall.
    // CRLF goes first: the SDK's Java tools end every line with it on Windows, and the strip
    // would otherwise erase each of those lines as if it were a frame of the bar.
    const output = outcome.text.replace(/\r\n/g, "\n").replace(/^.*\r/gm, "").trim();
    if (outcome.exitCode !== 0) {
      const firstError = output.split("\n").map((l) => l.trim()).find((l) => /^error/i.test(l));
      return { ok: false, message: firstError ?? output.split("\n")[0] ?? `exited with ${outcome.exitCode}`, output };
    }
    return { ok: true, message: "done", output };
  } finally {
    clearTimeout(timer);
  }
}

/** Named so `stdout` keeps its pipe type — `ReturnType<typeof Bun.spawn>` widens it (CLAUDE.md). */
function spawnTool(path: string, args: string[], stdin: string, env: NodeJS.ProcessEnv) {
  return Bun.spawn([path, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env,
    windowsHide: true,
  });
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
