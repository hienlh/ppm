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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
import {
  LANGUAGE_SERVERS,
  serverById,
  type LanguageServerDefinition,
  type ReleaseAsset,
} from "../../../../src/services/lsp/server-registry.ts";
import type { FetchFn } from "../../../../src/services/speech-to-text/whisper-download.ts";

const originalPpmHome = process.env.PPM_HOME;
const originalPath = process.env.PATH;
const temps: string[] = [];

function tempDir(prefix = "ppm-lsp-install-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * A PATH holding nothing but executables with these names, so `Bun.which` finds exactly them.
 *
 * Windows resolves a bare command through `PATHEXT`, so a file called `go` with a shebang is
 * not an executable there and `Bun.which` walks straight past it — which made every Go and
 * rustup case here fail on Windows while passing everywhere else.
 */
function fakeToolchain(...names: string[]): string {
  const dir = tempDir("ppm-fake-bin-");
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\nexit /b 0\r\n");
      continue;
    }
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
function fakeRunner(options: {
  result?: Partial<RunResult>;
  onRun?: (call: Call) => void;
  /** A per-call answer, taking precedence over `result`. */
  answer?: (call: Call) => Partial<RunResult> | undefined;
} = {}) {
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;

  const run: Runner = async (cmd, opts) => {
    const call: Call = { cmd, cwd: opts.cwd, env: opts.env, manifestExisted: existsSync(join(opts.cwd, "package.json")) };
    calls.push(call);
    if (held) await gate;
    options.onRun?.(call);
    return { code: 0, stdout: "", stderr: "", ...options.result, ...options.answer?.(call) };
  };

  return { run, calls, hold: () => { held = true; }, release };
}

const typescript = serverById("typescript")!;
const gopls = serverById("gopls")!;
/** What `go install` leaves in `GOBIN`, which carries `.exe` on Windows — as the product expects. */
const GOPLS_BIN = process.platform === "win32" ? "gopls.exe" : "gopls";
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
      onRun: (call) => writeFileSync(join(call.env!.GOBIN!, GOPLS_BIN), "binary"),
    });

    await installLanguageServer(gopls, { run });

    expect(calls[0]!.cmd.slice(1)).toEqual(["install", "golang.org/x/tools/gopls@latest"]);
    expect(calls[0]!.env!.GOBIN).toBe(join(lspInstallDir(), "bin"));
    // The caches stay where the user's Go keeps them; only the destination is PPM's.
    expect(calls[0]!.env!.GOMODCACHE).toBeUndefined();
    expect(existsSync(join(lspInstallDir(), "bin", GOPLS_BIN))).toBe(true);
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

const solargraph = serverById("solargraph")!;
const HOST = `${process.platform}-${process.arch}`;
const RELEASE_BYTES = new TextEncoder().encode("pretend this is a release archive");
const RELEASE_SHA = new Bun.CryptoHasher("sha256").update(RELEASE_BYTES).digest("hex");
const RELEASE_URL = "https://example.test/fake-release-1.2.3.tar.gz";

/** A server shipped as a release build, with one asset for `key` (this host by default). */
function releaseServer(asset: Partial<ReleaseAsset> = {}, key = HOST): LanguageServerDefinition {
  return {
    ...serverById("lua")!,
    id: "fake-release",
    displayName: "Fake Release",
    command: "fake-release",
    install: {
      with: "download",
      version: "1.2.3",
      assets: { [key]: { url: RELEASE_URL, sha256: RELEASE_SHA, archive: "tar.gz", binary: "pkg/bin/fake-release", ...asset } },
    },
  };
}

/** A fetch that serves `bytes` for any URL and remembers which ones were asked for. */
function fakeFetch(bytes: Uint8Array = RELEASE_BYTES) {
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(bytes);
  }) as FetchFn;
  return { fetchFn, urls };
}

/**
 * A runner standing in for `tar` and for the unpacked server: unpacking writes `files` under
 * the destination it was given, and `--version` answers with `probe`.
 */
function releaseRunner(options: { files?: string[]; probe?: Partial<RunResult> } = {}) {
  const files = options.files ?? ["pkg/bin/fake-release", "pkg/lib/data.txt"];
  return fakeRunner({
    onRun: (call) => {
      if (call.cmd[1] !== "-xzf") return;
      const dest = call.cmd[4]!;
      for (const file of files) {
        mkdirSync(dirname(join(dest, file)), { recursive: true });
        writeFileSync(join(dest, file), file);
      }
    },
    answer: (call) => (call.cmd[1] === "--version" ? options.probe : undefined),
  });
}

