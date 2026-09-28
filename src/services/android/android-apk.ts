/**
 * Installing an APK on a running emulator.
 *
 * `EmulatorController` has no install RPC — this is `adb install`, and that is the whole reason
 * the surface is a *typed* one (plan ADR: "API typed riêng, không mở generic shell/RPC proxy").
 * The caller names a device and a file; nothing here takes a command, a flag or an argument
 * string from the browser.
 *
 * Two things this file exists to get right:
 *
 *  - **The right device.** Measured with two emulators attached, `adb install` with no `-s`
 *    answers **"adb: more than one device/emulator"** and installs nothing — so the failure mode
 *    is a refusal rather than the coin toss it looks like, and on a single-device host it would
 *    work by luck and break the day a second emulator is started. The serial is always passed,
 *    and `tests/e2e/android-two-device-install-e2e.ts` proves it is honoured rather than merely
 *    present, by installing to one of two live devices and checking both.
 *  - **The real reason it failed.** adb reports `INSTALL_FAILED_NO_MATCHING_ABIS` and friends on
 *    stdout with exit code 0 in some versions, so the exit code alone is not the answer, and the
 *    raw code alone is not something to show a person.
 */
import { existsSync, statSync } from "node:fs";

/** A larger APK than this is almost certainly not what the user meant to upload. */
export const MAX_APK_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How long one `adb install` may take before it is killed (plan §7: "deadline").
 *
 * Generous on purpose — a cold guest installing a 300 MB APK is minutes of real work — but not
 * unbounded: adb against a half-wedged emulator hangs rather than erroring, and an install that
 * never ends leaves an operation stuck at "running" forever with no way out but a restart.
 */
export const INSTALL_DEADLINE_MS = 10 * 60_000;

/**
 * Total bytes the staging directory may hold at once.
 *
 * `MAX_APK_BYTES` bounds one upload; nothing bounds ten at once, and a disk full of half-uploaded
 * APKs takes the whole PPM directory down with it — the database included.
 */
export const MAX_STAGING_BYTES = 4 * 1024 * 1024 * 1024;

export interface InstallOptions {
  adbPath: string;
  /** The emulator's adb serial, e.g. `emulator-5554`. Never omitted. */
  serial: string;
  apkPath: string;
  /** Replace an existing install rather than failing on a duplicate package. */
  reinstall?: boolean;
  /** Allow installing over a newer version, which adb otherwise refuses. */
  allowDowngrade?: boolean;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** Overrides `INSTALL_DEADLINE_MS`; a test uses it to reach the timeout in a second. */
  deadlineMs?: number;
}

export interface InstallResult {
  ok: boolean;
  /** A sentence to show a person, already explaining what to do about it. */
  message: string;
  /** adb's own failure code, when it gave one — worth keeping for a bug report. */
  code: string | null;
  output: string;
}

/**
 * adb's failure codes, in terms that say what to do. Anything not here is passed through
 * verbatim rather than flattened into "install failed", which would hide the one useful word.
 */
const FAILURES: { code: string; message: string }[] = [
  { code: "INSTALL_FAILED_NO_MATCHING_ABIS",
    message: "the APK has no native code for this emulator's ABI — use an x86_64 build, or an AVD whose ABI matches the APK" },
  { code: "INSTALL_FAILED_OLDER_SDK",
    message: "the APK needs a newer Android than this AVD runs — start an AVD with a higher API level" },
  { code: "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
    message: "a package with this name is already installed and was signed with a different key — uninstall it first" },
  { code: "INSTALL_FAILED_VERSION_DOWNGRADE",
    message: "the installed version is newer than this APK — turn on 'allow downgrade' to replace it" },
  { code: "INSTALL_FAILED_INSUFFICIENT_STORAGE",
    message: "the emulator has no room left — wipe its data or give the AVD a larger disk" },
  { code: "INSTALL_FAILED_INVALID_APK",
    message: "adb could not read this file as an APK — check it is not a partial download or an AAB" },
  { code: "INSTALL_PARSE_FAILED_NO_CERTIFICATES",
    message: "the APK is not signed — sign it, or use a debug build" },
  { code: "INSTALL_FAILED_TEST_ONLY",
    message: "this is a test-only build — rebuild it without `testOnly`, or install it with adb's own `-t`" },
  { code: "device offline",
    message: "the emulator stopped responding to adb — wait for it to finish booting, or restart it" },
];

/** Turn adb's output into something worth showing, without throwing away what it said. */
export function explainInstallOutput(output: string, exitCode: number): { ok: boolean; message: string; code: string | null } {
  const text = output.trim();
  const failure = FAILURES.find((f) => text.includes(f.code));
  if (failure) return { ok: false, message: failure.message, code: failure.code };

  // Some adb versions print `Failure [CODE]` for codes this table has never heard of.
  const unknown = text.match(/Failure\s*\[([A-Z_]+[^\]]*)\]/);
  if (unknown) return { ok: false, message: `adb refused the install: ${unknown[1]}`, code: unknown[1] ?? null };

  // `Success` on stdout is adb's own word for it, and is more reliable than the exit code:
  // several adb versions exit 0 on a failed install.
  if (text.split("\n").some((l) => l.trim() === "Success")) {
    return { ok: true, message: "installed", code: null };
  }
  if (exitCode === 0) return { ok: true, message: "installed", code: null };
  return { ok: false, message: text || `adb exited with code ${exitCode}`, code: null };
}

