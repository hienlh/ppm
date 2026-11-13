/**
 * One-click install of the local embedding model, driven by a fake runner: nothing is spawned,
 * downloaded or installed. The runner records each command and checks the install dir at the
 * moment the command would have run.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-local-install-home-"));

type Mod = typeof import("../../../src/services/memory/embedding/local-install.ts");
type Status = import("../../../src/services/memory/embedding/local-install.ts").LocalInstallStatus;
type Runner = import("../../../src/services/memory/embedding/local-install.ts").InstallRunner;

let mod: Mod;
let EMBED_HOST_FILE = "";
let EMBED_HOST_SOURCE = "";
let root = "";

beforeAll(async () => {
  mod = await import("../../../src/services/memory/embedding/local-install.ts");
  ({ EMBED_HOST_FILE, EMBED_HOST_SOURCE } = await import("../../../src/services/memory/embedding/embed-host-source.ts"));
  root = mkdtempSync(join(tmpdir(), "ppm-local-install-"));
});

let n = 0;
function freshDir(): string {
  return join(root, `install-${++n}`);
}

const FAKE_BUN = "/fake/bin/bun";

interface Call {
  cmd: string[];
  cwd: string;
  status: Status;
  manifest: unknown;
  hostSource: string | null;
}

function ok() {
  return { code: 0, stdout: "", stderr: "" };
}

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() > until) return reject(new Error("timed out waiting"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function make(dir: string, run: Runner, extra: Partial<Parameters<Mod["createLocalInstaller"]>[0]> = {}) {
  return mod.createLocalInstaller({ dir, run, bunPath: () => FAKE_BUN, progressIntervalMs: 10, ...extra });
}

describe("local model install", () => {
  test("a fresh dir is not installed", () => {
    const installer = make(freshDir(), async () => ok());
    expect(installer.status()).toEqual({ state: "not-installed" });
  });

  test("writes package.json before bun add, then the host, then runs it with --warm", async () => {
    const dir = freshDir();
    const calls: Call[] = [];
    let installer!: ReturnType<Mod["createLocalInstaller"]>;
    const run: Runner = async (cmd, opts) => {
      const manifestPath = join(opts.cwd, "package.json");
      const hostPath = join(dir, EMBED_HOST_FILE);
      calls.push({
        cmd,
        cwd: opts.cwd,
        status: installer.status(),
        manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null,
        hostSource: existsSync(hostPath) ? readFileSync(hostPath, "utf8") : null,
      });
      return ok();
    };
    installer = make(dir, run);
    const seen: Status[] = [];
    installer.subscribe((s) => seen.push(s));

    const final = await installer.install();

    expect(calls.length).toBe(2);
    const [add, warm] = calls;
    expect(add!.cmd).toEqual([FAKE_BUN, "add", mod.LOCAL_EMBED_PACKAGE]);
    expect(mod.LOCAL_EMBED_PACKAGE).toBe("@huggingface/transformers@4.3.2");
    expect(add!.cwd).toBe(dir);
    expect(add!.manifest).not.toBeNull();
    expect(typeof add!.manifest).toBe("object");
    expect(add!.status.state).toBe("installing");

    expect(warm!.cmd).toEqual([FAKE_BUN, join(dir, EMBED_HOST_FILE), "--warm"]);
    expect(warm!.cwd).toBe(dir);
    expect(warm!.hostSource).toBe(EMBED_HOST_SOURCE);
    expect(warm!.status.state).toBe("installing");

    expect(final).toEqual({ state: "ready" });
    expect(installer.status()).toEqual({ state: "ready" });
    expect(seen[0]!.state).toBe("installing");
    expect(seen.at(-1)).toEqual({ state: "ready" });
  });

  test("a finished install is ready for a new installer on the same dir", async () => {
    const dir = freshDir();
    await make(dir, async () => ok()).install();
    expect(make(dir, async () => ok()).status()).toEqual({ state: "ready" });
  });

  test("a failing command leaves failed(reason), and a retry can succeed", async () => {
    const dir = freshDir();
    let fail = true;
    const installer = make(dir, async (cmd) =>
      fail && cmd[1] === "add" ? { code: 1, stdout: "", stderr: "error: network is down" } : ok(),
    );
    const final = await installer.install();
    expect(final.state).toBe("failed");
    expect(final.state === "failed" && final.reason).toContain("network is down");
    expect(installer.status()).toEqual(final);

    fail = false;
    expect(await installer.install()).toEqual({ state: "ready" });
  });

  test("a runner that throws, or a failed --warm, is failed(reason)", async () => {
    const throwing = make(freshDir(), async () => {
      throw new Error("Executable not found in $PATH");
    });
    const a = await throwing.install();
    expect(a.state).toBe("failed");
    expect(a.state === "failed" && a.reason).toContain("Executable not found");

    const warmFails = make(freshDir(), async (cmd) =>
      cmd.includes("--warm") ? { code: 1, stdout: "", stderr: "could not fetch model" } : ok(),
    );
    const b = await warmFails.install();
    expect(b.state).toBe("failed");
    expect(b.state === "failed" && b.reason).toContain("could not fetch model");
    expect(warmFails.status().state).toBe("failed");
  });

  test("no bun on the host is failed(reason), not a throw", async () => {
    const installer = mod.createLocalInstaller({
      dir: freshDir(),
      run: async () => ok(),
      bunPath: () => {
        throw new Error("bun not found");
      },
    });
    const final = await installer.install();
    expect(final.state).toBe("failed");
  });

  test("progress is the install dir's size against ~650 MB", async () => {
    const dir = freshDir();
    const half = 325 * 1024 * 1024;
    const seen: Status[] = [];
    let installer!: ReturnType<Mod["createLocalInstaller"]>;
    installer = make(dir, async (cmd) => {
      if (cmd[1] === "add") {
        mkdirSync(join(dir, "node_modules"), { recursive: true });
        const fd = openSync(join(dir, "node_modules", "blob.bin"), "w");
        ftruncateSync(fd, half); // sparse: apparent size only
        closeSync(fd);
        await waitFor(() => seen.some((s) => s.state === "installing" && s.bytes >= half));
      }
      return ok();
    });
    installer.subscribe((s) => seen.push(s));
    expect(await installer.install()).toEqual({ state: "ready" });

    expect(mod.EXPECTED_INSTALL_BYTES).toBeGreaterThanOrEqual(600 * 1024 * 1024);
    expect(mod.EXPECTED_INSTALL_BYTES).toBeLessThanOrEqual(700 * 1024 * 1024);
    const progress = seen.find((s) => s.state === "installing" && s.bytes >= half);
    expect(progress).toBeDefined();
    if (progress?.state !== "installing") throw new Error("unreachable");
    expect(progress.totalBytes).toBe(mod.EXPECTED_INSTALL_BYTES);
    expect(progress.bytes).toBeLessThan(mod.EXPECTED_INSTALL_BYTES);
  });

  test("two concurrent installs share one run", async () => {
    const dir = freshDir();
    let adds = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const installer = make(dir, async (cmd) => {
      if (cmd[1] === "add") {
        adds++;
        await gate;
      }
      return ok();
    });
    const a = installer.install();
    const b = installer.install();
    await waitFor(() => adds > 0);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(adds).toBe(1);
    expect(ra).toEqual({ state: "ready" });
    expect(rb).toEqual({ state: "ready" });
  });

  test("cancel stops the run and leaves not-installed", async () => {
    const dir = freshDir();
    let signal: AbortSignal | undefined;
    let warmed = false;
    const installer = make(dir, async (cmd, opts) => {
      if (cmd.includes("--warm")) {
        warmed = true;
        return ok();
      }
      signal = opts.signal;
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener("abort", () => resolve());
      });
      return { code: 143, stdout: "", stderr: "killed" };
    });
    const pending = installer.install();
    await waitFor(() => signal !== undefined);
    expect(installer.status().state).toBe("installing");

    await installer.cancel();
    expect(signal!.aborted).toBe(true);
    expect(await pending).toEqual({ state: "not-installed" });
    expect(installer.status()).toEqual({ state: "not-installed" });
    expect(warmed).toBe(false);
    expect(make(dir, async () => ok()).status()).toEqual({ state: "not-installed" });
  });

  test("uninstall removes the dir", async () => {
    const dir = freshDir();
    const installer = make(dir, async () => ok());
    expect(await installer.install()).toEqual({ state: "ready" });
    writeFileSync(join(dir, "extra.txt"), "x");
    await installer.uninstall();
    expect(existsSync(dir)).toBe(false);
    expect(installer.status()).toEqual({ state: "not-installed" });
  });

  test("the default installer lives in embedInstallDir()", async () => {
    const { embedInstallDir } = await import("../../../src/services/memory/memory-paths.ts");
    expect(mod.localInstaller().dir).toBe(embedInstallDir());
    expect(embedInstallDir().startsWith(process.env.PPM_HOME!)).toBe(true);
  });
});
