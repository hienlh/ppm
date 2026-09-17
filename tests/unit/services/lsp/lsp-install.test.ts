/**
 * The Install button's half on the host.
 *
 * Against a fake runner, because the thing worth pinning is not that bun, go and rustup work —
 * it is *where* each install lands, *what* argv and environment it is given, that a server PPM
 * cannot install is refused before anything runs, and that two presses of one button do not run
 * two installs over one lockfile. The real installs are exercised by `tests/e2e/lsp-e2e.ts`.
 *
 * `PATH` is emptied or pointed at a fake toolchain in places, which is the only honest way to
 * test a host that has no Go — the same trick the Services collector needed for a host with no
 * `systemctl`.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  canInstall,
  installLanguageServer,
  lspInstallDir,
  rustupServerPath,
  uninstallLanguageServer,
  type RunResult,
  type Runner,
} from "../../../../src/services/lsp/lsp-install.ts";
import { serverById, type LanguageServerDefinition } from "../../../../src/services/lsp/server-registry.ts";

const originalPpmHome = process.env.PPM_HOME;
const originalPath = process.env.PATH;
const temps: string[] = [];

function tempDir(prefix = "ppm-lsp-install-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A PATH holding nothing but executables with these names, so `Bun.which` finds exactly them. */
function fakeToolchain(...names: string[]): string {
  const dir = tempDir("ppm-fake-bin-");
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  process.env.PATH = dir;
  return dir;
}

beforeEach(() => {
  process.env.PPM_HOME = tempDir("ppm-lsp-install-home-");
  process.env.PATH = originalPath;
  _resetPpmDir();
});

afterEach(() => {
  process.env.PATH = originalPath;
});

afterAll(() => {
  // PPM_HOME and PATH are process-wide: a suite that leaves either pointing at a temp directory
  // it has just deleted breaks whichever file bun runs next, and only in that order.
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  process.env.PATH = originalPath;
  _resetPpmDir();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** What was on disk when the command was handed the directory. */
  manifestExisted: boolean;
}

/**
 * A runner that records every command and answers with canned results.
 *
 * `onRun` is where a test writes what a successful install would have left behind, and `hold`
 * keeps one running — the only way to see that a second press joined the first rather than
 * starting its own.
 */
function fakeRunner(options: { result?: Partial<RunResult>; onRun?: (call: Call) => void } = {}) {
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;

  const run: Runner = async (cmd, opts) => {
    const call: Call = { cmd, cwd: opts.cwd, env: opts.env, manifestExisted: existsSync(join(opts.cwd, "package.json")) };
    calls.push(call);
    if (held) await gate;
    options.onRun?.(call);
    return { code: 0, stdout: "", stderr: "", ...options.result };
  };

  return { run, calls, hold: () => { held = true; }, release };
}

const typescript = serverById("typescript")!;
const gopls = serverById("gopls")!;
const rustAnalyzer = serverById("rust-analyzer")!;

/** What `bun add typescript-language-server` leaves: the package, with its bin. */
function writeNpmPackage(dir: string): void {
  const pkgDir = join(dir, "node_modules", "typescript-language-server");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "typescript-language-server", bin: { "typescript-language-server": "lib/cli.mjs" } }),
  );
}

describe("installing an npm server", () => {
  it("runs `bun add` for the registry's packages, in PPM's own directory", async () => {
    const { run, calls } = fakeRunner({ onRun: (call) => writeNpmPackage(call.cwd) });

    await installLanguageServer(typescript, { run });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd.slice(1)).toEqual(["add", "typescript-language-server", "typescript@5"]);
    // Never `-g`: a global `typescript@5` replaces whatever TypeScript the user had installed
    // globally, and a global bin directory is only found when it is on the service's PATH.
    expect(calls[0]!.cmd).not.toContain("-g");
    expect(calls[0]!.cmd[0]).toMatch(/bun/);
    expect(calls[0]!.cwd).toBe(lspInstallDir());
    expect(lspInstallDir().startsWith(process.env.PPM_HOME!)).toBe(true);
  });

  it("writes the directory's own package.json before bun is let near it", async () => {
    // Measured: `bun add` in a directory with no manifest does not create one there. It walks
    // *up* to the nearest parent that has one and installs into that, leaving the directory it
    // was asked about empty — so PPM would report "not installed" forever while a package
    // appeared somewhere above the PPM directory.
    const { run, calls } = fakeRunner({ onRun: (call) => writeNpmPackage(call.cwd) });

    await installLanguageServer(typescript, { run });

    expect(calls[0]!.manifestExisted).toBe(true);
    expect(JSON.parse(readFileSync(join(lspInstallDir(), "package.json"), "utf8")).private).toBe(true);
  });

  it("reports what bun said when the install fails", async () => {
    const { run } = fakeRunner({ result: { code: 1, stderr: "error: GET https://registry.npmjs.org/nope - 404" } });

    await expect(installLanguageServer(typescript, { run })).rejects.toThrow(/failed to install.*404/s);
  });

  it("fails when bun succeeded but left nothing to run", async () => {
    // A package that dropped or renamed its binary. Reporting success here means the editor
    // says "not installed" again with no idea why, one round trip later.
    const { run } = fakeRunner();

    await expect(installLanguageServer(typescript, { run })).rejects.toThrow(/provides no typescript-language-server/);
  });
});

