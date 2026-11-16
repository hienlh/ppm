import { flagValues, hasFlag, parseArgv, type FlagSpec, type ParsedArgv } from "./readonly-argv-parser.ts";
import { judgeGitArgv } from "./readonly-git-spec.ts";
import { judgeReadPaths, judgeWorkingDirectory, type ReadonlyShellContext } from "./readonly-path-check.ts";
import { judgeDockerArgv, judgeFindArgv, judgePsArgv, judgeSqlite3Argv } from "./readonly-tool-specs.ts";
import { ask, isAsk, readonly, type ShellVerdict } from "./shell-verdict.ts";

/**
 * The programs the PPM Assistant may run without asking, each as a spec of what it may be given:
 * which flags (an allowlist — an unknown flag asks), which positionals are paths, patterns or
 * plain text, and whether it walks folders. Shared by every shell that can call a native
 * program, so `git status` is judged the same from bash or from PowerShell.
 *
 * Arguments are judged as the program receives them, after the calling shell's own expansion; a
 * leading `~` is read as the home folder, as bash expands it, so a caller whose shell passes `~`
 * on literally must refuse such an argument before calling here.
 */

type PositionalUse = "paths" | "text" | "none" | "pattern-then-paths";

interface SimpleSpec extends FlagSpec {
  positionals: PositionalUse;
  maxPositionals?: number;
  minPaths?: number;
  /** Walks below the folders it is given. */
  recursive?: (p: ParsedArgv) => boolean;
  /** Given no path, acts on its working directory rather than reading stdin. */
  usesCwd?: (p: ParsedArgv) => boolean;
  /** Reads `-x` after a positional as a flag on every platform (ripgrep's parser). */
  alwaysPermutes?: boolean;
  /** A pattern given as a flag value replaces the leading pattern positional. */
  patternFlags?: readonly string[];
  /** Variables that add options the spec never sees (a config file that turns on `--pre`). */
  forbiddenEnv?: readonly string[];
}

const always = () => true;
const HEAD_TAIL: SimpleSpec = {
  positionals: "paths",
  flags: ["-q", "-v", "-z", "--quiet", "--silent", "--verbose", "--zero-terminated"],
  values: { "-n": "number", "-c": "number", "--lines": "number", "--bytes": "number" },
  numericShorthand: true,
};
const NO_ARGS: SimpleSpec = { positionals: "none" };

