import { splitSqlStatements } from "../../../shared/split-sql-statements.ts";
import { assistantSqlSafety } from "../../assistant-mcp/assistant-sql-safety.ts";
import { flagValues, hasFlag, parseArgv } from "./readonly-argv-parser.ts";
import { judgeReadPath, judgeReadPaths, judgeWorkingDirectory, type ReadonlyShellContext } from "./readonly-path-check.ts";
import { ask, isAsk, readonly, type ShellVerdict } from "./shell-verdict.ts";

/**
 * Specs for programs whose arguments are not getopt-shaped (`find`'s expression, `sqlite3`'s
 * single-dash options) or that need more than a flag list (`ps` columns, `docker` subcommands).
 */

/** `find` tests that only look; `-newer` names a file whose time it reads. */
const FIND_TESTS_WITH_VALUE = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-maxdepth", "-mindepth", "-size",
  "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-regex", "-iregex", "-perm", "-user", "-group", "-links"]);
const FIND_WORDS = new Set(["-print", "-print0", "-empty", "-true", "-false", "-prune", "-depth", "-xdev", "-mount", "-nowarn", "-noleaf",
  "!", "-not", "-a", "-and", "-o", "-or", "(", ")"]);

/**
 * `find` with starting folders and an expression of tests only. Never `-exec`, `-execdir`,
 * `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls` (they run or write), nor `-L`, `-H` or
 * `-follow` (they follow links while walking). Every starting folder is walked whole.
 */
export function judgeFindArgv(args: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  let i = 0;
  while (args[i] === "-P") i++;
  const isExpression = (a: string) => a.startsWith("-") || a === "!" || a === "(" || a === ")";
  const starts: string[] = [];
  for (; i < args.length && !isExpression(args[i]!); i++) starts.push(args[i]!);
  const newer: string[] = [];
  for (; i < args.length; i++) {
    const word = args[i]!;
    if (FIND_WORDS.has(word)) continue;
    if (!FIND_TESTS_WITH_VALUE.has(word)) return ask(`find ${word} is not a test PPM knows to only read`);
    const value = args[++i];
    if (value === undefined) return ask(`find ${word} needs a value`);
    if ((word === "-maxdepth" || word === "-mindepth") && !/^\d+$/.test(value)) return ask(`find ${word} takes a number`);
    if (word === "-newer") newer.push(value);
  }
  const newerVerdict = judgeReadPaths(newer, ctx, { recursive: false });
  if (isAsk(newerVerdict)) return newerVerdict;
  return starts.length === 0 ? judgeWorkingDirectory(ctx, { recursive: true }) : judgeReadPaths(starts, ctx, { recursive: true });
}

/** Columns that carry no command line and no environment: a process's arguments can hold tokens. */
const PS_FIELDS = new Set(["pid", "ppid", "comm", "rss", "vsz", "%cpu", "%mem", "etime", "lstart", "stat", "user"]);
const PS_COLUMN = /^([%a-z]+)(=[A-Za-z0-9_%-]*)?$/;

/**
 * `ps` with explicit `-o` columns drawn from {@link PS_FIELDS}. Without `-o` its default columns
 * vary by platform and BSD-style options (`aux`, `e`) show command lines or the environment. On
 * macOS `-e` itself adds the environment, so only `-A` selects every process there.
 */
export function judgePsArgv(args: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  const darwin = (ctx.platform ?? process.platform) === "darwin";
  const result = parseArgv(args, {
    flags: darwin ? ["-A", "--no-headers"] : ["-e", "-A", "-H", "--no-headers"],
    values: { "-o": "text", "-p": "text", "--pid": "text", "-u": "text", "-U": "text", "-C": "text", "--sort": "text" },
  });
  if (!result.ok) return ask(`ps: ${result.reason}`);
  if (result.parsed.positionals.length > 0) return ask("ps options without a dash (`aux`, `e`) show command lines or the environment");
  const columns = flagValues(result.parsed, "-o");
  if (columns.length === 0) return ask("ps without -o shows columns that can include command lines");
  for (const list of columns) {
    for (const column of list.split(",")) {
      const field = PS_COLUMN.exec(column)?.[1];
      if (!field || !PS_FIELDS.has(field)) return ask(`ps column ${JSON.stringify(column)} is not one PPM shows unasked`);
    }
  }
  for (const key of flagValues(result.parsed, "--sort").flatMap((s) => s.split(","))) {
    if (!PS_FIELDS.has(key.replace(/^[+-]/, ""))) return ask(`ps --sort ${key} is not a column PPM shows unasked`);
  }
  const selectors = flagValues(result.parsed, "-p", "--pid", "-u", "-U", "-C");
  if (selectors.some((s) => !/^[A-Za-z0-9_.,-]+$/.test(s))) return ask("ps was given an unusual process selector");
  return readonly();
}

