import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalPath, isInside } from "../../design/design-tool-policy.ts";
import { entryExists } from "../../tool-path-scope.ts";
import { flagValues, hasFlag, parseArgv, type FlagSpec } from "./readonly-argv-parser.ts";
import { assistantReadRoots, judgeReadPath, type ReadonlyShellContext } from "./readonly-path-check.ts";
import { ask, isAsk, readonly, type ShellVerdict } from "./shell-verdict.ts";

/**
 * `git` subcommands that only read, each with the flags it may take. Never `-c`, `--config-env`,
 * `--exec-path`, `--git-dir`, `--work-tree` (they choose what git runs or reads), `--output`
 * (writes a file), `--ext-diff` (runs a program), `--no-index` (diffs any two files), or
 * `remote -v` (remote URLs can hold tokens).
 *
 * Git reads a whole repository, so the folder it runs in and the repository it finds are both
 * judged as folders walked recursively, and the repository must be found without leaving a read
 * root: git searches upward for `.git`, and a home folder kept in git would otherwise answer for
 * a project folder that is not a repository, its tracked credentials included.
 *
 * Residual, as for PPM's own git tools: a repository's local config and attributes can still name
 * programs git runs (`core.fsmonitor`, a textconv driver).
 */

/** Environment that points git at another repository, config or program. */
const GIT_ENV_OVERRIDES = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF", "GIT_EXEC_PATH",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

const LOG_FLAGS = ["--oneline", "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--graph", "--all", "--no-merges", "--merges", "--reverse",
  "--abbrev-commit", "--first-parent", "-p", "--patch", "-s", "--no-patch", "--follow", "--topo-order", "--date-order", "--left-right", "--boundary", "--no-color",
  "--summary", "-i", "--regexp-ignore-case", "--all-match", "--invert-grep", "-E", "-F", "--full-history", "--no-renames", "--no-ext-diff", "--no-textconv", "-w"];
const LOG_ATTACHED = ["--decorate", "--color", "--abbrev", "--pretty", "--stat", "--branches", "--tags", "--remotes"];
const LOG_VALUES: FlagSpec["values"] = { "-n": "number", "--max-count": "number", "--skip": "number", "--since": "text", "--after": "text", "--until": "text",
  "--before": "text", "--author": "text", "--committer": "text", "--grep": "text", "--format": "text", "--date": "text", "-S": "text", "-G": "text", "-L": "text" };
const DIFF_FLAGS = ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "-w", "--ignore-all-space", "-b",
  "--ignore-space-change", "--ignore-blank-lines", "--no-ext-diff", "--no-textconv", "--check", "--summary", "-R", "--minimal", "--patience", "--histogram", "--raw",
  "-p", "--patch", "-s", "--no-patch", "--exit-code", "--quiet", "-M", "--no-renames", "--full-index"];
const DIFF_ATTACHED = ["--color", "--word-diff", "--stat", "--dirstat", "--find-renames", "--abbrev", "--relative"];
const DIFF_VALUES: FlagSpec["values"] = { "-U": "number", "--unified": "number", "--diff-filter": "text", "--inter-hunk-context": "number", "-S": "text", "-G": "text" };

interface GitSubSpec extends FlagSpec {
  /** Positionals are allowed only alongside one of these flags (`branch --list`, `tag -l`). */
  positionalsNeed?: readonly string[];
}

