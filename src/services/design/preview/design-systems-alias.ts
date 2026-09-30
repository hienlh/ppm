import { isValidSystemId } from "../design-systems-paths.ts";

/**
 * Splits the tail of a `systems/<id>/<rest>` (or `../systems/<id>/<rest>`) reference into the
 * app id and the path under its design-system folder. Shared by the preview scope (which
 * serves the live canvas) and the export readers (zip, standalone HTML), so both agree on
 * exactly the same shape.
 */
export interface SystemsAliasTail {
  id: string;
  /** "" for the bare `systems/<id>`, which every caller must still refuse to serve. */
  rest: string;
}

export function parseSystemsAliasTail(tail: string): SystemsAliasTail | null {
  const slash = tail.indexOf("/");
  const id = slash < 0 ? tail : tail.slice(0, slash);
  const rest = slash < 0 ? "" : tail.slice(slash + 1);
  return isValidSystemId(id) ? { id, rest } : null;
}
