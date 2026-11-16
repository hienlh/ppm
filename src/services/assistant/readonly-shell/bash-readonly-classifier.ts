import { lexBash, type BashToken } from "./bash-command-lexer.ts";
import { PIPE_FILTERS, isKnownReadonlyCommand, judgeNativeArgv } from "./readonly-command-specs.ts";
import type { ReadonlyShellContext } from "./readonly-path-check.ts";
import { ask, isAsk, readonly, type ShellVerdict } from "./shell-verdict.ts";

/**
 * Whether a bash command the PPM Assistant wants to run only reads what it may read unasked, so
 * it can run without a card. Fails closed at every step: text outside the lexer's grammar, a
 * program not on the list, a flag its spec does not list, or a path outside the read roots all
 * answer `ask`.
 *
 * The command is split at `|`, `&&`, `||` and `;`, and every segment must pass on its own — a
 * `&&` or `;` still runs what follows. A segment after `|` must also be a filter, which reads the
 * previous output and ends with it (`ls | sh` and `ls | xargs rm` ask). Allowed redirections only
 * discard output or join stderr to stdout.
 *
 * The program word must be a bare name: `/bin/cat` or `./cat` could be another program, and
 * `env`, `sudo`, `xargs`, `sh`, `eval` and friends run whatever follows them, so none is listed.
 * Residual: an alias or function of the same name in the shell's own startup files.
 */

/** Longer than any read-only one-liner; more text is more room for a parser differential. */
const MAX_COMMAND_LENGTH = 4096;

export function classifyBashCommand(command: unknown, ctx: ReadonlyShellContext): ShellVerdict {
  if (typeof command !== "string" || !command.trim()) return ask("the command is empty");
  if (command.length > MAX_COMMAND_LENGTH) return ask("the command is longer than PPM judges");
  const tokens = lexBash(command);
  if (!tokens) return ask("the command uses shell syntax PPM does not judge (expansion, substitution, globbing, redirection or escapes)");
  for (const segment of segments(tokens)) {
    const verdict = judgeSegment(segment.words, segment.piped, ctx);
    if (isAsk(verdict)) return verdict;
  }
  return readonly("every part of the command only reads inside a read root");
}

interface Segment {
  words: Extract<BashToken, { kind: "word" }>[];
  /** Reads the previous segment's output through `|`. */
  piped: boolean;
}

function segments(tokens: readonly BashToken[]): Segment[] {
  const out: Segment[] = [{ words: [], piped: false }];
  for (const token of tokens) {
    if (token.kind === "op") out.push({ words: [], piped: token.value === "|" });
    else if (token.kind === "word") out[out.length - 1]!.words.push(token);
  }
  return out;
}

function judgeSegment(words: Segment["words"], piped: boolean, ctx: ReadonlyShellContext): ShellVerdict {
  const first = words[0];
  if (!first) return ask("a part of the command is empty");
  const name = first.value;
  if (first.quoted) return ask("the program name is quoted");
  if (name.includes("=")) return ask("the command starts with a variable assignment");
  if (name.includes("/")) return ask(`${name} is a path, which may name a program other than the one listed`);
  if (!isKnownReadonlyCommand(name)) return ask(`${name} is not a program PPM knows to only read`);
  if (piped && !PIPE_FILTERS.has(name)) return ask(`${name} after | is not a filter that only reads its input`);
  return judgeNativeArgv(words.map((w) => w.value), ctx);
}