const SUBCOMMANDS: Readonly<Record<string, GitSubSpec>> = {
  status: { flags: ["-s", "--short", "-b", "--branch", "--long", "-v", "-z", "--show-stash", "--ahead-behind", "--no-ahead-behind", "--no-renames", "-u", "-uno", "-unormal", "-uall"],
    attached: ["--porcelain", "--untracked-files", "--ignored", "--ignore-submodules", "--column"] },
  log: { flags: LOG_FLAGS, attached: LOG_ATTACHED, values: LOG_VALUES, numericShorthand: true },
  show: { flags: [...LOG_FLAGS, ...DIFF_FLAGS], attached: [...LOG_ATTACHED, ...DIFF_ATTACHED], values: { ...LOG_VALUES, ...DIFF_VALUES } },
  diff: { flags: DIFF_FLAGS, attached: DIFF_ATTACHED, values: DIFF_VALUES },
  branch: { flags: ["-a", "-r", "-v", "--all", "--remotes", "--verbose", "--list", "-l", "--show-current", "--no-color"],
    attached: ["--color", "--abbrev", "--merged", "--no-merged", "--contains", "--no-contains"], values: { "--sort": "text", "--format": "text" }, positionalsNeed: ["--list", "-l"] },
  "rev-parse": { flags: ["--show-toplevel", "--git-dir", "--is-inside-work-tree", "--is-bare-repository", "--show-prefix", "--show-cdup", "--verify", "-q", "--quiet",
    "--symbolic-full-name", "--absolute-git-dir", "--git-common-dir"], attached: ["--short", "--abbrev-ref"] },
  "ls-files": { flags: ["-c", "-m", "-o", "-d", "-s", "-z", "-t", "-v", "-u", "--cached", "--modified", "--others", "--deleted", "--stage", "--exclude-standard",
    "--directory", "--no-empty-directory", "--full-name", "--error-unmatch", "--unmerged", "--eol"], attached: ["--abbrev"], values: { "-x": "text", "--exclude": "text" } },
  // Never --contents or -S: both read a file named outside the repository.
  blame: { flags: ["-w", "-M", "-C", "-e", "-s", "-l", "-t", "-f", "-n", "-p", "-c", "-b", "--porcelain", "--line-porcelain", "--show-email", "--show-name", "--show-number", "--root"],
    attached: ["--abbrev"], values: { "-L": "text", "--date": "text", "--since": "text" } },
  shortlog: { flags: ["-s", "-n", "-e", "-c", "--summary", "--numbered", "--email", "--committer", "--all", "--no-merges"],
    values: { "--since": "text", "--until": "text", "--group": "text", "--format": "text" } },
  describe: { flags: ["--tags", "--all", "--always", "--long", "--exact-match", "--first-parent", "--contains"], attached: ["--dirty", "--broken", "--abbrev"],
    values: { "--match": "text", "--exclude": "text", "--candidates": "number" } },
  tag: { flags: ["-l", "--list"], values: { "-n": "number", "--sort": "text", "--format": "text", "--contains": "text", "--points-at": "text" }, positionalsNeed: ["-l", "--list"] },
};

/**
 * A revision or pathspec that cannot point outside the repository: not absolute, not home, not a
 * drive, no backslash, no `..` segment. `git diff` with a path outside the working tree quietly
 * becomes `--no-index`, a diff of any two files.
 */
function staysInRepository(arg: string): boolean {
  if (/^[\\/~]/.test(arg) || /^[A-Za-z]:/.test(arg) || arg.includes("\\")) return false;
  return !arg.split("/").includes("..");
}

/** `--pretty=<name>` formats git defines itself; any other bare name is a `pretty.<name>` from git config. */
const BUILTIN_PRETTY = new Set(["oneline", "short", "medium", "full", "fuller", "reference", "email", "mboxrd", "raw"]);

/**
 * Why a `--pretty`/`--format` value is not only a read, or null. The signature placeholders
 * (`%G?`, `%GG`, `%GS`… and for-each-ref's `%(signature…)`) make git verify each commit by running
 * `gpg.program` — a program named by the repository's config, and gpg itself can fetch keys from
 * the network. A bare name other than git's own is an alias the config defines, unseen here.
 */
