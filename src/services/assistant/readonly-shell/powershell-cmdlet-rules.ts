import { isNode, list, literalTexts, soleExpression, str, type PsNode, type PsValue } from "./powershell-ast-types.ts";
import type { BoundArgs } from "./powershell-command-judge.ts";
import { CIM_CLASSES, EVENT_LOGS, type CmdletSpec } from "./powershell-cmdlet-specs.ts";
import type { Refusal } from "./powershell-judge-scope.ts";

/**
 * Rules a parameter table cannot express: which CIM classes and event logs may be read, what a
 * cmdlet may be handed through the pipeline, and when serializing objects to JSON is safe.
 */

/** Commands whose output is text, so a `Select-String` after them searches text, not files. */
const TEXT_PRODUCERS = new Set(["get-content", "out-string", "select-string", "convertto-json"]);
/** What may stand between `ConvertFrom-Json` and `ConvertTo-Json`: filters that keep the parsed data. */
const JSON_KEEPERS = new Set(["select-object", "where-object", "sort-object"]);
const EVENT_FILTER_KEYS = new Set(["logname", "providername", "id", "level", "starttime", "endtime", "keywords"]);

function only(bound: BoundArgs, param: string): PsNode | undefined {
  const values = bound.get(param);
  const v = values?.length === 1 ? values[0] : undefined;
  return typeof v === "object" ? v : undefined;
}

/** A literal string, or undefined for anything computed. */
function literal(n: PsValue | undefined): string | undefined {
  return isNode(n) && n.t === "StringConstantExpressionAst" ? str(n, "Value") : undefined;
}

function judgeCimClass(bound: BoundArgs, param: string): Refusal {
  const name = literal(only(bound, param));
  if (!name) return "a CIM class that is not written out";
  return CIM_CLASSES.has(name.toLowerCase()) ? null : `the CIM class ${name} is not one PPM knows to hold no secrets`;
}

/**
 * Event ids whose message carries a service's full command line, and with it any token the
 * service was installed with: 7045 (System, "a service was installed") and 4697 (its Security
 * twin, in case a log is ever added).
 */
const DENIED_EVENT_IDS = new Set(["7045", "4697"]);

/**
 * Get-WinEvent reads only named events of the System or Application log: the filter must be a
 * literal hashtable with a literal LogName and a literal Id (or list of them). A filter by log
 * alone would hand over every message in it, service command lines included.
 */
function judgeEventFilter(bound: BoundArgs): Refusal {
  const table = only(bound, "filterhashtable");
  if (!table || table.t !== "HashtableAst") return "Get-WinEvent without a literal -FilterHashtable";
  let logNamed = false;
  let idsNamed = false;
  for (const pair of list(table, "KeyValuePairs") ?? [null]) {
    const key = Array.isArray(pair) ? literal(pair[0])?.toLowerCase() : undefined;
    if (!key || !EVENT_FILTER_KEYS.has(key)) return "a -FilterHashtable key PPM does not know";
    if (key !== "logname" && key !== "id") continue;
    const value = soleExpression(Array.isArray(pair) ? pair[1] : undefined);
    const texts = value ? literalTexts(value) : undefined;
    if (!texts || texts.length === 0) return `a -FilterHashtable ${key} that is not written out`;
    if (key === "logname") {
      if (!texts.every((t) => EVENT_LOGS.has(t.toLowerCase()))) return "an event log other than System or Application";
      logNamed = true;
    } else {
      if (!texts.every((t) => /^\d+$/.test(t))) return "an event id that is not a number";
      if (texts.some((t) => DENIED_EVENT_IDS.has(String(Number(t))))) return "an event whose message holds a service's command line";
      idsNamed = true;
    }
  }
  if (!logNamed) return "Get-WinEvent without LogName System or Application";
  return idsNamed ? null : "Get-WinEvent without a literal event Id";
}

export function judgeCmdletRules(spec: CmdletSpec, bound: BoundArgs, previous: readonly string[]): Refusal {
  switch (spec.name) {
    case "Get-CimInstance":
      return judgeCimClass(bound, "classname");
    case "Get-WmiObject":
      return judgeCimClass(bound, "class");
    case "Get-Counter": {
      // A counter path can name another computer (`\\server\Memory\...`), which is the network.
      const counters = (bound.get("counter") ?? []).flatMap((v) => (typeof v === "object" ? literalTexts(v) ?? ["//"] : []));
      return counters.some((c) => /^[\\/]{2}/.test(c)) ? "a counter on another computer" : null;
    }
    case "Get-WinEvent":
      return judgeEventFilter(bound);
    case "Get-PSDrive": {
      const provider = literal(only(bound, "psprovider"));
      const name = literal(only(bound, "name"));
      if (bound.has("psprovider") ? provider?.toLowerCase() === "filesystem" : /^[A-Za-z]$/.test(name ?? "")) return null;
      return "Get-PSDrive outside the FileSystem provider";
    }
    case "Select-String": {
      const pathGiven = bound.has("path") || bound.has("literalpath");
      if (previous.length === 0) return null;
      if (pathGiven) return "Select-String given both pipeline input and a path";
      const last = previous[previous.length - 1]!;
      return TEXT_PRODUCERS.has(last) || last.startsWith("native:") ? null : "Select-String after a command that may hand it files to read";
    }
    case "ConvertFrom-Json": {
      // What it parses must be text, so that what it hands on is data and never a live object.
      const last = previous[previous.length - 1];
      return !last || last === "expression" || TEXT_PRODUCERS.has(last) || last.startsWith("native:") ? null : "ConvertFrom-Json given objects rather than text";
    }
    case "ConvertTo-Json": {
      // Serializing a live object walks its properties several levels deep, which reaches a
      // process's command line (PowerShell 7) or the environment Windows PowerShell copies into
      // `StartInfo`. Data parsed from JSON text holds nothing of the kind.
      const from = previous.lastIndexOf("convertfrom-json");
      if (from >= 0 && previous.slice(from + 1).every((label) => JSON_KEEPERS.has(label))) return null;
      return "ConvertTo-Json of objects that were not parsed from JSON";
    }
    default:
      return null;
  }
}
