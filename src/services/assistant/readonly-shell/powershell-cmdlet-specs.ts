/**
 * The cmdlets a PowerShell script may run without asking, each with every parameter it may be
 * given and what kind of value that parameter takes. A parameter not listed asks — PowerShell
 * itself accepts any unique prefix of a parameter name, but here only full names and the listed
 * aliases count, so a prefix can never bind to a parameter PPM did not judge.
 *
 * Kinds:
 *  - `switch`: no value (`-Recurse`, or `-Recurse:$true`/`$false`)
 *  - `path` / `literalPath`: a file system path, judged by `judgeReadPath` (`path` refuses wildcards)
 *  - `text`: a literal string or number, or a list of them
 *  - `pattern`: a literal name pattern (`*.json`) naming no folder: `-Filter` goes to the Windows
 *    file search as written, and `Test-Path <dir> -Filter ..\x` answers for a file outside `<dir>`
 *  - `expr`: any expression the expression judge accepts
 *  - `props`: property names, calculated properties or script blocks (`Select-Object Name, @{…}`)
 *  - `member`: one literal member name (`-ExpandProperty`)
 *  - `block`: a script block the cmdlet runs over its input
 */
export type ParamKind = "switch" | "path" | "literalPath" | "text" | "pattern" | "expr" | "props" | "member" | "block" | "action" | "errorVariable";

export interface CmdletSpec {
  name: string;
  params: Readonly<Record<string, ParamKind>>;
  aliases?: Readonly<Record<string, string>>;
  /** Parameter each positional argument binds to, in order. */
  positional?: readonly string[];
  /** Positional binding that depends on the argument (`Where-Object { … }` vs `Where-Object Name`). */
  positionalFor?: (index: number, isScriptBlock: boolean) => string | undefined;
  /** Parameters that may be bound more than once (ForEach-Object's extra script blocks). */
  repeatable?: readonly string[];
  /**
   * Must start its pipeline: given pipeline input it would read a path or object it was handed
   * (`'C:\secret' | Get-Content`), which no rule here would see.
   */
  source?: boolean;
  /** Given no path, reads the current location. */
  usesCwd?: boolean;
  /** Given no path, does nothing useful and waits for a mandatory parameter: ask. */
  needsPath?: boolean;
  recursiveWhen?: readonly string[];
}

/** Parameters every cmdlet accepts. `-OutVariable` and `-Debug` are not here: one writes a variable PPM cannot see, the other prompts. */
export const COMMON_PARAMS: Readonly<Record<string, ParamKind>> = {
  erroraction: "action", warningaction: "action", errorvariable: "errorVariable", whatif: "switch", verbose: "switch",
};
export const COMMON_ALIASES: Readonly<Record<string, string>> = { ea: "erroraction", wa: "warningaction", ev: "errorvariable", wi: "whatif", vb: "verbose" };

const FILTER_TEXT = { filter: "pattern", include: "pattern", exclude: "pattern" } as const;
const PROPS_ONLY: Readonly<Record<string, ParamKind>> = { property: "props", inputobject: "expr" };
const COMPARISONS = ["eq", "ne", "gt", "ge", "lt", "le", "like", "notlike", "match", "notmatch", "contains", "notcontains", "in", "notin", "is", "isnot"];

/** CIM/WMI classes a script may list: none of them carries a command line or a secret. */
export const CIM_CLASSES = new Set(["win32_operatingsystem", "win32_pagefileusage", "win32_logicaldisk", "win32_processor", "win32_computersystem", "win32_physicalmemory"]);
/** Event logs a script may read with `Get-WinEvent -FilterHashtable`. */
export const EVENT_LOGS = new Set(["system", "application"]);

/**
 * `Get-Command` is not here: looking a name up can auto-load a module from the user's module
 * path, and importing a module runs its code.
 */