const SIMPLE: Readonly<Record<string, SimpleSpec>> = {
  ls: {
    positionals: "paths",
    flags: ["-l", "-a", "-A", "-h", "-1", "-R", "-t", "-r", "-S", "-d", "-F", "-s", "-i", "-n", "-p", "-C", "-x", "-X", "-U", "-c", "-u", "-g", "-o", "-v", "-G",
      "--all", "--almost-all", "--human-readable", "--recursive", "--reverse", "--directory", "--classify", "--group-directories-first", "--full-time", "--size", "--inode", "--numeric-uid-gid"],
    attached: ["--color", "--colour", "--time-style", "--sort", "--time", "--indicator-style", "--quoting-style"],
    values: { "-w": "number", "--width": "number", "-I": "text", "--ignore": "text", "--hide": "text" },
    recursive: (p) => hasFlag(p, "-R", "--recursive"),
    usesCwd: always,
  },
  cat: { positionals: "paths", flags: ["-n", "-A", "-b", "-e", "-E", "-s", "-t", "-T", "-v", "-u", "--number", "--number-nonblank", "--show-all", "--squeeze-blank", "--show-ends", "--show-tabs"] },
  head: HEAD_TAIL,
  // No -f/-F/--follow/--retry/--pid/-s: a followed file never ends.
  tail: HEAD_TAIL,
  wc: { positionals: "paths", flags: ["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"], attached: ["--total"] },
  stat: { positionals: "paths", minPaths: 1, flags: ["-f", "-t", "--file-system", "--terse"], values: { "-c": "text", "--format": "text", "--printf": "text" } },
  file: { positionals: "paths", minPaths: 1, flags: ["-b", "-i", "-N", "-E", "-k", "--brief", "--mime", "--mime-type", "--mime-encoding", "--no-pad", "--keep-going"] },
  grep: {
    positionals: "pattern-then-paths",
    patternFlags: ["-e", "--regexp"],
    forbiddenEnv: ["GREP_OPTIONS"],
    flags: ["-i", "-n", "-r", "-c", "-l", "-L", "-v", "-w", "-x", "-o", "-h", "-H", "-s", "-q", "-E", "-F", "-G", "-P", "-I", "-a", "-z", "-b", "-T", "-Z", "-U",
      "--ignore-case", "--no-ignore-case", "--line-number", "--recursive", "--count", "--files-with-matches", "--files-without-match", "--invert-match", "--word-regexp",
      "--line-regexp", "--only-matching", "--no-filename", "--with-filename", "--no-messages", "--quiet", "--silent", "--extended-regexp", "--fixed-strings",
      "--basic-regexp", "--perl-regexp", "--text", "--null", "--null-data", "--byte-offset", "--initial-tab", "--binary"],
    attached: ["--color", "--colour"],
    values: { "-e": "text", "--regexp": "text", "-A": "number", "-B": "number", "-C": "number", "-m": "number", "--after-context": "number", "--before-context": "number",
      "--context": "number", "--max-count": "number", "--include": "text", "--exclude": "text", "--exclude-dir": "text", "--label": "text", "--binary-files": "text" },
    // -R and --dereference-recursive follow every link while walking, so they are not listed.
    recursive: (p) => hasFlag(p, "-r", "--recursive"),
    usesCwd: (p) => hasFlag(p, "-r", "--recursive"),
  },
  rg: {
    positionals: "pattern-then-paths",
    patternFlags: ["-e", "--regexp"],
    alwaysPermutes: true,
    forbiddenEnv: ["RIPGREP_CONFIG_PATH"],
    // Never --pre, --pre-glob, -z/--search-zip, --hostname-bin (they run programs), -L/--follow,
    // or -f/--file and --ignore-file (they read files named outside the search).
    flags: ["-i", "-n", "-N", "-l", "-c", "-w", "-v", "-F", "-S", "-s", "-u", "-.", "-H", "-I", "-o", "-0", "-x", "-U", "-P", "-a", "-q", "-b",
      "--hidden", "--no-ignore", "--no-ignore-vcs", "--no-ignore-dot", "--no-config", "--no-filename", "--with-filename", "--null", "--json", "--vimgrep", "--no-heading", "--heading",
      "--count", "--count-matches", "--files-with-matches", "--files-without-match", "--files", "--type-list", "--stats", "--trim", "--line-regexp", "--multiline",
      "--multiline-dotall", "--pcre2", "--text", "--quiet", "--byte-offset", "--column", "--no-messages", "--line-number", "--no-line-number", "--ignore-case",
      "--smart-case", "--case-sensitive", "--fixed-strings", "--word-regexp", "--invert-match", "--only-matching", "--passthru", "--unrestricted", "--crlf"],
    values: { "-e": "text", "--regexp": "text", "-g": "text", "--glob": "text", "--iglob": "text", "-t": "text", "--type": "text", "-T": "text", "--type-not": "text",
      "-A": "number", "-B": "number", "-C": "number", "--context": "number", "--after-context": "number", "--before-context": "number", "-m": "number", "--max-count": "number",
      "-d": "number", "--max-depth": "number", "-M": "number", "--max-columns": "number", "-j": "number", "--threads": "number", "--sort": "text", "--sortr": "text",
      "--color": "text", "--colors": "text", "-E": "text", "--encoding": "text", "--max-filesize": "text", "--engine": "text", "-r": "text", "--replace": "text" },
    recursive: always,
    usesCwd: always,
  },
  du: {
    positionals: "paths",
    // Never -L/--dereference (follows links while walking), -D/-H, or --files0-from.
    flags: ["-s", "-h", "-a", "-c", "-k", "-m", "-b", "-x", "-S", "--summarize", "--human-readable", "--all", "--total", "--apparent-size", "--si", "--separate-dirs", "--one-file-system"],
    values: { "-d": "number", "--max-depth": "number", "--exclude": "text", "-t": "text", "--threshold": "text" },
    recursive: always,
    usesCwd: always,
  },
  df: { positionals: "none", flags: ["-h", "-H", "-T", "-i", "-l", "-k", "-m", "-a", "-P", "--total", "--human-readable", "--si", "--local", "--all", "--print-type", "--inodes", "--portability"], attached: ["--output"], values: { "-t": "text", "--type": "text", "-x": "text", "--exclude-type": "text" } },
  free: { positionals: "none", flags: ["-h", "-m", "-g", "-k", "-b", "-t", "-w", "-l", "--human", "--total", "--wide", "--si", "--kilo", "--mega", "--giga", "--bytes", "--kibi", "--mebi", "--gibi", "--lohi"] },
  uptime: { positionals: "none", flags: ["-p", "-s", "--pretty", "--since"] },
  uname: { positionals: "none", flags: ["-a", "-s", "-n", "-r", "-v", "-m", "-p", "-i", "-o", "--all", "--kernel-name", "--nodename", "--kernel-release", "--kernel-version", "--machine", "--operating-system"] },
  // A positional would set the host name.
  hostname: { positionals: "none", flags: ["-s", "-f", "-d", "-i", "-I", "--short", "--fqdn", "--domain", "--ip-address", "--all-ip-addresses"] },
  nproc: { positionals: "none", flags: ["--all"], values: { "--ignore": "number" } },
  whoami: NO_ARGS,
  which: { positionals: "text", flags: ["-a"] },
  // No -o/--output or --compress-program (they write or run), no -T (temporary files in a
  // folder of its choosing), no --files0-from or --random-source (they read other files).
  sort: {
    positionals: "paths",
    flags: ["-n", "-r", "-u", "-h", "-f", "-b", "-V", "-M", "-R", "-s", "-z", "-g", "-c", "-C", "-d", "-i", "-m", "--numeric-sort", "--reverse", "--unique", "--human-numeric-sort",
      "--ignore-case", "--stable", "--general-numeric-sort", "--version-sort", "--random-sort", "--dictionary-order", "--ignore-nonprinting", "--zero-terminated", "--merge",
      "--ignore-leading-blanks", "--month-sort", "--debug"],
    attached: ["--check"],
    values: { "-k": "text", "--key": "text", "-t": "text", "--field-separator": "text", "-S": "text", "--buffer-size": "text", "--parallel": "number" },
  },
  // A second positional is the file uniq writes to.
  uniq: { positionals: "paths", maxPositionals: 1, flags: ["-c", "-d", "-D", "-u", "-i", "-z", "--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"], values: { "-f": "number", "-s": "number", "-w": "number", "--skip-fields": "number", "--skip-chars": "number", "--check-chars": "number" } },
  cut: { positionals: "paths", flags: ["-s", "-z", "-n", "--complement", "--only-delimited", "--zero-terminated"], values: { "-d": "text", "-f": "text", "-c": "text", "-b": "text", "--delimiter": "text", "--fields": "text", "--characters": "text", "--bytes": "text", "--output-delimiter": "text" } },
  tr: { positionals: "text", maxPositionals: 2, flags: ["-d", "-s", "-c", "-C", "-t", "--delete", "--squeeze-repeats", "--complement", "--truncate-set1"] },
};

