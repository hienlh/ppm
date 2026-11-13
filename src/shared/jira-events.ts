/**
 * Sent on `/ws/global` after a Jira write answers with a 2xx, whoever made it (the Jira panel, the
 * `ppm jira` CLI, the Assistant), so every open Jira panel reads its list again instead of showing
 * the change only after a reload. `use-global-events.ts` re-dispatches every `jira:` event as a
 * window event of the same name.
 */
/** A project's Jira site, email or token was saved or removed. */
export const JIRA_CONFIG_CHANGED_EVENT = "jira:config_changed";
/** A watcher was added, edited, switched, removed or pulled, or a tracked ticket added or removed. */
export const JIRA_WATCHERS_CHANGED_EVENT = "jira:watchers_changed";

export type JiraChangeEvent = typeof JIRA_CONFIG_CHANGED_EVENT | typeof JIRA_WATCHERS_CHANGED_EVENT;
