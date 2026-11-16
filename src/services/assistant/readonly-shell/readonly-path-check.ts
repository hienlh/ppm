import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalPath, isInside, isWindowsNonDrivePath } from "../../design/design-tool-policy.ts";
import { namesAlternateStream } from "../../tool-path-scope.ts";
import { assistantPrivateScope, isAssistantPrivatePath, privateRootWithin, type AssistantPrivateScope } from "../assistant-private-paths.ts";
import { ask, readonly, type ShellVerdict } from "./shell-verdict.ts";

/**
 * The one rule for a path the PPM Assistant may read without asking, whether a shell command
 * names it or a Read/Glob/Grep call does: absolute, resolved through every link, inside a read
 * root (a registered project or PPM's own install folder) and outside every private root
 * (`assistant-private-paths.ts`). A search that walks a folder also asks when the folder holds
 * a private root, since it would walk into it.
 *
 * Judged per call, never cached by text: the answer depends on the project list and on where
 * links point at that moment.
 */

export interface ReadPathContext {
  /** Every registered project's root, read per call. */
  projectRoots: readonly string[];
  /** The home folder `~` stands for and whose credential stores stay private. */
  home: string;
  /** The environment the command runs with (relocated credential stores). */
  env?: NodeJS.ProcessEnv;
  /** Which platform's path text rules apply; this host's unless a test names another. */
  platform?: string;
  /** PPM's install folder: undefined → found from this module's location, null → none. */
  installRoot?: string | null;
}

/** What a shell command is judged against: the path rule's context plus the shell's working directory. */
export interface ReadonlyShellContext extends ReadPathContext {
  /**
   * The folder the command starts in, when the caller knows it for certain. Commands that act
   * on their working directory by default (`git status`, `ls`, `rg pat`) judge this folder;
   * without it they ask.
   */
  cwd?: string;
}

const PPM_PACKAGE_NAME = "@hienlh/ppm";

/**
 * The package root of the running PPM: the nearest folder above `startDir` whose `package.json`
 * is PPM's, and only when it ships its `src/` folder. A compiled binary runs from a virtual
 * filesystem with no such folder, so it has no install root to offer.
 */
export function findPpmInstallRoot(startDir: string = import.meta.dir): string | null {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const name = packageName(join(dir, "package.json"));
    if (name === PPM_PACKAGE_NAME) return isDirectory(join(dir, "src")) ? dir : null;
    if (dirname(dir) === dir) return null;
  }
}