describe("installing a release build", () => {
  it("downloads the pinned build, unpacks it beside the target, proves it starts, then swaps it in", async () => {
    fakeToolchain("tar");
    const { fetchFn, urls } = fakeFetch();
    const { run, calls } = releaseRunner();

    await installLanguageServer(releaseServer(), { run, fetchFn });

    expect(urls).toEqual([RELEASE_URL]);
    const [unpack, probe] = calls;
    const stage = dirname(unpack!.cmd[2]!);
    // Staged inside PPM's own folder, so the final rename never crosses a filesystem.
    expect(dirname(stage)).toBe(lspInstallDir());
    expect(basename(stage).startsWith(".fake-release-")).toBe(true);
    // The fake tar, which Windows finds as `tar.cmd` through PATHEXT.
    expect(basename(unpack!.cmd[0]!).replace(/\.cmd$/i, "")).toBe("tar");
    expect(unpack!.cmd.slice(1)).toEqual(["-xzf", join(stage, "fake-release-1.2.3.tar.gz"), "-C", join(stage, "release")]);
    expect(probe!.cmd).toEqual([join(stage, "release", "pkg", "bin", "fake-release"), "--version"]);

    const binary = join(lspInstallDir(), "fake-release", "pkg", "bin", "fake-release");
    expect(readFileSync(binary, "utf8")).toBe("pkg/bin/fake-release");
    expect(existsSync(join(lspInstallDir(), "fake-release", "pkg", "lib", "data.txt"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(binary).mode & 0o111).not.toBe(0);
    // Nothing left of the staging folder.
    expect(readdirSync(lspInstallDir())).toEqual(["fake-release"]);
  });

  it("runs nothing when the download does not match its pinned checksum", async () => {
    fakeToolchain("tar");
    const { fetchFn } = fakeFetch(new TextEncoder().encode("something else"));
    const { run, calls } = releaseRunner();

    await expect(installLanguageServer(releaseServer(), { run, fetchFn })).rejects.toThrow(/checksum mismatch/);
    expect(calls).toEqual([]);
    expect(readdirSync(lspInstallDir())).toEqual([]);
  });

  it("keeps the previous install when the new build does not start on this host", async () => {
    fakeToolchain("tar");
    const previous = join(lspInstallDir(), "fake-release", "previous.txt");
    mkdirSync(dirname(previous), { recursive: true });
    writeFileSync(previous, "still here");
    const { fetchFn } = fakeFetch();
    const { run } = releaseRunner({ probe: { code: 1, stderr: "version `GLIBC_2.38' not found" } });

    await expect(installLanguageServer(releaseServer(), { run, fetchFn }))
      .rejects.toThrow(/does not start on this host.*GLIBC_2\.38/s);
    expect(readFileSync(previous, "utf8")).toBe("still here");
    expect(readdirSync(lspInstallDir())).toEqual(["fake-release"]);
  });

  it("keeps the previous install when the new build cannot be put in its place", async () => {
    fakeToolchain("tar");
    const previous = join(lspInstallDir(), "fake-release", "previous.txt");
    mkdirSync(dirname(previous), { recursive: true });
    writeFileSync(previous, "still here");
    const { run: unpackAndProbe } = releaseRunner();
    // The build is gone by the time it is moved into place, so that rename fails — as one does on
    // Windows while an antivirus scanner holds the executable it has just been handed.
    const run: Runner = async (cmd, options) => {
      const result = await unpackAndProbe(cmd, options);
      if (cmd[1] === "--version") rmSync(join(options.cwd, "release"), { recursive: true, force: true });
      return result;
    };

    await expect(installLanguageServer(releaseServer(), { run, fetchFn: fakeFetch().fetchFn })).rejects.toThrow();
    expect(readFileSync(previous, "utf8")).toBe("still here");
    expect(readdirSync(lspInstallDir())).toEqual(["fake-release"]);
  });

  it("fails when the archive does not hold the binary it should", async () => {
    fakeToolchain("tar");
    const { fetchFn } = fakeFetch();
    const { run } = releaseRunner({ files: ["somewhere/else"] });

    await expect(installLanguageServer(releaseServer(), { run, fetchFn })).rejects.toThrow(/has no pkg\/bin\/fake-release/);
    expect(readdirSync(lspInstallDir())).toEqual([]);
  });

  it("refuses a host with no build, without downloading anything", async () => {
    fakeToolchain("tar");
    const { fetchFn, urls } = fakeFetch();
    const { run, calls } = releaseRunner();

    await expect(installLanguageServer(releaseServer({}, "plan9-mips"), { run, fetchFn }))
      .rejects.toThrow(/no build of Fake Release for this machine/);
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("removes the whole release folder, and runs nothing to do it", async () => {
    fakeToolchain("tar");
    await installLanguageServer(releaseServer(), { run: releaseRunner().run, fetchFn: fakeFetch().fetchFn });
    const { run, calls } = fakeRunner();

    await uninstallLanguageServer(releaseServer(), { run });
    expect(existsSync(join(lspInstallDir(), "fake-release"))).toBe(false);
    expect(calls).toEqual([]);
    await expect(uninstallLanguageServer(releaseServer(), { run })).rejects.toThrow(/not in PPM's own folder/);
  });

  it("pins every published build by version and checksum", () => {
    for (const server of LANGUAGE_SERVERS) {
      if (server.install?.with !== "download") continue;
      const { version, assets } = server.install;
      expect(Object.keys(assets).length).toBeGreaterThan(0);
      for (const asset of Object.values(assets)) {
        expect(asset.url).toStartWith("https://github.com/");
        expect(asset.url).toContain(version);
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.binary.split("/")).not.toContain("..");
      }
    }
  });
});

describe.skipIf(process.platform === "win32")("installing a gem server", () => {
  const savedGem = { home: process.env.GEM_HOME, path: process.env.GEM_PATH };
  afterEach(() => {
    for (const [key, value] of [["GEM_HOME", savedGem.home], ["GEM_PATH", savedGem.path]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** What `gem install --bindir` leaves: the binstub. */
  const writeBinstub = (call: Call) => {
    const bindir = call.cmd[call.cmd.indexOf("--bindir") + 1]!;
    mkdirSync(bindir, { recursive: true });
    writeFileSync(join(bindir, "solargraph"), "#!/usr/bin/env ruby\n");
  };

  it("installs into PPM's own gem folder, with none of the user's gem paths", async () => {
    const tools = fakeToolchain("gem");
    process.env.GEM_HOME = "/home/someone/.gem";
    process.env.GEM_PATH = "/home/someone/.gem:/usr/lib/ruby/gems";
    const { run, calls } = fakeRunner({ onRun: writeBinstub });

    await installLanguageServer(solargraph, { run });

    const gemDir = join(lspInstallDir(), "ruby");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual([
      join(tools, "gem"), "install", "--no-document", "--install-dir", gemDir, "--bindir", join(gemDir, "bin"), "solargraph",
    ]);
    expect(calls[0]!.cwd).toBe(lspInstallDir());
    expect(calls[0]!.env?.GEM_HOME).toBeUndefined();
    expect(calls[0]!.env?.GEM_PATH).toBeUndefined();
    expect(calls[0]!.env?.PATH).toBe(tools);
  });

  it("says a compiler is missing when a native extension fails, and leaves no half install", async () => {
    fakeToolchain("gem");
    const { run } = fakeRunner({
      onRun: (call) => mkdirSync(join(call.cmd[call.cmd.indexOf("--install-dir") + 1]!, "gems", "prism-1.9.0"), { recursive: true }),
      result: { code: 1, stderr: "ERROR:  Error installing solargraph:\n\tERROR: Failed to build gem native extension.\n\nextconf failed" },
    });

    await expect(installLanguageServer(solargraph, { run })).rejects.toThrow(/needs a C compiler/);
    expect(existsSync(join(lspInstallDir(), "ruby"))).toBe(false);
  });

  it("keeps a working install when updating it fails", async () => {
    fakeToolchain("gem");
    await installLanguageServer(solargraph, { run: fakeRunner({ onRun: writeBinstub }).run });
    const { run } = fakeRunner({ result: { code: 1, stderr: "ERROR:  Could not find a valid gem 'solargraph'" } });

    await expect(installLanguageServer(solargraph, { run })).rejects.toThrow(/failed to install.*valid gem/s);
    expect(existsSync(join(lspInstallDir(), "ruby", "bin", "solargraph"))).toBe(true);
  });

  it("fails when gem reported success but left no binstub", async () => {
    fakeToolchain("gem");
    const { run } = fakeRunner();
    await expect(installLanguageServer(solargraph, { run })).rejects.toThrow(/no solargraph appeared/);
  });

  it("removes the whole gem folder, dependencies included, and runs nothing to do it", async () => {
    fakeToolchain("gem");
    await installLanguageServer(solargraph, { run: fakeRunner({ onRun: writeBinstub }).run });
    const { run, calls } = fakeRunner();

    await uninstallLanguageServer(solargraph, { run });
    expect(existsSync(join(lspInstallDir(), "ruby"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("has one gem plan at most, since removing one deletes the folder every gem shares", () => {
    expect(LANGUAGE_SERVERS.filter((s) => s.install?.with === "gem").map((s) => s.id)).toEqual(["solargraph"]);
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

  it("offers a download only where there is a build for this host and a tool to unpack it", () => {
    fakeToolchain("tar");
    expect(canInstall(releaseServer())).toBe(true);
    // A build for some other machine is no build at all, whatever is on PATH.
    expect(canInstall(releaseServer({}, "plan9-mips"))).toBe(false);

    process.env.PATH = "";
    expect(canInstall(releaseServer())).toBe(false);
  });

  it("unpacks a zip with unzip or bsdtar off Windows, since GNU tar reads no zip", () => {
    const zip = releaseServer({ archive: "zip" });
    fakeToolchain("tar");
    expect(canInstall(zip)).toBe(process.platform === "win32");
    fakeToolchain("bsdtar");
    expect(canInstall(zip)).toBe(process.platform !== "win32");
    fakeToolchain("unzip");
    expect(canInstall(zip)).toBe(process.platform !== "win32");
  });

  it.skipIf(process.platform === "win32")("offers a gem install only where Ruby's gem is", () => {
    fakeToolchain("gem");
    expect(canInstall(solargraph)).toBe(true);
    process.env.PATH = "";
    expect(canInstall(solargraph)).toBe(false);
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
    const binary = join(lspInstallDir(), "bin", GOPLS_BIN);
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
    const planless = { ...serverById("clangd")!, install: undefined } as LanguageServerDefinition;

    await expect(installLanguageServer(planless, { run })).rejects.toThrow(/cannot install/);
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
