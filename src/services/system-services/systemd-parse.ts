/**
 * Pure parsers for systemd's text output - Mission Center's Services page, read
 * through `systemctl` instead of D-Bus.
 *
 * MC talks to org.freedesktop.systemd1 over zbus. PPM has no D-Bus client in Bun,
 * and shelling out is not the compromise it looks like: `list-units` plus ONE
 * multi-unit `show` covers all 239 units on this host in 6 ms total, against MC's
 * property read per unit. What is lost is change signalling, so the page polls
 * (SERVICES_POLL_INTERVAL_MS) rather than subscribing.
 *
 * Mission Center also reads `list-unit-files` for the enabled flag. That call
 * alone measured 322 ms here and `show` already answers UnitFileState for every
 * unit that has one - the 26 units it leaves empty have no unit file at all, so
 * the file list would not know them either. It is not made.
 *
 * Nothing here spawns anything; every function takes the captured stdout.
 */
import type { ServiceInfo, ServiceLogLine, ServiceScope } from "../../types/system-services.ts";

/** Mission Center lists exactly these three unit types and ignores the rest. */
export const LISTED_SUFFIXES: readonly string[] = [".service", ".socket", ".mount"];

export function isListedUnit(name: string): boolean {
  return LISTED_SUFFIXES.some((s) => name.endsWith(s));
}

export interface ListUnitsRow {
  unit: string;
  loadState: string;
  activeState: string;
  subState: string;
  description: string;
}

/**
 * `systemctl list-units --plain --no-legend` gives UNIT LOAD ACTIVE SUB DESCRIPTION.
 *
 * The `--plain` flag is supposed to drop the leading status bullet, but a failed
 * unit is still marked in some versions, so it is stripped defensively - an
 * unstripped bullet would shift every column by one and rename every unit.
 */
export function parseListUnits(stdout: string): ListUnitsRow[] {
  const rows: ListUnitsRow[] = [];
  for (const line of stdout.split("\n")) {
    const cleaned = line.trim().replace(/^[●○×→*]\s+/, "");
    if (!cleaned) continue;
    const parts = cleaned.split(/\s+/);
    if (parts.length < 4) continue;
    const [unit, loadState, activeState, subState] = parts as [string, string, string, string];
    rows.push({ unit, loadState, activeState, subState, description: parts.slice(4).join(" ") });
  }
  return rows;
}

/** One Key=Value block from `systemctl show`. A value may itself contain "=". */
export function parseShowBlock(block: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    record[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return record;
}

/**
 * A multi-unit `show` writes one block per unit separated by a blank line. Keyed
 * by Id rather than by position: `show` answers under the unit's CANONICAL name,
 * so asking about an alias comes back under a different one, and a positional
 * read would attach every later unit's figures to the wrong row.
 */
export function parseShowRecords(stdout: string): Map<string, Record<string, string>> {
  const byId = new Map<string, Record<string, string>>();
  for (const block of stdout.split(/\n[ \t]*\n/)) {
    const record = parseShowBlock(block);
    if (record.Id) byId.set(record.Id, record);
  }
  return byId;
}

/** Properties one `show` call must ask for to fill a ServiceInfo. */
export const SHOW_PROPERTIES: readonly string[] = [
  "Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID",
];

/** Everything a details pane adds on top of a list row. */
export const SHOW_DETAIL_PROPERTIES: readonly string[] = [
  ...SHOW_PROPERTIES, "User", "Group", "FragmentPath",
];

/**
 * Mission Center's three booleans, derived exactly as it does: ActiveState
 * "active" is running, "failed" is failed, and enabled is the unit-file state
 * being the literal string "enabled" - static, indirect, alias, generated and
 * masked all count as not enabled.
 */
export function toServiceInfo(
  row: ListUnitsRow,
  scope: ServiceScope,
  show: Record<string, string> | undefined,
): ServiceInfo {
  const activeState = show?.ActiveState || row.activeState;
  const subState = show?.SubState || row.subState;
  // An empty UnitFileState means the unit has no unit file, which is null rather
  // than a state of "".
  const fileState = show?.UnitFileState ?? "";
  const mainPid = Number(show?.MainPID ?? "0");
  return {
    unit: row.unit,
    scope,
    description: row.description || show?.Description || "",
    activeState,
    subState,
    unitFileState: fileState || null,
    running: activeState === "active",
    failed: activeState === "failed",
    enabled: fileState === "enabled",
    mainPid: Number.isFinite(mainPid) && mainPid > 0 ? mainPid : null,
  };
}

/** Drops what Mission Center drops: the wrong unit type, and a name systemd knows
 *  with no file behind it. Masked units deliberately stay in the list. */
export function keepUnit(row: ListUnitsRow): boolean {
  return isListedUnit(row.unit) && row.loadState !== "not-found";
}

/**
 * `journalctl -o json`, one JSON object per line.
 *
 * The short-iso form would be shorter to parse and is wrong: a multi-line message
 * - a stack trace, a core dump report - prints as continuation lines with no
 * timestamp, so each would become its own bogus entry. The JSON form keeps one
 * record per entry whatever is in it.
 */
export function parseJournalJson(stdout: string): ServiceLogLine[] {
  const lines: ServiceLogLine[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = journalMessage(record.MESSAGE);
    if (message === null) continue;
    const micros = Number(record.__REALTIME_TIMESTAMP);
    lines.push({ ts: Number.isFinite(micros) ? Math.round(micros / 1000) : 0, message });
  }
  return lines;
}

/** journald keeps a message that is not valid UTF-8 as an array of byte values. */
export function journalMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const bytes = value.filter((n): n is number => typeof n === "number" && n >= 0 && n <= 255);
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
  return null;
}
