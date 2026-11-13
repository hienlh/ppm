import { useEffect } from "react";
import { useJiraStore } from "@/stores/jira-store";
import { JIRA_CONFIG_CHANGED_EVENT, JIRA_WATCHERS_CHANGED_EVENT } from "../../shared/jira-events";

/**
 * Keeps an open Jira pane current when its configs or watchers change elsewhere — another device,
 * the `ppm jira` CLI, the Assistant. `use-global-events.ts` re-dispatches every `jira:` event from
 * `/ws/global` as a window event; this reads the affected lists again. `configId` is the config the
 * pane shows watchers for, if any.
 */
export function useJiraLiveRefresh(configId: number | undefined): void {
  useEffect(() => {
    const onConfig = () => {
      const store = useJiraStore.getState();
      void store.loadConfigs().catch(() => {});
      void store.loadProjectsWithIds().catch(() => {});
    };
    const onWatchers = () => {
      const store = useJiraStore.getState();
      if (configId !== undefined) void store.loadWatchers(configId).catch(() => {});
      void store.loadResults().catch(() => {});
      void store.loadUnreadCount().catch(() => {});
    };
    window.addEventListener(JIRA_CONFIG_CHANGED_EVENT, onConfig);
    window.addEventListener(JIRA_WATCHERS_CHANGED_EVENT, onWatchers);
    return () => {
      window.removeEventListener(JIRA_CONFIG_CHANGED_EVENT, onConfig);
      window.removeEventListener(JIRA_WATCHERS_CHANGED_EVENT, onWatchers);
    };
  }, [configId]);
}
