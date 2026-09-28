/**
 * A discovery file is untrusted input: it may be stale, truncated, enormous, or name a pid that
 * now belongs to something else. Plan §5 requires each of those to be rejected before the
 * endpoint it advertises is ever dialled.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunningEmulators, verifyProcessIdentity } from "../../../src/services/android/emulator-discovery.ts";

let runtimeDir: string;
let savedEnv: Record<string, string | undefined> = {};

/**
 * Every place `discoveryDirs()` reads bar the home directory (Bun caches `os.homedir()`), pointed
 * into this test's own directory — so an emulator running on the host, or a stale file whose pid
 * has since been reused, adds no rows of its own. `LOCALAPPDATA` is where Windows's emulator
 * writes, `TMPDIR` names the other platforms' `android-$USER` directory.
 */
const DISCOVERY_ENV = ["XDG_RUNTIME_DIR", "LOCALAPPDATA", "TMPDIR"] as const;

function writeIni(pid: number, fields: Record<string, string>): void {
  const dir = join(runtimeDir, "avd", "running");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pid_${pid}.ini`),
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n"));
}

/**
 * A live process whose argv carries `marker` as an entry of its own, the way an emulator's argv
 * carries its AVD id. A bun child rather than `sleep 30`, so that it exists on Windows too.
 */
async function spawnCarrying(marker: string): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)", marker], {
    stdout: "ignore", stderr: "ignore",
  });
  // A freshly spawned pid exists before it has exec'd, and until then its `/proc/<pid>/cmdline`
  // is EMPTY — the identity check then correctly rejects it and the test fails for a reason
  // that has nothing to do with the code. Alone this is never seen; under a loaded full-suite
  // run it is. Wait for the argv to actually be there. Only Linux reads it back at all.
  if (process.platform === "linux") {
    for (let i = 0; i < 200; i++) {
      try {
        if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0").includes(marker)) break;
      } catch { /* not there yet */ }
      await Bun.sleep(10);
    }
  }
  return child;
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ppm-discovery-"));
  savedEnv = Object.fromEntries(DISCOVERY_ENV.map((k) => [k, process.env[k]]));
  for (const k of DISCOVERY_ENV) process.env[k] = runtimeDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("emulator discovery", () => {
  it("accepts a well-formed advertisement whose process really is that emulator", async () => {
    // The identity check reads the pid's argv, so the stand-in has to genuinely carry the AVD
    // name — this test process does not, and being rejected for that is the check working.
    const child = await spawnCarrying("30");
    try {
      writeIni(child.pid, {
        "avd.id": "30", "avd.name": "30", "grpc.port": "8554",
        "grpc.token": "secret", "port.serial": "5554", "port.adb": "5555",
      });
      const found = findRunningEmulators();
      expect(found).toHaveLength(1);
      expect(found[0]!.grpcPort).toBe(8554);
      // adb names an emulator by its CONSOLE port, not its adb port.
      expect(found[0]!.adbSerial).toBe("emulator-5554");
    } finally {
      child.kill();
      await child.exited;
    }
  });

  // Linux alone can read another process's argv without a dependency (/proc), so the pid-reuse
  // case is caught here only there. Elsewhere a live pid is accepted and the gRPC connect has to
  // prove it is the emulator — the test after this one pins that, so the gap stays visible.
  it.skipIf(process.platform !== "linux")("rejects a live pid whose argv is not that emulator — the pid-reuse case", () => {
    writeIni(process.pid, {
      "avd.id": "some_other_avd", "avd.name": "some_other_avd", "grpc.port": "8554",
    });
    expect(findRunningEmulators()).toHaveLength(0);
  });

  it.skipIf(process.platform === "linux")("off Linux, accepts any live pid and leaves identity to the gRPC connect", () => {
    writeIni(process.pid, {
      "avd.id": "some_other_avd", "avd.name": "some_other_avd", "grpc.port": "8554",
    });
    expect(findRunningEmulators()).toHaveLength(1);
  });

  it("drops a file whose pid is dead", () => {
    writeIni(2147483600, { "avd.id": "ghost", "avd.name": "ghost", "grpc.port": "8554" });
    expect(findRunningEmulators()).toHaveLength(0);
  });

  it("drops a file with no gRPC port — there is nothing to drive", () => {
    writeIni(process.pid, { "avd.id": "no_grpc", "avd.name": "no_grpc" });
    expect(findRunningEmulators()).toHaveLength(0);
  });

  it("rejects a port outside the valid range rather than dialling it", () => {
    writeIni(process.pid, { "avd.id": "bad", "avd.name": "bad", "grpc.port": "99999" });
    expect(findRunningEmulators()).toHaveLength(0);
  });

  it("refuses to read an oversized file instead of pulling it into memory", () => {
    const dir = join(runtimeDir, "avd", "running");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `pid_${process.pid}.ini`),
      `avd.id=big\navd.name=big\ngrpc.port=8554\npadding=${"x".repeat(80 * 1024)}`);
    expect(findRunningEmulators()).toHaveLength(0);
  });

  it("ignores files that are not named pid_<n>.ini", () => {
    const dir = join(runtimeDir, "avd", "running");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "avd.name=x\ngrpc.port=8554");
    expect(findRunningEmulators()).toHaveLength(0);
  });
});

describe("process identity", () => {
  it("refuses when the discovery file names no AVD at all", () => {
    expect(verifyProcessIdentity(process.pid, undefined)).toBe(false);
  });

  it("refuses a pid that does not exist", () => {
    expect(verifyProcessIdentity(2147483600, "anything")).toBe(false);
  });

  it("accepts when the process argv carries the AVD name", async () => {
    const child = await spawnCarrying("30");
    try {
      expect(verifyProcessIdentity(child.pid, "30")).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it.skipIf(process.platform !== "linux")("refuses a live process whose argv does not carry the AVD name", async () => {
    const child = await spawnCarrying("30");
    try {
      expect(verifyProcessIdentity(child.pid, "not_this_avd")).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