function packageName(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && typeof (parsed as { name?: unknown }).name === "string" ? (parsed as { name: string }).name : null;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

let discoveredInstallRoot: string | null | undefined;

interface ReadScope {
  roots: string[];
  scope: AssistantPrivateScope;
}

/**
 * The read roots and the private scope for one judgement. The install root counts only when it
 * lies under no fixed private root and holds none; it is then also a project of its own for the
 * home-state rule, so PPM installed under `~/.bun` stays readable while a project registered at
 * the home folder keeps `~/.bun`'s other contents private.
 */
function readScope(ctx: ReadPathContext): ReadScope {
  const platform = ctx.platform ?? process.platform;
  const projects = ctx.projectRoots.map(canonicalPath).filter((r): r is string => !!r);
  const base = assistantPrivateScope({ projectRoots: projects, home: ctx.home, env: ctx.env ?? process.env, platform });
  const install = ctx.installRoot === undefined ? (discoveredInstallRoot ??= findPpmInstallRoot()) : ctx.installRoot;
  const installReal = install ? canonicalPath(install) : null;
  if (!installReal || base.roots.some((r) => isInside(installReal, r)) || privateRootWithin(installReal, base)) {
    return { roots: projects, scope: base };
  }
  const roots = [...projects, installReal];
  return { roots, scope: assistantPrivateScope({ projectRoots: roots, home: ctx.home, platform, roots: base.roots }) };
}

/** Registered projects plus PPM's install folder when it qualifies, each as its real path. */
export function assistantReadRoots(projectRoots: readonly string[], opts: Omit<ReadPathContext, "projectRoots">): string[] {
  return readScope({ ...opts, projectRoots }).roots;
}

/**
 * The path a program receives `raw` as, with the home folder and Git Bash's drive spelling
 * expanded the way `cliPath` in `assistant-tool-policy.ts` does for the Read tool, minus its
 * trimming (whitespace is refused before this). Kept here rather than imported so the tool
 * policy can build on this module without a cycle.
 */
function expandPath(raw: string, home: string, platform: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/") || (platform === "win32" && raw.startsWith("~\\"))) return join(home, raw.slice(2));
  const drive = platform === "win32" ? /^\/([a-z])\//i.exec(raw) : null;
  if (drive) return `${drive[1]!.toUpperCase()}:\\${raw.slice(3).replace(/\//g, "\\")}`;
  return raw;
}

/**
 * Windows spellings refused from the text alone: a network or device path (resolving it would
 * reach out over the network), an NTFS stream (`f.txt:secret`), and a `~` inside a component,
 * which may be an 8.3 short name standing for another folder (`PPM~1` for `.ppm`).
 */
function windowsTextRefusal(raw: string, target: string): string | null {
  if (/^[\\/]{2}/.test(raw)) return "it names a network or device path";
  if (isWindowsNonDrivePath(target, "win32")) return "it does not start with a drive (a relative, network or device path)";
  if (namesAlternateStream(target)) return "it names an NTFS alternate data stream";
  const afterHome = raw.replace(/^~(?=$|[\\/])/, "");
  if (afterHome.includes("~")) return "a `~` inside a Windows path may be a short 8.3 name for another folder";
  return null;
}

/**
 * Whether `raw` — a path exactly as the program will receive it — may be read unasked. A leading
 * `~` or `~/` is the home folder and, on Windows, `/c/…` is drive C: (Git Bash's spelling).
 * Surrounding whitespace asks: a shell passes it on and the program then reads another name.
 * `recursive` is for a program that walks the folder (`find`, `grep -r`, `du`, `git`).
 */
export function judgeReadPath(raw: string, ctx: ReadPathContext, opts: { recursive: boolean }): ShellVerdict {
  if (typeof raw !== "string" || !raw || raw !== raw.trim()) return ask("a path is blank or has surrounding whitespace");
  const platform = ctx.platform ?? process.platform;
  const target = expandPath(raw, ctx.home, platform);
  if (platform === "win32") {
    const refusal = windowsTextRefusal(raw, target);
    if (refusal) return ask(`${raw}: ${refusal}`);
  }
  if (!isAbsolute(target)) return ask(`${raw} is a relative path, judged against a working directory PPM cannot vouch for`);
  const resolved = canonicalPath(target);
  if (!resolved) return ask(`${raw} cannot be resolved`);
  const { roots, scope } = readScope(ctx);
  if (isAssistantPrivatePath(resolved, scope)) return ask(`${raw} is private to the user`);
  if (!roots.some((root) => isInside(resolved, root))) return ask(`${raw} is outside every registered project and PPM's install folder`);
  if (opts.recursive && privateRootWithin(resolved, scope)) return ask(`${raw} holds a private folder that a recursive read would walk into`);
  return readonly(`${raw} is inside a read root`);
}

/** Every path judged in turn; the first that asks decides. */
export function judgeReadPaths(paths: readonly string[], ctx: ReadPathContext, opts: { recursive: boolean }): ShellVerdict {
  for (const path of paths) {
    const verdict = judgeReadPath(path, ctx, opts);
    if (verdict.verdict === "ask") return verdict;
  }
  return readonly();
}

/** The working directory as a command that acts on it by default would use it. */
export function judgeWorkingDirectory(ctx: ReadonlyShellContext, opts: { recursive: boolean }): ShellVerdict {
  if (!ctx.cwd) return ask("it acts on a working directory PPM cannot vouch for");
  return judgeReadPath(ctx.cwd, ctx, opts);
}
