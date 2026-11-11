/**
 * Sent on `/ws/global` when the server changed the registered projects on its own initiative (the
 * Assistant's `project_add`), so every open PPM refetches its project list instead of showing the
 * new project only after a reload.
 */
export const PROJECTS_CHANGED_EVENT = "projects:changed";
