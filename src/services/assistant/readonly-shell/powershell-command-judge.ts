import { child, isNode, list, literalTexts, str, type PsNode, type PsValue } from "./powershell-ast-types.ts";
import { judgeCmdletRules } from "./powershell-cmdlet-rules.ts";
import { COMMON_ALIASES, COMMON_PARAMS, isBuiltInAlias, resolveCmdlet, type CmdletSpec, type ParamKind } from "./powershell-cmdlet-specs.ts";
import { isAssignableLocal, memberRefusal, type PsScope, type Refusal } from "./powershell-judge-scope.ts";
import { judgePathArgument } from "./powershell-path-arguments.ts";
import { judgeExpression } from "./powershell-readonly-expressions.ts";
import { judgeProperties, judgeScriptBlockArgument } from "./powershell-property-arguments.ts";
import { PIPE_FILTERS, judgeNativeArgv } from "./readonly-command-specs.ts";
import { judgeWorkingDirectory } from "./readonly-path-check.ts";

/**
 * One command of a pipeline: a cmdlet from the table (`powershell-cmdlet-specs.ts`), bound
 * parameter by parameter, or a native program judged by the shared program specs. The call
 * operators `&` and `.` ask whatever follows them, and so does any name not on either list.
 */

/** A cmdlet's arguments after binding: parameter name → the values given to it (`true`/`false` for a switch). */
export type BoundArgs = Map<string, (PsNode | boolean)[]>;

/** Programs a script may call by name. Names PowerShell treats as aliases (`ls`, `cat`, `sort`) and
 *  names Windows gives another program (`find`, `date`, `echo`) are not here. */
const NATIVE_PROGRAMS = new Set(["git", "rg", "sqlite3", "docker", "whoami", "hostname", "du", "df", "head", "tail", "wc", "grep", "cut", "tr", "uniq", "stat", "file", "which", "uname", "nproc", "free"]);
const ACTIONS = new Set(["silentlycontinue", "stop", "continue", "ignore"]);

export interface CommandOutcome { refusal: Refusal; label: string }

/** `previous` holds the labels of the commands before this one in the pipeline. */
export function judgeCommand(n: PsNode, previous: readonly string[], s: PsScope): CommandOutcome {
  const fail = (refusal: string): CommandOutcome => ({ refusal, label: "" });
  if (str(n, "InvocationOperator") !== "Unknown") return fail("the call operator & or . runs whatever follows it");
  if (n.DefiningKeyword !== null && n.DefiningKeyword !== undefined) return fail("a dynamic keyword");
  const elements = list(n, "CommandElements");
  const head = elements?.[0];
  if (!elements || !isNode(head) || head.t !== "StringConstantExpressionAst" || str(head, "StringConstantType") !== "BareWord") {
    return fail("a command named by something other than a plain word");
  }
  const name = str(head, "Value") ?? "";
  const redirect = judgeRedirections(n);
  if (redirect) return fail(redirect);
  const spec = resolveCmdlet(name, s.platform);
  if (spec) return { refusal: judgeCmdlet(spec, elements.slice(1), previous, s), label: spec.name.toLowerCase() };
  const program = name.toLowerCase().replace(/\.exe$/, "");
  if (NATIVE_PROGRAMS.has(program) && !isBuiltInAlias(program)) {
    return { refusal: judgeNative(program, elements.slice(1), previous.length > 0, s), label: `native:${program}` };
  }
  return fail(`${name} is not a command PPM knows to only read`);
}

