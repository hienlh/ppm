/**
 * Sent on `/ws/global` after a design is created, renamed, deleted or restored, whoever did it:
 * the Designs sidebar, the `ppm design` CLI, a chat. Carries `projectName`; the design lists of
 * that project read their list again. Changes made on disk (an agent, a git checkout) still
 * arrive as `file:changed`, and only for the project a browser watches; this one reaches every
 * open PPM.
 */
export const DESIGN_LIST_CHANGED_EVENT = "design:list_changed";