function judgeFormats(values: readonly string[]): string | null {
  for (const value of values) {
    if (/%G/.test(value) || /%\(\s*signature/i.test(value)) return "a signature placeholder makes git run gpg to verify commits";
    if (!value.includes("%") && !/^t?format:/.test(value) && !BUILTIN_PRETTY.has(value)) {
      return `the format "${value}" is not one git defines itself (a name from git config)`;
    }
  }
  return null;
}

export function judgeGitArgv(args: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  const env = ctx.env ?? process.env;
  const override = GIT_ENV_OVERRIDES.find((key) => env[key]);
  if (override) return ask(`git runs with ${override} set`);
  let i = 0;
  let dir: string | null = null;
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    const arg = args[i]!;
    if (arg === "--no-pager" || arg === "-P" || arg === "--no-optional-locks") continue;
    if (arg !== "-C" || dir !== null || args[i + 1] === undefined) return ask(`git ${arg} is not an option PPM knows to only read`);
    dir = args[++i]!;
  }
  const sub = args[i];
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) return ask(`git ${sub ?? ""} is not a subcommand PPM knows to only read`.trim());
  const spec = SUBCOMMANDS[sub]!;
  const result = parseArgv(args.slice(i + 1), spec);
  if (!result.ok) return ask(`git ${sub}: ${result.reason}`);
  const formatRefusal = judgeFormats(flagValues(result.parsed, "--pretty", "--format"));
  if (formatRefusal) return ask(`git ${sub}: ${formatRefusal}`);
  const { positionals } = result.parsed;
  if (positionals.length > 0 && spec.positionalsNeed && !hasFlag(result.parsed, ...spec.positionalsNeed)) return ask(`git ${sub} with an argument changes the repository`);
  const leaving = positionals.find((p) => !staysInRepository(p));
  if (leaving !== undefined) return ask(`git ${sub} was given ${leaving}, which may point outside the repository`);
  return judgeRepository(dir, ctx);
}

/** The folder git runs in and the repository it would find from there, both walked whole. */
function judgeRepository(dir: string | null, ctx: ReadonlyShellContext): ShellVerdict {
  const start = dir ?? ctx.cwd;
  if (!start) return ask("git acts on a working directory PPM cannot vouch for");
  const startVerdict = judgeReadPath(start, ctx, { recursive: true });
  if (isAsk(startVerdict)) return startVerdict;
  const real = canonicalPath(start);
  const roots = assistantReadRoots(ctx.projectRoots, ctx);
  if (!real) return ask(`${start} cannot be resolved`);
  for (let d = real; roots.some((r) => isInside(d, r)); d = dirname(d)) {
    const dotGit = join(d, ".git");
    if (entryExists(dotGit)) return judgeGitDirs(d, dotGit, ctx);
    if (dirname(d) === d) break;
  }
  return ask("git would look for its repository above every read root");
}

/**
 * A `.git` file (a worktree or submodule) names the folder git really reads, and a worktree's
 * folder names the shared one in `commondir`; each is judged where it points.
 */
function judgeGitDirs(repo: string, dotGit: string, ctx: ReadonlyShellContext): ShellVerdict {
  const repoVerdict = judgeReadPath(repo, ctx, { recursive: true });
  if (isAsk(repoVerdict)) return repoVerdict;
  const gitDir = pointer(dotGit, /^gitdir:\s*(.+)$/m);
  if (gitDir === undefined) return readonly();
  if (gitDir === null) return ask(`${dotGit} could not be read`);
  const gitDirVerdict = judgeReadPath(gitDir, ctx, { recursive: true });
  if (isAsk(gitDirVerdict)) return gitDirVerdict;
  const commonFile = join(gitDir, "commondir");
  if (!entryExists(commonFile)) return readonly();
  const common = pointer(commonFile, /^(.+)$/m);
  return common ? judgeReadPath(common, ctx, { recursive: true }) : ask(`${commonFile} could not be read`);
}

/**
 * The absolute path a git pointer file names, resolved against the file's folder; undefined when
 * `file` is a folder (an ordinary `.git`), null when it cannot be read or holds no pointer.
 */
function pointer(file: string, pattern: RegExp): string | null | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EISDIR" ? undefined : null;
  }
  const match = pattern.exec(text);
  if (!match) return null;
  const named = match[1]!.trim();
  return isAbsolute(named) ? named : resolve(dirname(file), named);
}
