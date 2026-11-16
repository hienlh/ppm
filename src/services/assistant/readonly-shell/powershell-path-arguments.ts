import { isNode, list, str, variablePath, type PsNode } from "./powershell-ast-types.ts";
import { READABLE_ENV, type PsScope, type Refusal } from "./powershell-judge-scope.ts";
import { judgeReadPath } from "./readonly-path-check.ts";

/**
 * A path a cmdlet is given, turned into the text the file system provider receives and judged by
 * the same rule as every other read (`judgeReadPath`). Only text PPM can spell out exactly is
 * accepted: a literal, or a double-quoted string whose only variables are folder-valued `$env:`
 * names, filled in from the environment the command runs with.
 */

const ENV_REFERENCE = /\$\{env:([^}]*)\}|\$env:([A-Za-z0-9_]+)/gi;

/** The literal text of a double-quoted path with its `$env:` folders filled in, or why not. */
function expandEnvPath(n: PsNode, s: PsScope): { text: string } | { refusal: string } {
  const value = str(n, "Value");
  const nested = list(n, "NestedExpressions");
  if (value === undefined || !nested) return { refusal: "a path PPM cannot read" };
  const names: string[] = [];
  for (const expr of nested) {
    const path = isNode(expr) && expr.t === "VariableExpressionAst" && expr.Splatted === false ? variablePath(expr) : undefined;
    const [drive, name = ""] = path?.IsDriveQualified ? path.UserPath.split(":", 2) : [];
    if (drive?.toLowerCase() !== "env" || !READABLE_ENV.has(name.toLowerCase())) return { refusal: "a path built from something other than a folder's environment variable" };
    names.push(name);
  }
  const env = s.ctx.env;
  if (!env) return { refusal: "a path built from the environment, which PPM was not given" };
  // `Value` is the string after escapes are processed, so `\`$env:X` reads as a reference here
  // too; requiring one reference per nested variable, in order, refuses exactly that case.
  const found: string[] = [];
  let missing: string | null = null;
  const text = value.replace(ENV_REFERENCE, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    found.push(name);
    const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!entry || typeof entry[1] !== "string" || !entry[1]) missing = name;
    return entry?.[1] ?? "";
  });
  if (found.length !== names.length || found.some((name, i) => name.toLowerCase() !== names[i]!.toLowerCase())) {
    return { refusal: "a path whose text does not match the variables PowerShell expands in it" };
  }
  if (missing) return { refusal: `$env:${missing} is not set in the command's environment` };
  if (text.includes("$")) return { refusal: "a path with a variable PPM does not expand" };
  return { text };
}

/** Every path text a parameter value stands for: one literal, one expanded string or a list of them. */
export function pathTexts(n: PsNode, s: PsScope): { texts: string[] } | { refusal: string } {
  const items = n.t === "ArrayLiteralAst" ? list(n, "Elements") : [n];
  if (!items) return { refusal: "a path list PPM cannot read" };
  const texts: string[] = [];
  for (const item of items) {
    if (!isNode(item)) return { refusal: "a path PPM cannot read" };
    if (item.t === "StringConstantExpressionAst") {
      const value = str(item, "Value");
      if (value === undefined) return { refusal: "a path PPM cannot read" };
      texts.push(value);
    } else if (item.t === "ExpandableStringExpressionAst") {
      const expanded = expandEnvPath(item, s);
      if ("refusal" in expanded) return expanded;
      texts.push(expanded.text);
    } else {
      return { refusal: "a path computed by an expression PPM cannot spell out" };
    }
  }
  return { texts };
}

/**
 * Text the file system provider would read as something other than a plain path: another
 * provider's drive (`Env:`, `HKLM:`, `Cert:`), a provider-qualified path, a network path, an
 * NTFS stream, an 8.3 short name, an escape, or — for `-Path` — a wildcard that could match a
 * name PPM never saw.
 */
function providerTextRefusal(text: string, wildcards: boolean): Refusal {
  if (!text) return "an empty path";
  if (text.includes("`")) return `${text}: an escaped path`;
  if (wildcards && /[*?[\]]/.test(text)) return `${text}: a wildcard path (use -LiteralPath or -Filter)`;
  if (text.includes("::")) return `${text}: a provider-qualified path`;
  if (/^[\\/]{2}/.test(text)) return `${text}: a network or device path`;
  if (/^[^\\/:]{2,}:/.test(text)) return `${text}: a drive of another PowerShell provider`;
  if (/^[A-Za-z]:(?![\\/])/.test(text)) return `${text}: a path relative to a drive's current folder`;
  if (text.indexOf(":", 2) !== -1) return `${text}: an NTFS alternate data stream`;
  if (text.indexOf("~", 1) !== -1) return `${text}: a \`~\` inside a path may be a short 8.3 name for another folder`;
  return null;
}

/** Judges every path a parameter value names. `literal` is `-LiteralPath`, which never expands wildcards. */
export function judgePathArgument(n: PsNode, s: PsScope, opts: { literal: boolean; recursive: boolean }): Refusal {
  const result = pathTexts(n, s);
  if ("refusal" in result) return result.refusal;
  for (const text of result.texts) {
    const refusal = providerTextRefusal(text, !opts.literal);
    if (refusal) return refusal;
    // The file system provider takes either slash on every platform; the path rule expects the host's.
    const native = s.platform === "win32" ? text : text.replace(/\\/g, "/");
    const verdict = judgeReadPath(native, { ...s.ctx, platform: s.platform }, { recursive: opts.recursive });
    if (verdict.verdict === "ask") return verdict.reason;
  }
  return null;
}