/** Functions of the `sqlite3` shell that read or write files, edit, or load code. */
const SQLITE_CLI_FUNCTIONS = /\b(readfile|writefile|edit|load_extension|fts3_tokenizer)\b/i;

/**
 * `sqlite3 -readonly <db> "<one SELECT>"`. The database is judged by the path rule, so a database
 * in the PPM folder (`ppm.db`) always asks. The SQL must be one statement that
 * `assistantSqlSafety` proves only reads, with none of the shell's file functions; a dot-command
 * (`.shell`, `.output`), `-cmd` or `-init` asks. Options may stand anywhere, as sqlite3 reads them.
 */
export function judgeSqlite3Argv(args: readonly string[], ctx: ReadonlyShellContext): ShellVerdict {
  if (args.includes("--")) return ask("sqlite3 was given --");
  // sqlite3 accepts `--opt` as `-opt`.
  const normalized = args.map((a) => (a.startsWith("--") ? a.slice(1) : a));
  const result = parseArgv(normalized, {
    clusters: false,
    flags: ["-readonly", "-header", "-noheader", "-column", "-csv", "-json", "-line", "-list", "-box", "-table", "-markdown", "-html", "-quote", "-tabs", "-ascii", "-bail", "-nofollow"],
    values: { "-separator": "text", "-nullvalue": "text", "-newline": "text" },
  });
  if (!result.ok) return ask(`sqlite3: ${result.reason}`);
  if (!hasFlag(result.parsed, "-readonly")) return ask("sqlite3 without -readonly can write");
  const positionals = result.parsed.positionals;
  if (positionals.length !== 2) return ask("sqlite3 must be given exactly one database and one SQL argument");
  const [database, sql] = positionals as [string, string];
  if (sql.trim().startsWith(".")) return ask("sqlite3 dot-commands can run programs and write files");
  if (SQLITE_CLI_FUNCTIONS.test(sql)) return ask("the SQL names a sqlite3 shell function that reaches files or loads code");
  if (splitSqlStatements(sql, "sqlite").length !== 1) return ask("the SQL holds more than one statement");
  const safety = assistantSqlSafety(sql, "sqlite");
  if (!safety.proven) return ask(`the SQL is not proven to only read: ${safety.reason}`);
  return judgeReadPath(database, ctx, { recursive: false });
}

/** `docker` subcommands that list, never `inspect`, `logs` or `exec`, whose output carries env and secrets. */
export function judgeDockerArgv(args: readonly string[]): ShellVerdict {
  const [sub, ...rest] = args;
  const specs: Record<string, { flags: string[]; values?: Record<string, "text" | "number">; positionals: boolean; needs?: string }> = {
    ps: { flags: ["-a", "-q", "-l", "-s", "--all", "--quiet", "--latest", "--size"], values: { "-n": "number", "--last": "number", "-f": "text", "--filter": "text" }, positionals: false },
    images: { flags: ["-a", "-q", "--all", "--quiet", "--digests"], values: { "-f": "text", "--filter": "text" }, positionals: false },
    version: { flags: [], positionals: false },
    stats: { flags: ["--no-stream", "-a", "--all"], positionals: true, needs: "--no-stream" },
  };
  if (!sub || !Object.hasOwn(specs, sub)) return ask(`docker ${sub ?? ""} is not a subcommand PPM knows to only read`.trim());
  const spec = specs[sub]!;
  const result = parseArgv(rest, spec);
  if (!result.ok) return ask(`docker ${sub}: ${result.reason}`);
  if (!spec.positionals && result.parsed.positionals.length > 0) return ask(`docker ${sub} takes no arguments here`);
  if (spec.needs && !hasFlag(result.parsed, spec.needs)) return ask(`docker ${sub} without ${spec.needs} never ends`);
  return readonly();
}