export async function installApk(opts: InstallOptions): Promise<InstallResult> {
  if (!existsSync(opts.apkPath)) {
    return { ok: false, message: "that file no longer exists", code: null, output: "" };
  }
  const size = statSync(opts.apkPath).size;
  if (size === 0) return { ok: false, message: "that file is empty", code: null, output: "" };
  if (size > MAX_APK_BYTES) {
    return { ok: false, message: `that file is ${(size / 1024 / 1024).toFixed(0)} MB, past the ${MAX_APK_BYTES / 1024 / 1024 / 1024} GB limit`, code: null, output: "" };
  }

  const args = ["-s", opts.serial, "install"];
  if (opts.reinstall !== false) args.push("-r");
  if (opts.allowDowngrade) args.push("-d");
  args.push(opts.apkPath);

  // Cancelled before it started: adb is never run at all.
  if (opts.signal?.aborted) return { ok: false, message: "cancelled", code: null, output: "" };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.adbPath, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (e) {
    // Bun.spawn throws synchronously when the binary is missing, and the throw escapes an
    // awaited try placed further out (CLAUDE.md, host-info/spawn-runner.ts).
    return { ok: false, message: `could not run adb: ${(e as Error).message}`, code: null, output: "" };
  }

  // Cancel has the same hazard as the deadline below — killing the process may not close its
  // pipes — so it resolves the race itself rather than relying on the read ending.
  let resolveAborted: (() => void) | null = null;
  const aborted = new Promise<"aborted">((resolve) => { resolveAborted = () => resolve("aborted"); });
  const onAbort = () => {
    try { proc.kill(); } catch { /* already gone */ }
    resolveAborted?.();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  /**
   * Reading the pipes to the end is the *normal* path, not a reliable one.
   *
   * Measured: killing the process does **not** necessarily close its pipes — a child that
   * inherited them keeps them open, and `reader.read()` then never resolves. So the deadline
   * races this rather than trusting the kill to unblock it, the same shape `Encoder.stop()` in
   * `android-video.ts` needed for ffmpeg. `.catch` on the handle keeps an abandoned read from
   * surfacing as an unhandled rejection after this function has already answered.
   */
  const collected = (async () => {
    const [out, errOut] = await Promise.all([
      readStream(proc.stdout, opts.onProgress),
      readStream(proc.stderr, opts.onProgress),
    ]);
    return { output: `${out}${errOut}`.trim(), exitCode: await proc.exited };
  })();
  collected.catch(() => { /* the deadline path abandons this deliberately */ });

  const deadlineMs = opts.deadlineMs ?? INSTALL_DEADLINE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    deadlineTimer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      resolve("expired");
    }, deadlineMs);
  });

  try {
    const outcome = await Promise.race([collected, expired, aborted]);
    if (outcome === "aborted") {
      return { ok: false, message: "cancelled", code: null, output: "" };
    }
    if (outcome === "expired") {
      const minutes = deadlineMs >= 60_000 ? `${Math.round(deadlineMs / 60_000)} minutes` : `${Math.round(deadlineMs / 1000)}s`;
      return {
        ok: false,
        message: `adb did not finish within ${minutes} — the emulator may be wedged`,
        code: null,
        // Whatever it managed to say, if it closed its pipes on the way out. Never waited for.
        output: await Promise.race([collected.then((c) => c.output).catch(() => ""), Bun.sleep(300).then(() => "")]),
      };
    }
    if (opts.signal?.aborted) {
      return { ok: false, message: "cancelled", code: null, output: outcome.output };
    }
    return { ...explainInstallOutput(outcome.output, outcome.exitCode), output: outcome.output };
  } finally {
    clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Manual pull loop, not `for await` — see the note in `android-video.ts`. */
async function readStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    if (!value) continue;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    if (onLine) for (const line of chunk.split("\n")) { const t = line.trim(); if (t) onLine(t); }
  }
}

/* ---------------------------------------------------------------------------------------------
 * Staging an uploaded APK.
 *
 * The plan's Phase 3 gate is "hủy upload không để temp" — a cancelled upload leaves nothing
 * behind. That is not automatic: an aborted request rejects the read *mid-file*, so the partial
 * has to be deleted on the way out of every failure path, and a PPM killed mid-upload leaves one
 * behind that only a later sweep can remove.
 * ------------------------------------------------------------------------------------------- */

import { mkdirSync, readdirSync, rmSync, statSync as statFile } from "node:fs";
import { join, relative, sep } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";

