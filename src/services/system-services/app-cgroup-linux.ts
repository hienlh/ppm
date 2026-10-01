/**
 * Which desktop app a pid belongs to, read from its systemd app cgroup.
 *
 * This is why PPM's Apps page needs no heuristics: a graphical session started by
 * systemd puts every app in its own app scope or app service, and the unit name
 * states the desktop-entry id rather than leaving it to be inferred from an
 * executable path. Measured on a 560-process desktop, reading every
 * `/proc/<pid>/cgroup` costs 2.8 ms, which the 2 s tick can afford.
 *
 * Pure. The caller supplies the file text.
 */

/** systemd escapes a character it cannot put in a unit name as a hex escape. */
export function unescapeSystemd(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * The desktop-entry id owning this pid, or null when it is not in an app scope -
 * a daemon, a kernel thread, anything started before the session.
 *
 * Four shapes appear on a real KDE/systemd desktop and all are handled here: a
 * scope with the launching pid appended, a scope whose id contains dots, a
 * service with a launch hash after an at-sign, and an autostart service whose id
 * was hex-escaped.
 *
 * The OUTERMOST app unit wins: an app service can contain further scopes, and the
 * wrapper is the one naming the app.
 */
export function appIdFromCgroup(cgroup: string): string | null {
  const match = /(?:^|\/)app-([^/]+?)\.(?:scope|service)(?:\/|$)/m.exec(cgroup);
  const raw = match?.[1];
  if (!raw) return null;
  const at = raw.indexOf("@");
  // The at-sign introduces systemd's instance part (a launch hash, or the word
  // autostart); without one the launcher appends the pid instead. Never both.
  const trimmed = at >= 0 ? raw.slice(0, at) : raw.replace(/-\d+$/, "");
  const id = unescapeSystemd(trimmed).trim();
  return id || null;
}

/**
 * Unit suffixes that can own processes. `.slice` is deliberately absent: a slice
 * is a grouping, and attributing a pid to `user.slice` would roll every user
 * process into one row that names nothing anybody can act on.
 */
const UNIT_SUFFIXES = [".service", ".scope", ".socket", ".mount", ".swap"] as const;

/**
 * The systemd unit owning this pid, suffix included, or null when it is in no
 * unit at all (the root slice, a kernel thread).
 *
 * The INNERMOST unit wins, which is `systemd-cgls`'s own answer: a user service
 * nests under `user@1000.service`, and reporting the wrapper would put every
 * desktop process on one row.
 *
 * The name is taken verbatim, escapes included — `systemctl list-units` reports
 * `dev-disk-by\x2duuid-….swap` the same way, and a name unescaped here would
 * match no row on the Services page.
 */
export function unitFromCgroup(cgroup: string): string | null {
  const path = systemdHierarchy(cgroup);
  if (!path) return null;
  const segments = path.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (UNIT_SUFFIXES.some((suffix) => segment.endsWith(suffix))) return segment;
  }
  return null;
}

/**
 * The cgroup path systemd tracks units in. Under v2 that is the single `0::`
 * line; under v1 it is whichever controller line is `name=systemd`, and reading
 * any other one (`cpu`, `memory`) gives a hierarchy that need not agree.
 */
export function systemdHierarchy(cgroup: string): string | null {
  for (const line of cgroup.split("\n")) {
    const first = line.indexOf(":");
    if (first < 0) continue;
    const second = line.indexOf(":", first + 1);
    if (second < 0) continue;
    const controllers = line.slice(first + 1, second);
    if (controllers === "" || controllers === "name=systemd") return line.slice(second + 1).trim() || null;
  }
  return null;
}

/**
 * `"<scope>:<unit>"` — the key the Services page rows are identified by, or null
 * when this pid belongs to no row it can show.
 *
 * The scope is not decoration. `dbus-broker.service` exists in BOTH scopes on
 * this dev host, so a roll-up keyed by the unit name alone would add a user
 * session's processes to the system unit's row and show one figure for two
 * different units.
 *
 * A user unit belonging to somebody ELSE returns null rather than that user's
 * unit name: PPM reads `systemctl --user` as its own user, so another uid's
 * units are not on the page at all, and attributing their processes to the
 * same-named row of ours would be a wrong reading rather than a missing one.
 *
 * Being under `/user.slice/` is NOT what makes a unit a user one — `session-2.scope`
 * and `user@1000.service` itself both live there and both belong to the SYSTEM
 * manager, which is where `systemctl list-units` reports them. Only a path
 * passing THROUGH `user@<uid>.service` is inside that user's own manager.
 */
export function serviceKeyFromCgroup(cgroup: string, selfUid: number): string | null {
  const unit = unitFromCgroup(cgroup);
  if (!unit) return null;
  const owner = /\/user@(\d+)\.service\//.exec(systemdHierarchy(cgroup) ?? "");
  if (!owner) return `system:${unit}`;
  return Number(owner[1]) === selfUid ? `user:${unit}` : null;
}