function bind(spec: CmdletSpec, args: readonly PsValue[]): { bound: BoundArgs } | { refusal: string } {
  const bound: BoundArgs = new Map();
  const add = (param: string, value: PsNode | boolean): Refusal => {
    const values = bound.get(param) ?? [];
    if (values.length > 0 && !spec.repeatable?.includes(param)) return `-${param} is given twice`;
    bound.set(param, [...values, value]);
    return null;
  };
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!isNode(arg)) return { refusal: "an argument PPM cannot read" };
    if (arg.t !== "CommandParameterAst") {
      const isBlock = arg.t === "ScriptBlockExpressionAst";
      const param = spec.positionalFor ? spec.positionalFor(positionals, isBlock) : firstUnbound(spec, bound);
      positionals++;
      if (!param) return { refusal: `${spec.name} was given more arguments than PPM binds` };
      const r = add(param, arg);
      if (r) return { refusal: r };
      continue;
    }
    const written = (str(arg, "ParameterName") ?? "").toLowerCase();
    const param = spec.aliases?.[written] ?? COMMON_ALIASES[written] ?? written;
    const kind = paramKind(spec, param);
    if (!kind || written === "-") return { refusal: `-${written} is not a parameter PPM knows ${spec.name} to only read with` };
    const attached = child(arg, "Argument");
    let value: PsNode | boolean;
    if (kind === "switch") {
      if (!attached) value = true;
      else if (attached.t === "VariableExpressionAst" && ["true", "false"].includes(variableName(attached))) value = variableName(attached) === "true";
      else return { refusal: `-${written} given a value PPM cannot read` };
    } else if (attached) {
      value = attached;
    } else {
      const next = args[i + 1];
      if (!isNode(next) || next.t === "CommandParameterAst") return { refusal: `-${written} is missing its value` };
      value = next;
      i++;
    }
    const r = add(param, value);
    if (r) return { refusal: r };
  }
  return { bound };
}

function variableName(n: PsNode): string {
  const path = n.VariablePath as { UserPath?: unknown } | undefined;
  return typeof path?.UserPath === "string" ? path.UserPath.toLowerCase() : "";
}

function firstUnbound(spec: CmdletSpec, bound: BoundArgs): string | undefined {
  return spec.positional?.find((param) => !bound.has(param));
}

function paramKind(spec: CmdletSpec, param: string): ParamKind | undefined {
  return Object.hasOwn(spec.params, param) ? spec.params[param] : Object.hasOwn(COMMON_PARAMS, param) ? COMMON_PARAMS[param] : undefined;
}

function judgeCmdlet(spec: CmdletSpec, args: readonly PsValue[], previous: readonly string[], s: PsScope): Refusal {
  if (spec.source && previous.length > 0) return `${spec.name} must start its pipeline: given input, it would read what it was handed`;
  const binding = bind(spec, args);
  if ("refusal" in binding) return binding.refusal;
  const { bound } = binding;
  const recursive = (spec.recursiveWhen ?? []).some((p) => bound.get(p)?.some((v) => v !== false));
  let pathGiven = false;
  for (const [param, values] of bound) {
    const kind = paramKind(spec, param)!;
    for (const value of values) {
      if (kind === "path" || kind === "literalPath") pathGiven = true;
      const r = typeof value === "boolean" ? null : judgeValue(kind, value, s, recursive);
      if (r) return `${spec.name} -${param}: ${r}`;
    }
  }
  if (!pathGiven && spec.needsPath) return `${spec.name} was given no path`;
  if (!pathGiven && spec.usesCwd) {
    const verdict = judgeWorkingDirectory(s.ctx, { recursive });
    if (verdict.verdict === "ask") return verdict.reason;
  }
  return judgeCmdletRules(spec, bound, previous);
}