/** Programs that may stand after `|`: they read the previous segment's output and end with it. */
export const PIPE_FILTERS: ReadonlySet<string> = new Set(["head", "tail", "wc", "sort", "uniq", "grep", "cut", "tr"]);

type Judge = (args: readonly string[], ctx: ReadonlyShellContext) => ShellVerdict;

const CUSTOM: Readonly<Record<string, Judge>> = {
  git: judgeGitArgv,
  find: judgeFindArgv,
  ps: judgePsArgv,
  sqlite3: judgeSqlite3Argv,
  docker: judgeDockerArgv,
  // echo reads no flags beyond -n/-e/-E and prints every other argument as it is.
  echo: () => readonly("echo only prints its arguments"),
  date: judgeDateArgv,
};

/** Whether `name` is a program this check knows at all. */
export function isKnownReadonlyCommand(name: string): boolean {
  return Object.hasOwn(SIMPLE, name) || Object.hasOwn(CUSTOM, name);
}

/**
 * Whether running `argv` (program name first, as the program receives its arguments) only reads
 * what the Assistant may read unasked. The program name must be a bare name on the list.
 */
export function judgeNativeArgv(argv: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  const [name, ...args] = argv;
  if (!name) return ask("there is no command");
  if (Object.hasOwn(CUSTOM, name)) return CUSTOM[name]!(args, ctx);
  if (!Object.hasOwn(SIMPLE, name)) return ask(`${name} is not a program PPM knows to only read`);
  return judgeSimple(name, SIMPLE[name]!, args, ctx);
}

