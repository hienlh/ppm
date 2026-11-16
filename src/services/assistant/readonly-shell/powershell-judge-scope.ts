import type { ReadonlyShellContext } from "./readonly-path-check.ts";

/**
 * What every part of the PowerShell judge reads: the context the command is judged against and
 * the local variables the script has assigned so far. A rule answers `null` when the construct
 * only reads, or a short English reason when it must ask.
 */
export interface PsScope {
  ctx: ReadonlyShellContext;
  /** The platform whose shell runs the script; decides which aliases exist. */
  platform: string;
  /** Lower-cased names of plain local variables assigned earlier in the script. */
  locals: Set<string>;
}

export type Refusal = string | null;

/** The first refusal among `checks`, evaluated lazily in order. */
export function firstRefusal(...checks: (() => Refusal)[]): Refusal {
  for (const check of checks) {
    const r = check();
    if (r) return r;
  }
  return null;
}

/**
 * Names a script may not assign to: PowerShell's automatic variables and the preference
 * variables that change how later commands behave (`$PSDefaultParameterValues` adds parameters
 * PPM never saw, `$PSNativeCommandArgumentPassing` changes what a program receives). Only
 * `$null` (discarding output) and the error/progress/warning preferences are writable.
 */
const RESERVED_VARIABLES = new Set([
  "_", "psitem", "args", "input", "this", "true", "false", "error", "matches", "myinvocation", "host", "home", "pshome",
  "pwd", "pid", "shellid", "executioncontext", "stacktrace", "psboundparameters", "pscmdlet", "pscommandpath", "psscriptroot",
  "psversiontable", "psculture", "psuiculture", "psdebugcontext", "pssenderinfo", "lastexitcode", "foreach", "switch",
  "event", "eventargs", "eventsubscriber", "sender", "nestedpromptlevel", "profile", "ofs", "outputencoding",
  "psdefaultparametervalues", "psemailserver", "psmoduleautoloadingpreference", "psnativecommandargumentpassing",
  "psnativecommanduseerroractionpreference", "pssessionapplicationname", "pssessionconfigurationname", "pssessionoption",
  "psstyle", "maximumhistorycount", "isglobal", "iscoreclr", "islinux", "ismacos", "iswindows", "enabledexperimentalfeatures",
]);
const WRITABLE_PREFERENCES = new Set(["erroractionpreference", "progresspreference", "warningpreference"]);

/** Whether `name` (as written after `$`) may be assigned as a plain local variable. */
export function isAssignableLocal(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "null" || WRITABLE_PREFERENCES.has(lower)) return true;
  if (!/^[a-z][a-z0-9_]*$/.test(lower)) return false;
  return !RESERVED_VARIABLES.has(lower) && !lower.endsWith("preference");
}

/** Automatic variables a script may read: the pipeline item, constants and `-match` captures. */
export const READABLE_AUTOMATIC = new Set(["_", "psitem", "null", "true", "false", "matches"]);

/** Environment variables a script may read: folders, never values that may hold a secret. */
export const READABLE_ENV = new Set(["userprofile", "home", "appdata", "localappdata", "temp", "tmp", "programdata", "systemroot"]);

/**
 * Member names that reach a secret wherever they appear: a process's command line, a service's
 * (`BinaryPathName` in PowerShell 7 — a tunnel service installed with `--token …` carries its
 * token there), the environment `Process.StartInfo` copies from PowerShell's own process on
 * Windows PowerShell, credentials, and the reflection doors (`psobject`) through which a name
 * can be reached by a string the judge cannot see.
 */
const DENIED_MEMBERS = new Set([
  "commandline", "binarypathname", "pathname", "startinfo", "environment", "environmentvariables", "password", "securepassword", "credential",
  "psobject", "psbase", "psadapted", "psextended", "ciminstanceproperties",
]);

export function memberRefusal(name: string): Refusal {
  return DENIED_MEMBERS.has(name.toLowerCase()) ? `the member ${name} can reveal secrets` : null;
}
