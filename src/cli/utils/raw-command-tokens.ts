import type { Command } from "commander";

/**
 * The tokens typed after a command's own path (`["midday"]`, `["ext", "run"]`), exactly as they
 * were typed. Commander's parsed arguments cannot be used for this: it swallows a `--` placed
 * right after the command name, and keeps a literal `--` once an unknown option has appeared,
 * while an extension's handler is promised the tokens verbatim.
 */
export function rawTokensAfter(command: Command, path: readonly string[]): string[] {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const raw = (root as unknown as { rawArgs?: string[] }).rawArgs ?? [];
  const typed = raw.slice(2); // the runtime and the script
  for (let i = 0; i + path.length <= typed.length; i++) {
    if (path.every((part, j) => typed[i + j] === part)) return typed.slice(i + path.length);
  }
  return [];
}

export interface ExtRunTokens {
  command?: string;
  args: string[];
  json: boolean;
  timeout?: string;
  /** Set when `--timeout` has no value after it. */
  error?: string;
}

/**
 * `ppm ext run`'s own tokens: `--json` and `--timeout <ms>` (or `--timeout=<ms>`) belong to it
 * wherever they appear; the first other token is the command and the rest are its arguments.
 * After a `--`, everything is an argument as typed, including those two flags.
 */
export function parseExtRunTokens(tokens: readonly string[]): ExtRunTokens {
  const out: ExtRunTokens = { args: [], json: false };
  let passThrough = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!passThrough) {
      if (token === "--") { passThrough = true; continue; }
      if (token === "--json") { out.json = true; continue; }
      if (token === "--timeout") {
        const value = tokens[i + 1];
        if (value === undefined) return { ...out, error: "--timeout needs a number of milliseconds" };
        out.timeout = value;
        i++;
        continue;
      }
      if (token.startsWith("--timeout=")) { out.timeout = token.slice("--timeout=".length); continue; }
    }
    if (out.command === undefined) out.command = token;
    else out.args.push(token);
  }
  return out;
}
