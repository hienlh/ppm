/**
 * Installing a language server, when someone presses Install.
 *
 * Nothing here runs because a file was opened. The editor says which server is missing and
 * offers the button; pressing it is the consent, and that is the whole difference between this
 * and an editor that fetches a binary off the network on its own.
 *
 * Four decisions worth keeping:
 *
 * - **Into `<ppm dir>/lsp-servers`, never `-g` and never `~/go/bin`.** A global
 *   `bun add typescript@5` replaces whatever TypeScript the user had installed globally, and a
 *   global bin directory is only found when it happens to be on the *service's* PATH — which
 *   for a systemd-started PPM is four entries and nothing of the sort. PPM's own directory is
 *   neither, `PPM_HOME` already isolates it for tests, and deleting it is the whole uninstall.
 *   `rustup` is the one exception, below.
 * - **The packages come from the registry, by server id.** Nothing the browser sends is ever
 *   part of a command, so the route cannot be talked into installing something else.
 * - **PPM installs servers, never toolchains.** `go install` needs a Go, `gem install` a Ruby
 *   and `rustup component add` a rustup; where the host has none, there is no button at all
 *   rather than one that fails when pressed. A server whose project publishes a build (clangd,
 *   lua-language-server) needs no toolchain: the pinned release is downloaded, checked against
 *   its SHA-256 and unpacked — and proven to start with `--version` before it counts.
 * - **The directory gets a `package.json` before `bun add` runs.** Measured: `bun add` in a
 *   directory with no manifest does not create one there — it walks *up* to the nearest parent
 *   that has one and installs into that, leaving the directory it was asked about empty.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveBunPath } from "../autostart-generator.ts";
import { createLogger } from "../logger.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { downloadVerified, type FetchFn } from "../speech-to-text/whisper-download.ts";
import {
  gemInstallDir,
  installedBinaryPath,
  installedServerEntry,
  packageName,
  releaseAssetFor,
  type LanguageServerDefinition,
  type LanguageServerInstall,
  type ReleaseAsset,
} from "./server-registry.ts";

const log = createLogger("lsp");

/** Generous: a cold `go install` builds the server from source. 10.6 s here, minutes elsewhere. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** `rustup which` is a lookup, not work. Measured at 3 ms; anything near this is a hung host. */
const QUERY_TIMEOUT_MS = 10_000;

/** Where the Install button puts servers. Inside the PPM dir, so `PPM_HOME` isolates it. */
export function lspInstallDir(): string {
  return path.join(getPpmDir(), "lsp-servers");
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * How this module runs a command.
 *
 * One injectable seam for all of it, so a test can drive an install with no toolchain on the
 * machine — and named rather than `typeof Bun.spawn`, whose type widens the pipes back to a
 * union with a raw file descriptor that `new Response()` will not take.
 */
export type Runner = (
  cmd: string[],
  options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number },
) => Promise<RunResult>;

