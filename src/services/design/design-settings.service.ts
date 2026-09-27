import { getConfigValue, setConfigValue } from "../db.service.ts";

/**
 * The global design settings, one row in the SQLite `config` table like the file filters.
 * Stored under a dotted key rather than as a `PpmConfig` field, so `configService.save()`
 * never rewrites it and an older build, which does not know the key, simply ignores it.
 */
export const DESIGN_INSTRUCTIONS_KEY = "design.instructions";

/** The saved text, or "" when none was saved or the row is unreadable. */
export function getDesignInstructions(): string {
  const raw = getConfigValue(DESIGN_INSTRUCTIONS_KEY);
  if (!raw) return "";
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** Callers validate first (`normalizeDesignInstructions`); this only persists. */
export function setDesignInstructions(text: string): void {
  setConfigValue(DESIGN_INSTRUCTIONS_KEY, JSON.stringify(text));
}
