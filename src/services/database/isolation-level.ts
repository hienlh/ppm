/**
 * The isolation level a connection's Save runs its transaction at, as SQL may name it.
 *
 * A level is written into the statement (`BEGIN ISOLATION LEVEL …`, `SET TRANSACTION …`), where
 * no parameter can go, so it is matched against the four the standard names rather than trusted:
 * a config can reach `ppm.db` through an import as well as through the form.
 */
import { ISOLATION_LEVELS, type IsolationLevel } from "../../shared/db-connection-config.ts";

/** `level` if it is one of the four, null when none is set; anything else is refused. */
export function isolationLevelSql(level: unknown): IsolationLevel | null {
  if (level === undefined || level === null || level === "") return null;
  const upper = typeof level === "string" ? level.toUpperCase() : "";
  if (!ISOLATION_LEVELS.includes(upper as IsolationLevel)) {
    throw new Error(`Unknown isolation level "${String(level)}" — use ${ISOLATION_LEVELS.join(", ")}`);
  }
  return upper as IsolationLevel;
}