const runCommand: Runner = async (cmd, { cwd, env, timeoutMs }) => {
  const proc = Bun.spawn(cmd, { cwd, env: env as Record<string, string> | undefined, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    log.warn(`${path.basename(cmd[0] ?? "")} ${cmd[1] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s; killed pid=${proc.pid}`);
    proc.kill();
  }, timeoutMs);
  // Drained while it runs: a pipe nobody reads fills up, and a full pipe blocks the child
  // instead of failing it, so awaiting the exit first can wait forever on a noisy install.
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

/**
 * The binary that would carry out this plan, or null where the host has none.
 *
 * The lookup is `PATH`, deliberately: it is the same PATH a language server PPM starts will
 * inherit, so a host where PPM cannot see the Go toolchain is also a host where gopls could
 * not run `go list`. Offering the button there would install a server that cannot work.
 */
export function installToolPath(plan: LanguageServerInstall): string | null {
  if (plan.with === "bun") {
    try {
      return resolveBunPath();
    } catch {
      return null; // a compiled PPM on a host with no bun
    }
  }
  // The PATH is passed explicitly because `Bun.which` otherwise reads the one the *process
  // started with* and never looks at `process.env.PATH` again — measured: adding a directory to
  // it changes nothing, and neither does emptying it. The tool is then spawned by the absolute
  // path this returns, so the lookup and the run can never disagree.
  const which = (tool: string) => Bun.which(tool, { PATH: process.env.PATH ?? "" });
  if (plan.with === "download") {
    // No build for this host means no button, whatever is on PATH.
    const asset = releaseAssetFor(plan);
    return asset ? unpackToolPath(asset, which) : null;
  }
  // RubyGems writes a `.bat` binstub on Windows, which nothing here has been seen to spawn, so
  // Windows keeps the copyable command instead of a button that might install a dead server.
  if (plan.with === "gem") return process.platform === "win32" ? null : which("gem");
  return which(plan.with === "go" ? "go" : "rustup");
}

/**
 * What unpacks a release. `tar` reads a tarball everywhere, and a zip on Windows, whose
 * `tar.exe` is bsdtar (shipped since Windows 10). Elsewhere a zip needs `unzip` or libarchive's
 * `bsdtar`: GNU tar cannot read one, and neither can `Bun.Archive` ("Unrecognized archive format").
 */
function unpackToolPath(asset: ReleaseAsset, which: (tool: string) => string | null): string | null {
  if (asset.archive === "tar.gz" || process.platform === "win32") return which("tar");
  return which("unzip") ?? which("bsdtar");
}

function unpackCommand(tool: string, asset: ReleaseAsset, archive: string, dest: string): string[] {
  if (asset.archive === "tar.gz") return [tool, "-xzf", archive, "-C", dest];
  return /^unzip(\.exe)?$/i.test(path.basename(tool))
    ? [tool, "-q", archive, "-d", dest]
    : [tool, "-xf", archive, "-C", dest];
}

/** Whether the Install button can work here. The editor draws the button from this. */
export function canInstall(definition: LanguageServerDefinition): boolean {
  return definition.install ? installToolPath(definition.install) !== null : false;
}

/**
 * Where rustup says this server is, or null when the component is not installed.
 *
 * `rustup which` is both the lookup and the installed-check, and it has to be: the proxy in
 * `~/.cargo/bin` exists whether or not the component does — measured on this host, with no
 * rust-analyzer installed, `~/.cargo/bin/rust-analyzer` is right there pointing at rustup — so
 * a path test would report a server that cannot start. It answers in 3 ms, and it answers for
 * the toolchain `cwd` selects, which a symlink made at install time could not.
 */
export async function rustupServerPath(
  definition: LanguageServerDefinition,
  cwd: string,
  run: Runner = runCommand,
): Promise<string | null> {
  if (definition.install?.with !== "rustup") return null;
  const rustup = installToolPath(definition.install);
  if (!rustup) return null;
  try {
    const result = await run([rustup, "which", definition.command], { cwd, timeoutMs: QUERY_TIMEOUT_MS });
    const found = result.stdout.trim();
    return result.code === 0 && found ? found : null;
  } catch {
    return null;
  }
}

/** One at a time: every install and uninstall shares one `package.json`, lockfile and toolchain. */
let queue: Promise<unknown> = Promise.resolve();
/** Keyed by operation *and* id, so a second Uninstall click joins that uninstall — never an install. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Install one server, and resolve once it is really there.
 *
 * Two clicks on one button — a second tab, an impatient user — join the same install rather
 * than starting a second one over the first one's lockfile.
 */
export function installLanguageServer(
  definition: LanguageServerDefinition,
  options: { projectPath?: string; run?: Runner; fetchFn?: FetchFn } = {},
): Promise<void> {
  return enqueue(`install:${definition.id}`, async () => {
    // A failure needs no line here: the route answers it with a 500, which the access log records.
    const startedAt = performance.now();
    log.info(`installing ${describeInstall(definition)} scope=${options.projectPath ? "project" : "global"}`);
    await install(definition, options.projectPath, options.run ?? runCommand, options.fetchFn);
    log.info(`installed ${describeInstall(definition)} in ${Math.round(performance.now() - startedAt)}ms`);
  });
}

/**
 * Remove one server, running the exact inverse of what installed it.
 *
 * Offered only for a server PPM itself put there, which is a question about where it was
 * *found* rather than about what is on this machine — `lsp-manager.availability` answers it
 * with `origin`, and the route gates on that. A copy on `PATH` is the user's, one in a
 * project's `node_modules` is the repository's, and the one PPM ships is its own dependency:
 * deleting any of the three would be PPM tidying up after someone else.
 *
 * rustup is again the exception that reaches outside PPM's directory, for the same reason
 * installing it did — the component belongs to a toolchain and there is no copy of PPM's to
 * delete. Removing it is one `rustup component add` away from being back.
 */
export function uninstallLanguageServer(
  definition: LanguageServerDefinition,
  options: { projectPath?: string; run?: Runner } = {},
): Promise<void> {
  return enqueue(`uninstall:${definition.id}`, async () => {
    await uninstall(definition, options.projectPath, options.run ?? runCommand);
    log.info(`removed ${describeInstall(definition)}`);
  });
}

/** `<id> via <tool> (<what it installs>)`: registry values only, never anything from a request. */
function describeInstall(definition: LanguageServerDefinition): string {
  const plan = definition.install;
  if (!plan) return definition.id;
  const target = plan.with === "bun" ? plan.packages.join(" ")
    : plan.with === "go" ? plan.module
    : plan.with === "gem" ? plan.gem
    : plan.with === "download" ? plan.version
    : plan.component;
  return `${definition.id} via ${plan.with} (${target})`;
}

function enqueue(key: string, work: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const started = queue.then(work);
  queue = started.catch(() => {}); // a failure must not poison the queue behind it
  const tracked = started.finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  return tracked;
}

async function install(
  definition: LanguageServerDefinition,
  projectPath: string | undefined,
  run: Runner,
  fetchFn?: FetchFn,
): Promise<void> {
  const plan = definition.install;
  if (!plan) throw new Error(`PPM cannot install ${definition.displayName}`);
  const tool = installToolPath(plan);
  if (!tool) {
    throw new Error(
      plan.with === "download"
        ? `There is no build of ${definition.displayName} for this machine, or nothing here to unpack one.`
        : plan.with === "gem" && process.platform === "win32"
          ? `PPM does not install gems on Windows. Run: ${definition.installHint}`
          : `${plan.with} is not installed on this host, so PPM cannot install ${definition.displayName}.`,
    );
  }

  const dir = lspInstallDir();
  const failed = (result: RunResult, what: string) => new Error(`${what} failed to install: ${output(result)}`);

  if (plan.with === "bun") {
    ensureInstallDir(dir);
    const result = await run([tool, "add", ...plan.packages], { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) throw failed(result, plan.packages.join(" "));
    // bun can succeed and still leave nothing to run — a package that dropped its binary, or a
    // name that now points somewhere else. Saying so beats a second "not installed".
    if (!installedServerEntry(definition, dir)) {
      throw new Error(`Installed ${plan.packages.join(" ")}, but it provides no ${definition.command}`);
    }
    return;
  }

  if (plan.with === "download") {
    mkdirSync(dir, { recursive: true });
    await installRelease(definition, plan, tool, dir, run, fetchFn);
    return;
  }

  if (plan.with === "gem") {
    const gemDir = gemInstallDir(dir);
    // `--install-dir` keeps the gems out of the user's own gem home and `--bindir` puts the
    // binstub beside them rather than in a system bin directory. A GEM_HOME or GEM_PATH from
    // the user's environment is left out, so the install does not count gems elsewhere as
    // present and skip them — the server would then depend on folders PPM does not own.
    const { GEM_HOME: _home, GEM_PATH: _path, ...env } = process.env;
    mkdirSync(dir, { recursive: true });
    const fresh = !existsSync(gemDir);
    const result = await run(
      [tool, "install", "--no-document", "--install-dir", gemDir, "--bindir", path.join(gemDir, "bin"), plan.gem],
      { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      // gem leaves what it managed "for inspection"; a first install that failed has nothing
      // worth keeping, while a working one being updated must survive its update failing.
      if (fresh) rmSync(gemDir, { recursive: true, force: true });
      // Its own message ends on a log path; the cause is that some dependency (prism, rbs,
      // jaro_winkler) compiles C, and the host has no compiler — measured with one off PATH.
      if (/Failed to build gem native extension/.test(`${result.stderr}\n${result.stdout}`)) {
        throw new Error(
          `${plan.gem} needs a C compiler to build one of its gems, and this host has none on PATH`
          + ` (Linux: gcc and make; macOS: xcode-select --install). ${output(result)}`,
        );
      }
      throw failed(result, plan.gem);
    }
    const binstub = installedBinaryPath(definition, dir);
    if (!binstub || !existsSync(binstub)) {
      throw new Error(`Installed ${plan.gem}, but no ${definition.command} appeared in ${path.dirname(binstub ?? gemDir)}`);
    }
    return;
  }

  if (plan.with === "go") {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    // `GOBIN` is the whole reason this lands in PPM's directory rather than `~/go/bin`. The
    // module and build caches stay where the user's Go already keeps them — those are the
    // toolchain's, and re-downloading the world into the PPM directory would be rude.
    const result = await run([tool, "install", plan.module], {
      cwd: dir,
      env: { ...process.env, GOBIN: binDir },
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.code !== 0) throw failed(result, plan.module);
    const built = installedBinaryPath(definition, dir);
    if (!built || !existsSync(built)) {
      throw new Error(`Built ${plan.module}, but no ${definition.command} appeared in ${binDir}`);
    }
    return;
  }

  // rustup. Run where the project is, so a repository pinned to its own toolchain gets the
  // component added to *that* one rather than to whichever is default.
  const cwd = projectPath && existsSync(projectPath) ? projectPath : process.cwd();
  const result = await run([tool, "component", "add", plan.component], { cwd, timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) throw failed(result, plan.component);
  if (!(await rustupServerPath(definition, cwd, run))) {
    throw new Error(`rustup reported success but still has no ${definition.command} for this toolchain`);
  }
}

/** How long `--version` may take to prove an unpacked server starts on this host. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Download, verify, unpack and prove one release build, then swap it in whole.
 *
 * Everything happens in a staging folder beside the target, so the server folder only ever holds
 * a complete build that has started once: a failed download, a corrupt archive or a binary that
 * cannot run on this host (a glibc too old, the wrong architecture) leaves the previous install —
 * or nothing — exactly as it was.
 */
async function installRelease(
  definition: LanguageServerDefinition,
  plan: Extract<LanguageServerInstall, { with: "download" }>,
  tool: string,
  dir: string,
  run: Runner,
  fetchFn?: FetchFn,
): Promise<void> {
  const asset = releaseAssetFor(plan);
  if (!asset) throw new Error(`${definition.displayName} publishes no build for ${process.platform}-${process.arch}.`);
  const name = path.posix.basename(new URL(asset.url).pathname);
  const stage = mkdtempSync(path.join(dir, `.${definition.id}-`));
  try {
    const archive = path.join(stage, name);
    await downloadVerified({ url: asset.url, dest: archive, sha256: asset.sha256, fetchFn });
    const unpacked = path.join(stage, "release");
    mkdirSync(unpacked);
    const result = await run(unpackCommand(tool, asset, archive, unpacked), { cwd: stage, timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`Could not unpack ${name}: ${output(result)}`);

    const binary = path.join(unpacked, ...asset.binary.split("/"));
    if (!existsSync(binary)) throw new Error(`${name} has no ${asset.binary}`);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
    const probe = await run([binary, "--version"], { cwd: stage, timeoutMs: PROBE_TIMEOUT_MS });
    if (probe.code !== 0) {
      throw new Error(`${definition.displayName} ${plan.version} does not start on this host: ${output(probe)}`);
    }

    // Swapped by renames, never by deleting first: the working install waits in the stage until
    // the new one is in place and goes back if it cannot be, so a rename Windows refuses (an
    // antivirus scanning the new exe, a server still running from the old folder) costs nothing.
    const target = path.join(dir, definition.id);
    const previous = path.join(stage, "previous");
    let movedAside = false;
    try {
      renameSync(target, previous);
      movedAside = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    try {
      renameSync(unpacked, target);
    } catch (e) {
      if (movedAside) renameSync(previous, target);
      throw e;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function uninstall(definition: LanguageServerDefinition, projectPath: string | undefined, run: Runner): Promise<void> {
  const plan = definition.install;
  // Both of these are the route's job to prevent; they are here because this function deletes
  // things, and "the caller checked" is not a property a deleting function should rely on.
  if (!plan) throw new Error(`PPM did not install ${definition.displayName}, so there is nothing to remove.`);
  const dir = lspInstallDir();

  if (plan.with === "bun") {
    if (!installedServerEntry(definition, dir)) {
      throw new Error(`${definition.displayName} is not in PPM's own folder, so there is nothing for PPM to remove.`);
    }
    const tool = installToolPath(plan);
    if (!tool) throw new Error(`bun is not installed on this host, so PPM cannot remove ${definition.displayName}.`);
    // By name, never by the spec that installed it: `bun remove typescript@5` is not the same
    // request as `bun remove typescript`, and the manifest holds the name.
    const names = plan.packages.map(packageName);
    const result = await run([tool, "remove", ...names], { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`Could not remove ${names.join(" ")}: ${output(result)}`);
    return;
  }

  if (plan.with === "download" || plan.with === "gem") {
    const binary = installedBinaryPath(definition, dir);
    if (!binary || !existsSync(binary)) {
      throw new Error(`${definition.displayName} is not in PPM's own folder, so there is nothing for PPM to remove.`);
    }
    // The whole release folder for a download. For a gem, the whole gem folder: it holds the
    // server's dependencies too, and solargraph is the only gem plan (a test keeps it so).
    const folder = plan.with === "download" ? path.join(dir, definition.id) : gemInstallDir(dir);
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`Could not delete ${folder}: ${(e as Error).message}`);
    }
    return;
  }

  if (plan.with === "go") {
    const binary = installedBinaryPath(definition, dir);
    if (!binary || !existsSync(binary)) {
      throw new Error(`${definition.displayName} is not in PPM's own folder, so there is nothing for PPM to remove.`);
    }
    try {
      rmSync(binary);
    } catch (e) {
      // Windows refuses to unlink a running executable, which is the one platform where an
      // uninstall fails for a reason the user can act on.
      throw new Error(`Could not delete ${binary}: ${(e as Error).message}`);
    }
    return;
  }

  // rustup, in the same directory the install would have used, so the component leaves the
  // toolchain it was added to rather than whichever happens to be default.
  const cwd = projectPath && existsSync(projectPath) ? projectPath : process.cwd();
  const tool = installToolPath(plan);
  if (!tool) throw new Error(`rustup is not installed on this host, so PPM cannot remove ${definition.displayName}.`);
  const result = await run([tool, "component", "remove", plan.component], { cwd, timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`Could not remove ${plan.component}: ${output(result)}`);
}

/** What a failed command said, bounded — a build log's last 400 characters hold the reason. */
function output(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-400) || `exit ${result.code}`;
}

function ensureInstallDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify({ name: "ppm-lsp-servers", private: true, dependencies: {} }, null, 2)}\n`);
  }
}
