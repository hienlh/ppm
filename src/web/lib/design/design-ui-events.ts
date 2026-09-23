/**
 * App-wide requests between the places that start design work and the one component that
 * handles each.
 *
 * - `NEW_DESIGN_EVENT` opens the New Design dialog. The command palette hosts it because
 *   the palette is always mounted, on every layout; the sidebar section is not (on a phone
 *   it lives in a drawer that is usually closed).
 * - `DESIGNS_CHANGED_EVENT` tells design lists to refetch after this client created,
 *   renamed or deleted one; changes made on disk arrive as `file:changed` instead.
 */

export const NEW_DESIGN_EVENT = "ppm:new-design";
export const DESIGNS_CHANGED_EVENT = "ppm:designs-changed";

export interface NewDesignRequest {
  projectName: string;
}

export function requestNewDesign(projectName: string): void {
  window.dispatchEvent(new CustomEvent<NewDesignRequest>(NEW_DESIGN_EVENT, { detail: { projectName } }));
}

export function announceDesignsChanged(projectName: string): void {
  window.dispatchEvent(new CustomEvent(DESIGNS_CHANGED_EVENT, { detail: { projectName } }));
}