function judgeValue(kind: ParamKind, value: PsNode, s: PsScope, recursive: boolean): Refusal {
  switch (kind) {
    case "path":
    case "literalPath":
      return judgePathArgument(value, s, { literal: kind === "literalPath", recursive });
    case "text":
      return literalTexts(value) ? null : "a value computed by an expression where PPM needs a literal";
    case "pattern":
      return literalTexts(value)?.every((t) => t && !/[\\/:]|\.\./.test(t)) ? null : "a name pattern that is not a literal name in the folder";
    case "expr":
      return judgeExpression(value, s);
    case "props":
      return judgeProperties(value, s);
    case "member": {
      const name = value.t === "StringConstantExpressionAst" ? str(value, "Value") : undefined;
      if (!name || /[*?[\]]/.test(name)) return "a member name that is not a literal";
      return memberRefusal(name);
    }
    case "block":
      return judgeScriptBlockArgument(value, s);
    case "action": {
      const action = value.t === "StringConstantExpressionAst" ? str(value, "Value") : undefined;
      return action && ACTIONS.has(action.toLowerCase()) ? null : "an action other than SilentlyContinue, Stop, Continue or Ignore";
    }
    case "errorVariable": {
      const name = (value.t === "StringConstantExpressionAst" ? str(value, "Value") : undefined)?.replace(/^\+/, "");
      if (!name || !isAssignableLocal(name) || name.toLowerCase() === "null") return "an error variable that is not a plain local name";
      s.locals.add(name.toLowerCase());
      return null;
    }
    default:
      return "a switch given a value";
  }
}

/**
 * A program's argument as it receives it. Only literal words and strings are accepted, never a
 * variable or expression, and never what Windows PowerShell passes on differently from how it is
 * written: an empty string (dropped), a `"` or a trailing `\` (re-quoted with known bugs), `-x:v`
 * (split in two), `--` (dropped by some versions) or a leading `~` (passed on unexpanded).
 */
function nativeArgument(n: PsNode, s: PsScope): string | { refusal: string } {
  if (n.t === "CommandParameterAst") {
    const name = str(n, "ParameterName");
    if (!name || name === "-" || child(n, "Argument")) return { refusal: "a program argument PowerShell may pass on differently from how it is written" };
    return `-${name}`;
  }
  const type = str(n, "StringConstantType");
  const value = n.t === "ConstantExpressionAst" ? str(n, "Value") : n.t === "StringConstantExpressionAst" && type !== "SingleQuotedHereString" && type !== "DoubleQuotedHereString" ? str(n, "Value") : undefined;
  if (value === undefined) return { refusal: "a program argument computed by an expression" };
  if (n.t === "ConstantExpressionAst" && !/^\d+$/.test(value)) return { refusal: "a numeric program argument PowerShell may rewrite" };
  if (!value || value.includes('"') || value.endsWith("\\") || value.startsWith("~") || value.startsWith("--%")) {
    return { refusal: `the program argument ${JSON.stringify(value)} may reach the program differently from how it is written` };
  }
  if (s.platform !== "win32" && type === "BareWord" && /[*?[\]]/.test(value)) return { refusal: "a bare word PowerShell expands as a wildcard" };
  return value;
}

function judgeNative(program: string, args: readonly PsValue[], piped: boolean, s: PsScope): Refusal {
  if (piped && !PIPE_FILTERS.has(program)) return `${program} after | is not a filter that only reads its input`;
  const argv = [program];
  for (const arg of args) {
    if (!isNode(arg)) return "a program argument PPM cannot read";
    const value = nativeArgument(arg, s);
    if (typeof value !== "string") return value.refusal;
    argv.push(value);
  }
  const verdict = judgeNativeArgv(argv, { ...s.ctx, platform: s.platform });
  return verdict.verdict === "ask" ? verdict.reason : null;
}

/** Output may only be discarded (`>$null`, `2>$null`, `*>$null`) or have errors joined to it (`2>&1`). */
export function judgeRedirections(n: PsNode): Refusal {
  const redirections = list(n, "Redirections");
  if (!redirections) return "a redirection PPM cannot read";
  for (const r of redirections) {
    if (!isNode(r)) return "a redirection PPM cannot read";
    if (r.t === "MergingRedirectionAst" && str(r, "FromStream") === "Error" && str(r, "ToStream") === "Output") continue;
    const target = child(r, "Location", "VariableExpressionAst");
    if (r.t === "FileRedirectionAst" && target && target.Splatted === false && variableName(target) === "null") continue;
    return "a redirection that writes somewhere other than $null";
  }
  return null;
}