const SPECS: CmdletSpec[] = [
  { name: "Get-Process", params: { name: "expr", id: "expr", fileversioninfo: "switch" }, aliases: { processname: "name", pid: "id", fv: "fileversioninfo" }, positional: ["name"] },
  { name: "Get-Counter", params: { counter: "text", sampleinterval: "expr", maxsamples: "expr", listset: "expr" }, positional: ["counter"], source: true },
  { name: "Get-CimInstance", params: { classname: "text", filter: "text", property: "props", operationtimeoutsec: "expr", shallow: "switch" }, aliases: { class: "classname" }, positional: ["classname"], source: true },
  { name: "Get-WmiObject", params: { class: "text", filter: "text", property: "props" }, positional: ["class", "property"], source: true },
  {
    name: "Get-ChildItem",
    params: { path: "path", literalpath: "literalPath", ...FILTER_TEXT, recurse: "switch", depth: "expr", file: "switch", directory: "switch", hidden: "switch", readonly: "switch", system: "switch", force: "switch", name: "switch", attributes: "text" },
    aliases: { lp: "literalpath", pspath: "literalpath", s: "recurse", ad: "directory", af: "file", ah: "hidden", ar: "readonly", as: "system" },
    positional: ["path", "filter"], source: true, usesCwd: true, recursiveWhen: ["recurse", "depth"],
  },
  { name: "Get-Item", params: { path: "path", literalpath: "literalPath", ...FILTER_TEXT, force: "switch" }, aliases: { lp: "literalpath", pspath: "literalpath" }, positional: ["path"], source: true, usesCwd: true },
  {
    name: "Get-Content",
    params: { path: "path", literalpath: "literalPath", ...FILTER_TEXT, totalcount: "expr", tail: "expr", raw: "switch", encoding: "text", readcount: "expr", delimiter: "text", force: "switch" },
    aliases: { lp: "literalpath", pspath: "literalpath", head: "totalcount", first: "totalcount", last: "tail" },
    positional: ["path"], source: true, needsPath: true,
  },
  {
    name: "Select-String",
    params: { pattern: "expr", path: "path", literalpath: "literalPath", include: "pattern", exclude: "pattern", simplematch: "switch", casesensitive: "switch", notmatch: "switch", allmatches: "switch", list: "switch", quiet: "switch", context: "expr", encoding: "text", raw: "switch", noemphasis: "switch", culture: "text", inputobject: "expr" },
    aliases: { lp: "literalpath", pspath: "literalpath" },
    positional: ["pattern", "path"],
  },
  { name: "Test-Path", params: { path: "path", literalpath: "literalPath", ...FILTER_TEXT, pathtype: "text", isvalid: "switch", newerthan: "expr", olderthan: "expr" }, aliases: { lp: "literalpath", pspath: "literalpath", type: "pathtype" }, positional: ["path"], source: true, needsPath: true },
  { name: "Get-FileHash", params: { path: "path", literalpath: "literalPath", algorithm: "text" }, aliases: { lp: "literalpath", pspath: "literalpath" }, positional: ["path"], source: true, needsPath: true },
  {
    name: "Get-Date",
    params: { date: "expr", format: "expr", uformat: "expr", year: "expr", month: "expr", day: "expr", hour: "expr", minute: "expr", second: "expr", millisecond: "expr", displayhint: "text", asutc: "switch" },
    aliases: { lastwritetime: "date" }, positional: ["date"],
  },
  { name: "Get-PSDrive", params: { name: "text", psprovider: "text" }, positional: ["name"], source: true },
  { name: "Get-Volume", params: { driveletter: "expr" }, positional: ["driveletter"], source: true },
  { name: "Get-Service", params: { name: "expr", displayname: "expr", include: "pattern", exclude: "pattern", dependentservices: "switch", requiredservices: "switch" }, aliases: { servicename: "name", ds: "dependentservices", rs: "requiredservices" }, positional: ["name"], source: true },
  {
    name: "Get-NetTCPConnection",
    params: { localaddress: "expr", localport: "expr", remoteaddress: "expr", remoteport: "expr", state: "expr", owningprocess: "expr", appliedsetting: "expr", offloadstate: "expr" },
    positional: ["localaddress", "localport"], source: true,
  },
  { name: "Get-WinEvent", params: { filterhashtable: "expr", maxevents: "expr", oldest: "switch" }, source: true },
  { name: "Get-Location", params: {}, source: true },
  {
    name: "Where-Object",
    params: { filterscript: "block", property: "member", value: "expr", inputobject: "expr", not: "switch", ...Object.fromEntries(COMPARISONS.flatMap((op) => [[op, "switch"], [`c${op}`, "switch"]])) },
    positionalFor: (index, isBlock) => (index === 0 ? (isBlock ? "filterscript" : "property") : index === 1 ? "value" : undefined),
  },
  {
    name: "ForEach-Object",
    params: { process: "block", begin: "block", end: "block", remainingscripts: "block", inputobject: "expr" },
    positionalFor: (index) => (index === 0 ? "process" : "remainingscripts"),
    repeatable: ["remainingscripts"],
  },
  {
    name: "Select-Object",
    params: { property: "props", excludeproperty: "props", expandproperty: "member", first: "expr", last: "expr", skip: "expr", skiplast: "expr", unique: "switch", index: "expr", inputobject: "expr" },
    positional: ["property"],
  },
  { name: "Sort-Object", params: { ...PROPS_ONLY, descending: "switch", unique: "switch", casesensitive: "switch", top: "expr", bottom: "expr", stable: "switch", culture: "text" }, positional: ["property"] },
  { name: "Group-Object", params: { ...PROPS_ONLY, noelement: "switch", ashashtable: "switch", asstring: "switch", casesensitive: "switch", culture: "text" }, positional: ["property"] },
  {
    name: "Measure-Object",
    params: { ...PROPS_ONLY, sum: "switch", average: "switch", maximum: "switch", minimum: "switch", line: "switch", word: "switch", character: "switch", ignorewhitespace: "switch", standarddeviation: "switch", allstats: "switch" },
    positional: ["property"],
  },
  { name: "Format-Table", params: { ...PROPS_ONLY, autosize: "switch", wrap: "switch", hidetableheaders: "switch", repeatheader: "switch", groupby: "props" }, positional: ["property"] },
  { name: "Format-List", params: { ...PROPS_ONLY, groupby: "props" }, positional: ["property"] },
  { name: "Out-String", params: { width: "expr", stream: "switch", inputobject: "expr" } },
  { name: "ConvertFrom-Json", params: { inputobject: "expr", ashashtable: "switch", depth: "expr", noenumerate: "switch" }, positional: ["inputobject"] },
  { name: "ConvertTo-Json", params: { depth: "expr", compress: "switch", asarray: "switch", enumsasstrings: "switch" } },
];

