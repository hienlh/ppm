/**
 * `max_concurrent` is a host limit, and a start that is still booting holds a slot.
 *
 * The route used to count the emulators discovery could see, await the SDK probe, then start.
 * An emulator is minutes from spawning to advertising itself, so a second AVD started in that
 * window saw a free slot — and two requests arriving together both did, because the only lock
 * is per AVD. These drive the real route with a fake SDK whose `emulator` starts and exits
 * without ever advertising, which leaves the launcher's start in flight for as long as a real
 * boot would.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { androidRoutes } from "../../../src/server/routes/android.ts";
import { configService } from "../../../src/services/config.service.ts";
import { avdIdFor } from "../../../src/services/android/avd-list.ts";
import { _resetLauncher, startEmulator } from "../../../src/services/android/emulator-launcher.ts";
import { getOperation } from "../../../src/services/android/android-operations.ts";

/** Where discovery looks, bar the home directory (Bun caches `os.homedir()`); see emulator-discovery.test.ts. */
const ENV = ["XDG_RUNTIME_DIR", "LOCALAPPDATA", "TMPDIR", "ANDROID_AVD_HOME", "ANDROID_EMULATOR_ENABLED"] as const;

let root = "";
let avdHome = "";
let savedEnv: Record<string, string | undefined> = {};
let savedAuth: unknown;
let savedAndroid: unknown;
const children: ReturnType<typeof Bun.spawn>[] = [];

const app = new Hono().route("/api/android", androidRoutes);

/** Any executable that exits at once stands in for the emulator; bun is the one every host has. */
function fakeSdk(): string {
  const dir = join(root, "sdk", "emulator");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, process.platform === "win32" ? "emulator.exe" : "emulator");
  for (const place of [symlinkSync, linkSync, copyFileSync]) {
    try { place(process.execPath, target); break; } catch { /* the next way */ }
  }
  return join(root, "sdk");
}

function avd(name: string): string {
  const dir = join(avdHome, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.ini"), `AvdId=${name}\n`);
  return avdIdFor(dir);
}

const start = (avdId: string) => app.request(`/api/android/avds/${avdId}/start`, { method: "POST" });

/** An emulator already up on this host: a live process carrying the AVD id, advertised the way the emulator does. */
async function advertise(name: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)", name], {
    stdout: "ignore", stderr: "ignore",
  });
  children.push(child);
  if (process.platform === "linux") {
    // Until it has exec'd, `/proc/<pid>/cmdline` is empty and the identity check rejects it.
    for (let i = 0; i < 200; i++) {
      try { if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0").includes(name)) break; } catch {}
      await Bun.sleep(10);
    }
  }
  const dir = join(root, "run", "avd", "running");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pid_${child.pid}.ini`), `avd.id=${name}\ngrpc.port=8554\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-android-limit-"));
  avdHome = join(root, "avd");
  mkdirSync(avdHome, { recursive: true });
  mkdirSync(join(root, "run"), { recursive: true });
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.XDG_RUNTIME_DIR = process.env.LOCALAPPDATA = process.env.TMPDIR = join(root, "run");
  process.env.ANDROID_AVD_HOME = avdHome;
  process.env.ANDROID_EMULATOR_ENABLED = "1";

  savedAuth = configService.get("auth");
  savedAndroid = configService.get("android");
  configService.set("auth", { enabled: true, token: "test-token" });
  configService.set("android", { sdk_root: fakeSdk(), max_concurrent: 1 });
  _resetLauncher();
});

afterEach(() => {
  _resetLauncher();
  for (const c of children.splice(0)) c.kill();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  configService.set("auth", savedAuth as never);
  configService.set("android", (savedAndroid ?? {}) as never);
  // Best effort: on Windows a fake emulator that is still exiting holds its executable open.
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("the emulator limit", () => {
  it("refuses a second AVD while the first is still booting", async () => {
    const a = avd("ppm_limit_a");
    const b = avd("ppm_limit_b");

    expect((await start(a)).status).toBe(200);
    const second = await start(b);

    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error)
      .toBe("already running or starting 1 emulator(s); the limit for this host is 1");
  });

  it("lets one of two simultaneous starts through", async () => {
    const [a, b] = [avd("ppm_limit_a"), avd("ppm_limit_b")];

    const statuses = (await Promise.all([start(a), start(b)])).map((r) => r.status);

    expect(statuses.sort()).toEqual([200, 409]);
  });

  it("does not hold a start against the AVD it is starting", async () => {
    const a = avd("ppm_limit_a");

    const first = (await (await start(a)).json()) as { data: { operationId: string } };
    const again = await start(a);

    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { operationId: string } }).data.operationId)
      .toBe(first.data.operationId);
  });

  it("counts an emulator that was already running", async () => {
    await advertise("ppm_limit_external");
    const a = avd("ppm_limit_a");

    expect((await start(a)).status).toBe(409);
  });

  it("frees the slot when a start fails", async () => {
    const opts = { avdHome, emulatorPath: process.execPath, bootDeadlineMs: 300, maxConcurrent: 1 };
    const first = startEmulator({ ...opts, avdName: "ppm_limit_a" });
    for (let i = 0; i < 100 && getOperation(first.id)?.state !== "failed"; i++) await Bun.sleep(20);
    expect(getOperation(first.id)?.state).toBe("failed");

    expect(() => startEmulator({ ...opts, avdName: "ppm_limit_b" })).not.toThrow();
  });
});