function judgeSimple(name: string, spec: SimpleSpec, args: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  const env = ctx.env ?? process.env;
  const setVar = spec.forbiddenEnv?.find((key) => env[key]);
  if (setVar) return ask(`${name} runs with ${setVar} set, which can add options PPM does not see`);
  const permute = spec.alwaysPermutes || (ctx.platform ?? process.platform) !== "darwin";
  const result = parseArgv(args, spec, { permute });
  if (!result.ok) return ask(`${name}: ${result.reason}`);
  const parsed = result.parsed;
  let positionals = parsed.positionals;
  if (spec.positionals === "none" && positionals.length > 0) return ask(`${name} takes no arguments here`);
  if (spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) return ask(`${name} was given more arguments than it only reads`);
  if (spec.positionals === "text") return readonly();
  if (spec.positionals === "pattern-then-paths") {
    const listsFiles = name === "rg" && hasFlag(parsed, "--files", "--type-list");
    const patternGiven = flagValues(parsed, ...(spec.patternFlags ?? [])).length > 0;
    if (!listsFiles && !patternGiven) {
      if (positionals.length === 0) return ask(`${name} was given no pattern`);
      positionals = positionals.slice(1);
    }
  }
  const paths = positionals.filter((p) => p !== "-");
  if (spec.minPaths && paths.length < spec.minPaths) return ask(`${name} was given no path`);
  const recursive = spec.recursive?.(parsed) ?? false;
  const valueVerdict = judgeReadPaths(parsed.valuePaths, ctx, { recursive: false });
  if (isAsk(valueVerdict)) return valueVerdict;
  if (paths.length === 0) return spec.usesCwd?.(parsed) ? judgeWorkingDirectory(ctx, { recursive }) : readonly();
  return judgeReadPaths(paths, ctx, { recursive });
}

/** `date` prints the time; a positional other than `+FORMAT`, `-s` or `--set` would set it. */
function judgeDateArgv(args: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  const spec: FlagSpec = {
    flags: ["-u", "-R", "--utc", "--universal", "--rfc-email", "-I", "-Idate", "-Ihours", "-Iminutes", "-Iseconds", "-Ins"],
    attached: ["--iso-8601"],
    values: { "-d": "text", "--date": "text", "--rfc-3339": "text" },
  };
  const result = parseArgv(args, spec, { permute: (ctx.platform ?? process.platform) !== "darwin" });
  if (!result.ok) return ask(`date: ${result.reason}`);
  const positionals = result.parsed.positionals;
  if (positionals.length > 1 || (positionals.length === 1 && !positionals[0]!.startsWith("+"))) return ask("date was given an argument that would set the clock");
  return readonly();
}
