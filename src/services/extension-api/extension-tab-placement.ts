import type { ExtTabPlacement } from "../../types/extension-messages.ts";

/** Longer than any panel id PPM mints (`<extension id>-wv-<n>`, the id capped by npm at 214). */
const MAX_PANEL_ID_LENGTH = 256;

/**
 * The placement an extension asked for, as it may travel to the browser: only a literal
 * `preferWindow: true` counts, and a panel id is kept only when it is a short printable
 * string. Anything else is dropped rather than refused — placement is a preference, and a
 * malformed one must not stop the tab from opening.
 */
export function parseTabPlacement(value: unknown): ExtTabPlacement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.preferWindow !== true) return undefined;
  const panelId = raw.besidePanelId;
  const validPanelId = typeof panelId === "string" && panelId.length > 0
    && panelId.length <= MAX_PANEL_ID_LENGTH && /^[\x21-\x7e]+$/.test(panelId);
  return validPanelId ? { preferWindow: true, besidePanelId: panelId } : { preferWindow: true };
}