export function apkStagingDir(): string {
  return join(getPpmDir(), "android", "apk-staging");
}

/** A staged file older than this is from a PPM that died mid-upload. */
const STAGING_MAX_AGE_MS = 60 * 60_000;

/**
 * Called before each upload. What a crash left behind is removed by the next upload once it is an
 * hour old, and until then counts against `MAX_STAGING_BYTES`, so crashes cannot pile up gigabytes.
 */
export function sweepApkStaging(): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(apkStagingDir()); } catch { return 0; }
  for (const name of names) {
    const path = join(apkStagingDir(), name);
    try {
      if (Date.now() - statFile(path).mtimeMs < STAGING_MAX_AGE_MS) continue;
      rmSync(path, { force: true });
      removed++;
    } catch { /* another sweep got there first */ }
  }
  return removed;
}

/** What the staging directory currently holds, for the quota check. */
export function stagingBytes(): number {
  let total = 0;
  try {
    for (const name of readdirSync(apkStagingDir())) {
      try { total += statFile(join(apkStagingDir(), name)).size; } catch { /* gone */ }
    }
  } catch { /* no directory yet */ }
  return total;
}

export interface StagedApk {
  path: string;
  bytes: number;
  /** Idempotent — safe to call after the install, and again on an error path. */
  discard(): void;
}

/**
 * Write an upload to a staging file, refusing anything that is not a zip (an APK is one) and
 * anything past the size limit — both checked *while* streaming, so a 5 GB body is cut off at
 * the limit rather than after it has all been written.
 */
export async function stageApkUpload(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<StagedApk> {
  sweepApkStaging();
  const alreadyStaged = stagingBytes();
  if (alreadyStaged >= MAX_STAGING_BYTES) {
    throw new Error("another upload is still using the staging space — wait for it to finish");
  }
  mkdirSync(apkStagingDir(), { recursive: true });
  const path = join(apkStagingDir(), `${crypto.randomUUID()}.apk`);
  const discard = () => { try { rmSync(path, { force: true }); } catch { /* already gone */ } };

  const limit = opts.maxBytes ?? MAX_APK_BYTES;
  const sink = Bun.file(path).writer();
  const reader = body.getReader();
  let bytes = 0;
  let head = new Uint8Array(0);

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (head.length < 4) {
        const merged = new Uint8Array(head.length + value.length);
        merged.set(head); merged.set(value, head.length);
        head = merged.slice(0, 4);
        if (head.length >= 2 && !(head[0] === 0x50 && head[1] === 0x4b)) {
          throw new Error("that file is not an APK (no zip header)");
        }
      }

      bytes += value.length;
      if (bytes > limit) throw new Error(`the upload is past the ${limit / 1024 / 1024 / 1024} GB limit`);
      // The quota counts everything staged, not only this upload: two concurrent 2 GB uploads
      // each stay under their own limit and together fill the disk the database lives on.
      if (alreadyStaged + bytes > MAX_STAGING_BYTES) {
        throw new Error("there is not enough staging space for this upload right now");
      }
      sink.write(value);
    }
    await sink.end();
  } catch (e) {
    try { await sink.end(); } catch { /* the writer may already be broken */ }
    discard();
    try { await reader.cancel(); } catch { /* the peer is gone */ }
    throw e;
  }

  if (bytes === 0) { discard(); throw new Error("the upload was empty"); }
  return { path, bytes, discard };
}

/* ---------------------------------------------------------------------------------------------
 * Finding the APKs a project has already built.
 *
 * A full walk of a project root is not acceptable here — the same reasoning as the recursive
 * `fs.watch` ban in CLAUDE.md: `node_modules` alone is tens of thousands of directories. This is
 * depth-bounded and prunes by name, which is enough because Gradle always writes to
 * a `build/outputs/apk` directory.
 * ------------------------------------------------------------------------------------------- */

const PRUNED_DIRS = new Set([
  "node_modules", ".git", ".gradle", ".idea", "vendor", "target", "Pods",
  ".venv", "venv", "__pycache__", ".next", ".cache", "dist",
]);
const MAX_WALK_DEPTH = 8;
const MAX_APKS_LISTED = 200;

export interface ProjectApk {
  /** Project-relative, which is what the install route takes. */
  path: string;
  bytes: number;
  modifiedAt: number;
}

export async function findProjectApks(root: string): Promise<ProjectApk[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const found: ProjectApk[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_APKS_LISTED) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_APKS_LISTED) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
        try {
          const s = await stat(full);
          // Relative and "/"-separated on every OS, like every other path PPM hands the browser.
          found.push({ path: relative(root, full).split(sep).join("/"), bytes: s.size, modifiedAt: s.mtimeMs });
        } catch { /* it went away between the listing and the stat */ }
      }
    }
  }

  await walk(root, 0);
  // Newest first: after a build, the one the user wants is the one that just appeared.
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