describe("installing a Go server", () => {
  it("builds it into PPM's bin directory with GOBIN, never into the user's", async () => {
    fakeToolchain("go");
    const { run, calls } = fakeRunner({
      onRun: (call) => writeFileSync(join(call.env!.GOBIN!, "gopls"), "binary"),
    });

    await installLanguageServer(gopls, { run });

    expect(calls[0]!.cmd.slice(1)).toEqual(["install", "golang.org/x/tools/gopls@latest"]);
    expect(calls[0]!.env!.GOBIN).toBe(join(lspInstallDir(), "bin"));
    // The caches stay where the user's Go keeps them; only the destination is PPM's.
    expect(calls[0]!.env!.GOMODCACHE).toBeUndefined();
    expect(existsSync(join(lspInstallDir(), "bin", "gopls"))).toBe(true);
  });

  it("fails when the build reported success but produced no binary", async () => {
    fakeToolchain("go");
    const { run } = fakeRunner();

    await expect(installLanguageServer(gopls, { run })).rejects.toThrow(/no gopls appeared/);
  });

  it("refuses before running anything when the host has no Go", async () => {
    // PPM installs servers, never toolchains. Reproduced by taking the toolchain away rather
    // than by stubbing the thing under test.
    process.env.PATH = "";
    const { run, calls } = fakeRunner();

    await expect(installLanguageServer(gopls, { run })).rejects.toThrow(/go is not installed on this host/);
    expect(calls).toEqual([]);
  });
});

describe("installing rust-analyzer", () => {
  it("adds the component in the project's own directory, so its toolchain gets it", async () => {
    // A repository with a `rust-toolchain.toml` pins its own toolchain, and the component has
    // to land in *that* one or the server it asks for still is not there.
    fakeToolchain("rustup");
    const project = tempDir("ppm-rust-project-");
    const { run, calls } = fakeRunner({ result: { stdout: "/home/ada/.rustup/toolchains/stable/bin/rust-analyzer\n" } });

    await installLanguageServer(rustAnalyzer, { projectPath: project, run });

    expect(calls[0]!.cmd.slice(1)).toEqual(["component", "add", "rust-analyzer"]);
    expect(calls[0]!.cwd).toBe(project);
    // And it checks with rustup rather than trusting the exit code.
    expect(calls[1]!.cmd.slice(1)).toEqual(["which", "rust-analyzer"]);
  });

  it("fails when rustup exits happily but still has no such binary", async () => {
    fakeToolchain("rustup");
    const { run } = fakeRunner({ result: { stdout: "" } });

    await expect(installLanguageServer(rustAnalyzer, { run })).rejects.toThrow(/still has no rust-analyzer/);
  });

  it("keeps nothing of its own: rustup says where the server is", async () => {
    fakeToolchain("rustup");
    const path = "/home/ada/.rustup/toolchains/nightly/bin/rust-analyzer";
    const found = await rustupServerPath(rustAnalyzer, "/repo", async () => ({ code: 0, stdout: `${path}\n`, stderr: "" }));

    expect(found).toBe(path);
  });

  it("answers null when the component is not installed", async () => {
    // The proxy in `~/.cargo/bin` exists whether or not the component does — measured on this
    // host, with no rust-analyzer installed, the file is there and points at rustup. Only
    // `rustup which` can tell the difference, and it exits non-zero.
    fakeToolchain("rustup");
    const missing = await rustupServerPath(rustAnalyzer, "/repo", async () => ({
      code: 1, stdout: "", stderr: "error: unknown binary 'rust-analyzer' in toolchain 'stable-x86_64-unknown-linux-gnu'",
    }));

    expect(missing).toBeNull();
    // And it is not asked at all for a server that does not come from rustup.
    expect(await rustupServerPath(typescript, "/repo", async () => ({ code: 0, stdout: "/x", stderr: "" }))).toBeNull();
  });
});

describe("what the host can install at all", () => {
  it("offers the toolchain installs only where the toolchain is", () => {
    // The lookup is PATH on purpose: it is the same PATH the language server would inherit, so
    // a host where PPM cannot see Go is one where gopls could not run `go list` either.
    fakeToolchain("go", "rustup");
    expect(canInstall(gopls)).toBe(true);
    expect(canInstall(rustAnalyzer)).toBe(true);

    process.env.PATH = "";
    expect(canInstall(gopls)).toBe(false);
    expect(canInstall(rustAnalyzer)).toBe(false);
    // bun is resolved by path rather than by PATH, so an npm server survives an empty one.
    expect(canInstall(typescript)).toBe(true);
  });

  it("says no for a server that comes from a system package manager", () => {
    for (const id of ["clangd", "lua", "solargraph"]) {
      expect(canInstall(serverById(id)!)).toBe(false);
    }
  });
});

