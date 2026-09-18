/**
 * freedesktop `.desktop` parsing for the Apps page - Mission Center's app list.
 *
 * MC delegates this to its own `app-rummage` crate; PPM parses the entries
 * directly because it only needs four fields, and the matching is done from
 * systemd's app cgroups (see `app-cgroup-linux.ts`), which name the desktop id
 * outright rather than guessing it from an executable path.
 *
 * Pure: every function takes the file's text. Nothing here touches the disk.
 */

export interface DesktopEntry {
  /** File name without the suffix - the id systemd's app cgroups carry. */
  id: string;
  name: string;
  /** A theme icon name or an absolute path. Null when the entry has none. */
  icon: string | null;
  /** Exec with the field codes removed. Null when the entry has none. */
  exec: string | null;
  /** The author asked for this entry not to appear in menus. */
  noDisplay: boolean;
}

/**
 * The percent-codes an Exec may carry. The launcher substitutes files and URLs
 * for them, so one left in the string would be shown to the user and would break
 * any comparison against a real command line.
 */
const FIELD_CODES = /%[fFuUdDnNickvm]/g;
/** A doubled percent is a literal one; parking it keeps the round trip lossless. */
const PERCENT_SENTINEL = " PPM_PCT ";

export function stripFieldCodes(exec: string): string {
  return exec
    .replaceAll("%%", PERCENT_SENTINEL)
    .replace(FIELD_CODES, " ")
    .replaceAll(PERCENT_SENTINEL, "%")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads the `[Desktop Entry]` group only. An entry's actions live in their own
 * `[Desktop Action ...]` groups with their own Name, Icon and Exec, so a parser
 * that scans the whole file takes the LAST action's name as the app's.
 *
 * Returns null for anything that is not a launchable application: a Link entry,
 * `Hidden=true` (the spec says treat it as deleted) and an entry with no Name.
 */
export function parseDesktopEntry(id: string, text: string): DesktopEntry | null {
  const fields: Record<string, string> = {};
  let inGroup = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inGroup = line === "[Desktop Entry]";
      continue;
    }
    if (!inGroup || !line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    // A bracketed key is a translation. PPM shows the unlocalised value so the
    // id, the list and any log line all name the app the same way.
    if (key.includes("[")) continue;
    if (fields[key] === undefined) fields[key] = line.slice(eq + 1).trim();
  }

  if (fields.Type !== "Application") return null;
  if (fields.Hidden === "true") return null;
  const name = fields.Name?.trim();
  if (!name) return null;

  const exec = fields.Exec ? stripFieldCodes(fields.Exec) : "";
  return {
    id,
    name,
    icon: fields.Icon?.trim() || null,
    exec: exec || null,
    noDisplay: fields.NoDisplay === "true",
  };
}

/**
 * The program an Exec actually runs, as a bare file name - the fallback match for
 * an app started outside a systemd app scope (from a terminal, say), where there
 * is no cgroup to read the id from.
 *
 * Leading assignments and an `env` wrapper are skipped: an Exec of
 * `env GDK_BACKEND=x11 /usr/bin/foo` runs foo, not env.
 */
export function execBinary(exec: string | null): string | null {
  if (!exec) return null;
  const tokens = exec.match(/"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const t = token.replace(/^"|"$/g, "");
    if (!t || t === "env" || t.includes("=")) continue;
    const slash = t.lastIndexOf("/");
    const base = slash >= 0 ? t.slice(slash + 1) : t;
    return base || null;
  }
  return null;
}
