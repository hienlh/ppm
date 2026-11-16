/**
 * Splits a program's arguments into flags and positionals the way getopt-style programs read
 * them, accepting only flags a spec lists. A flag the spec does not name is never guessed at:
 * the parse fails and the command asks.
 *
 * - A token listed whole in `flags` (`-vv`, `-uno`, `--porcelain=v2`) is taken as it is.
 * - `--name=value` splits on the first `=`; a value flag also takes the next argument.
 * - A short cluster (`-rn`, `-n5`, `-eo pid`) is read letter by letter; a value flag's letter
 *   takes the rest of the cluster, or the next argument when the cluster ends with it.
 * - `--` ends the flags; everything after it is positional.
 * - A flag after a positional is a flag only where the program permutes its arguments (GNU
 *   tools, ripgrep, git). BSD tools read `-n` there as a file name in the working directory, so
 *   with `permute: false` such a token fails the parse instead.
 */

export type ValueKind = "text" | "number" | "path";

export interface FlagSpec {
  /** Flags taking no value, spelled exactly. */
  flags?: readonly string[];
  /** Flags taking a value, short (`-n`) or long (`--max-count`). */
  values?: Readonly<Record<string, ValueKind>>;
  /**
   * Long flags whose value is optional and so may only be attached (`--color=never`); alone they
   * take nothing, never the next argument — `ls --color ~/.ssh` lists `~/.ssh`.
   */
  attached?: readonly string[];
  /** `-20` meaning a count, as `head`, `tail` and `git log` read it. */
  numericShorthand?: boolean;
  /** Whether letters may be clustered (`-la`); off for single-dash long options (`-readonly`). */
  clusters?: boolean;
}

export interface ParsedFlag {
  name: string;
  value: string | null;
}

export interface ParsedArgv {
  flags: ParsedFlag[];
  positionals: string[];
  /** Values of flags whose kind is `path`, for the path rule. */
  valuePaths: string[];
}

export type ParseResult = { ok: true; parsed: ParsedArgv } | { ok: false; reason: string };

/** A count such as `20`, `-5`, `+3` or `10K`. */
const NUMBER = /^[+-]?\d+[A-Za-z]{0,2}$/;

export function parseArgv(args: readonly string[], spec: FlagSpec, opts: { permute?: boolean } = {}): ParseResult {
  const flags = new Set(spec.flags ?? []);
  const values = spec.values ?? {};
  const attached = new Set(spec.attached ?? []);
  const out: ParsedArgv = { flags: [], positionals: [], valuePaths: [] };
  const fail = (reason: string): ParseResult => ({ ok: false, reason });
  const take = (name: string, value: string | undefined): string | null => {
    if (value === undefined) return `${name} needs a value`;
    const kind = values[name]!;
    if (kind === "number" && !NUMBER.test(value)) return `${name} takes a number, not ${JSON.stringify(value)}`;
    if (kind === "path") out.valuePaths.push(value);
    out.flags.push({ name, value });
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out.positionals.push(arg);
      continue;
    }
    if (opts.permute === false && out.positionals.length > 0) return fail(`${arg} after a positional argument may be read as a file name`);
    if (flags.has(arg)) {
      out.flags.push({ name: arg, value: null });
      continue;
    }
    if (spec.numericShorthand && /^-\d+$/.test(arg)) {
      out.flags.push({ name: "-n", value: arg.slice(1) });
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (attached.has(name)) {
        out.flags.push({ name, value: eq === -1 ? null : arg.slice(eq + 1) });
        continue;
      }
      if (!(name in values)) return fail(`${name} is not a flag PPM knows to only read`);
      const error = take(name, eq === -1 ? args[++i] : arg.slice(eq + 1));
      if (error) return fail(error);
      continue;
    }
    if (spec.clusters === false) {
      if (!(arg in values)) return fail(`${arg} is not a flag PPM knows to only read`);
      const error = take(arg, args[++i]);
      if (error) return fail(error);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const name = `-${arg[j]}`;
      if (flags.has(name)) {
        out.flags.push({ name, value: null });
        continue;
      }
      if (!(name in values)) return fail(`${name} is not a flag PPM knows to only read`);
      const rest = arg.slice(j + 1);
      const error = take(name, rest || args[++i]);
      if (error) return fail(error);
      break;
    }
  }
  return { ok: true, parsed: out };
}

/** Whether any of `names` was given. */
export function hasFlag(parsed: ParsedArgv, ...names: string[]): boolean {
  return parsed.flags.some((f) => names.includes(f.name));
}

/** Every value given for any of `names`, in order. */
export function flagValues(parsed: ParsedArgv, ...names: string[]): string[] {
  return parsed.flags.filter((f) => names.includes(f.name) && f.value !== null).map((f) => f.value!);
}
