import { sharedPowerShellAstHelper, type PowerShellAstHelper } from "./powershell-ast-helper.ts";
import { judgePowerShellAst } from "./powershell-readonly-judge.ts";
import type { ReadonlyShellContext } from "./readonly-path-check.ts";
import { ask, type ShellVerdict } from "./shell-verdict.ts";

/**
 * Whether a PowerShell script the PPM Assistant wants to run only reads what it may read
 * unasked, so it can run without a card. PowerShell's own parser builds the tree (in the
 * long-lived helper) and `powershell-readonly-judge.ts` walks it against an allowlist.
 *
 * Fails closed at every step and never throws: text PPM will not hand to the parser, no
 * PowerShell, a parse error, a helper that crashes or takes longer than 1.5 s, and anything the
 * judge does not know all answer `ask`.
 */

/** Longer than any read-only one-off the Assistant writes; more text is more room for a differential. */
const MAX_SCRIPT_LENGTH = 8192;
/** Control characters other than tab and line breaks, which a command line would not carry intact. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A surrogate without its pair: PowerShell would read a replacement character in its place. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export interface ClassifyPowerShellOptions {
  /** The helper to parse with; the process-wide one by default. */
  helper?: Pick<PowerShellAstHelper, "parse">;
}

export async function classifyPowerShellCommand(script: string, ctx: ReadonlyShellContext, opts: ClassifyPowerShellOptions = {}): Promise<ShellVerdict> {
  try {
    if (typeof script !== "string" || !script.trim()) return ask("the command is empty");
    if (script.length > MAX_SCRIPT_LENGTH) return ask("the script is longer than PPM judges");
    if (CONTROL_CHARACTERS.test(script)) return ask("the script holds control characters");
    if (LONE_SURROGATE.test(script)) return ask("the script holds text that is not valid Unicode");
    const reply = await (opts.helper ?? sharedPowerShellAstHelper()).parse(script);
    return judgePowerShellAst(reply, ctx);
  } catch (e) {
    return ask(`PPM could not judge the script: ${e instanceof Error ? e.message : String(e)}`);
  }
}