const BY_NAME = new Map(SPECS.map((spec) => [spec.name.toLowerCase(), spec]));

/** Built-in aliases, on every platform unless listed under Windows only (pwsh on Linux runs `ls` and `cat` as programs). */
const ALIASES: Readonly<Record<string, string>> = {
  gci: "Get-ChildItem", dir: "Get-ChildItem", gi: "Get-Item", gc: "Get-Content", sls: "Select-String", gps: "Get-Process",
  gcim: "Get-CimInstance", gwmi: "Get-WmiObject", gsv: "Get-Service", gl: "Get-Location", pwd: "Get-Location",
  gdr: "Get-PSDrive", where: "Where-Object", "?": "Where-Object", foreach: "ForEach-Object", "%": "ForEach-Object",
  select: "Select-Object", group: "Group-Object", measure: "Measure-Object", ft: "Format-Table", fl: "Format-List",
};
const WINDOWS_ALIASES: Readonly<Record<string, string>> = { ls: "Get-ChildItem", cat: "Get-Content", type: "Get-Content", ps: "Get-Process", sort: "Sort-Object" };

/** The cmdlet `name` runs, through the fixed alias table; undefined for anything else. */
export function resolveCmdlet(name: string, platform: string): CmdletSpec | undefined {
  const lower = name.toLowerCase();
  const target = ALIASES[lower] ?? (platform === "win32" ? WINDOWS_ALIASES[lower] : undefined) ?? name;
  return BY_NAME.get(target.toLowerCase());
}

/** Whether `name` is one of PowerShell's built-in aliases on any platform (never a program then). */
export function isBuiltInAlias(name: string): boolean {
  const lower = name.toLowerCase();
  return Object.hasOwn(ALIASES, lower) || Object.hasOwn(WINDOWS_ALIASES, lower);
}
