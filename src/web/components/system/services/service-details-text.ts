/**
 * The words of the Services details sheet that depend on the manager: where the
 * log came from, what an empty one means, and a launchd job's command and output.
 * Pure and React-free; relative imports only.
 */
import type { ServiceDetails, ServiceLogSource, ServiceManager } from "../../../../types/system-services";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/** The heading over the log box. `source` is undefined until the details arrive. */
export function logHeading(manager: ServiceManager, source: ServiceLogSource | undefined): string {
  if (manager === "systemd") return "Log (this boot)";
  if (manager === "scm") return "Event log (this boot)";
  if (!source) return "Log";
  if (source.kind === "files") return `Log (${source.paths.map(baseName).join(", ")})`;
  if ("since" in source) return source.since === "boot" ? "Log (this boot)" : "Log (since the job started)";
  return `Log (last ${source.minutes} minutes)`;
}

export function logLoadingText(manager: ServiceManager): string {
  if (manager === "scm") return "Reading the event log…";
  return manager === "systemd" ? "Reading the journal…" : "Reading the log…";
}

export function logEmptyText(manager: ServiceManager, source: ServiceLogSource | undefined): string {
  // Windows 10 and later no longer record routine start/stop events, so an empty
  // log is the normal case for a healthy service rather than a sign of a problem.
  if (manager === "scm") return "No events this boot.";
  if (manager === "systemd" || !source) return "No entries this boot.";
  if (source.kind === "files") return source.paths.length > 1 ? "The log files are empty." : "The log file is empty.";
  if ("since" in source) return source.since === "boot" ? "No entries this boot." : "No entries since the job started.";
  return `No entries in the last ${source.minutes} minutes.`;
}

/** The arguments after argv[0], which is the program again. Quoted where a space
 *  would otherwise make one argument read as two. */
export function argumentsText(args: readonly string[] | undefined): string {
  const rest = (args ?? []).slice(1).map((a) => (a === "" || /\s/.test(a) ? JSON.stringify(a) : a));
  return rest.length > 0 ? rest.join(" ") : "—";
}

/** Where stdout and stderr go: one path when they share a file, which most do. */
export function outputText(details: Pick<ServiceDetails, "stdoutPath" | "stderrPath"> | null): string {
  const out = details?.stdoutPath ?? null;
  const err = details?.stderrPath ?? null;
  if (!out && !err) return "—";
  if (out === err) return out!;
  return [out && `stdout ${out}`, err && `stderr ${err}`].filter(Boolean).join(" · ");
}