describe("two presses, one install", () => {
  it("joins a second press to the install already running", async () => {
    const { run, calls, hold, release } = fakeRunner({ onRun: (call) => writeNpmPackage(call.cwd) });
    hold();

    const first = installLanguageServer(typescript, { run });
    const second = installLanguageServer(typescript, { run });
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
  });

  it("runs one install at a time, because they share one lockfile", async () => {
    const { run, calls, hold, release } = fakeRunner({ onRun: (call) => writeNpmPackage(call.cwd) });
    hold();

    const first = installLanguageServer(typescript, { run });
    // A second server, so it is the queue holding it and not the per-id join above.
    const second = installLanguageServer({ ...typescript, id: "typescript-2" }, { run });
    await Promise.resolve();
    expect(calls).toHaveLength(1); // still queued behind the first

    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
  });

  it("lets the next install run after one has failed", async () => {
    const failing = fakeRunner({ result: { code: 1, stderr: "error: 404" } });
    await expect(installLanguageServer(typescript, { run: failing.run })).rejects.toThrow();

    const { run, calls } = fakeRunner({ onRun: (call) => writeNpmPackage(call.cwd) });
    await installLanguageServer(typescript, { run });

    expect(calls).toHaveLength(1);
  });
});

describe("removing a server", () => {
  it("runs `bun remove` for the package names, in PPM's own directory", async () => {
    writeNpmPackage(lspInstallDir());
    const { run, calls } = fakeRunner();

    await uninstallLanguageServer(typescript, { run });

    expect(calls).toHaveLength(1);
    // By **name**: `bun remove typescript@5` is not the request `bun remove typescript` is, and
    // the manifest the removal has to match holds the name.
    expect(calls[0]!.cmd.slice(1)).toEqual(["remove", "typescript-language-server", "typescript"]);
    expect(calls[0]!.cwd).toBe(lspInstallDir());
  });

  it("refuses an npm server that is not in PPM's folder, without running anything", async () => {
    // The one on PATH is the user's and the bundled one is PPM's own dependency. Neither is
    // this function's to delete, and the route gates on the same question — but a function that
    // removes things may not rely on its caller having checked.
    const { run, calls } = fakeRunner();

    await expect(uninstallLanguageServer(typescript, { run })).rejects.toThrow(/not in PPM's own folder/);
    expect(calls).toEqual([]);
  });

  it("deletes the Go binary PPM built, and runs no toolchain at all", async () => {
    const binary = join(lspInstallDir(), "bin", "gopls");
    mkdirSync(join(lspInstallDir(), "bin"), { recursive: true });
    writeFileSync(binary, "binary");
    const { run, calls } = fakeRunner();

    await uninstallLanguageServer(gopls, { run });

    expect(existsSync(binary)).toBe(false);
    // `go clean -i` would reach into the user's module cache. The file GOBIN put here is the
    // whole of what PPM installed.
    expect(calls).toEqual([]);
  });

  it("takes the rustup component out of the toolchain, since there is no copy of PPM's", async () => {
    fakeToolchain("rustup");
    const { run, calls } = fakeRunner();

    await uninstallLanguageServer(rustAnalyzer, { run });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd.slice(1)).toEqual(["component", "remove", "rust-analyzer"]);
  });

  it("reports what the command said when a removal fails", async () => {
    writeNpmPackage(lspInstallDir());
    const { run } = fakeRunner({ result: { code: 1, stderr: "error: EACCES" } });

    await expect(uninstallLanguageServer(typescript, { run })).rejects.toThrow(/Could not remove.*EACCES/s);
  });

  it("joins a second press rather than running a second removal", async () => {
    writeNpmPackage(lspInstallDir());
    const { run, calls, hold, release } = fakeRunner();
    hold();

    const first = uninstallLanguageServer(typescript, { run });
    const second = uninstallLanguageServer(typescript, { run });
    release();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
  });
});

describe("what it refuses", () => {
  it("refuses a server PPM has no plan for, without running anything", async () => {
    const { run, calls } = fakeRunner();
    const clangd = serverById("clangd")!;
    expect(clangd.install).toBeUndefined();

    await expect(installLanguageServer(clangd, { run })).rejects.toThrow(/cannot install/);
    expect(calls).toEqual([]);
  });

  it("takes its packages from the definition, never from the caller's id", async () => {
    // The route looks the definition up by id and passes the definition itself, so a browser
    // cannot name a package. This is the property that keeps that true.
    const forged = { ...typescript, install: undefined } as LanguageServerDefinition;
    const { run, calls } = fakeRunner();

    await expect(installLanguageServer(forged, { run })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
