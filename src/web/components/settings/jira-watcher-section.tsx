/**
 * The Jira Watcher master switch.
 *
 * Only the switch lives here: turning it on adds a Jira tab to the sidebar rail, and that
 * panel owns project config, watchers, and results. Duplicating those controls here would
 * give the same settings two homes.
 */

import { useShallow } from "zustand/react/shallow";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings-store";

export function JiraWatcherSection() {
  const { jiraEnabled, setJiraEnabled } = useSettingsStore(
    useShallow((s) => ({ jiraEnabled: s.jiraEnabled, setJiraEnabled: s.setJiraEnabled })),
  );

  return (
    <div className="space-y-4">
      <section className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Jira Watcher</p>
          <p className="text-xs text-muted-foreground">Auto-debug Jira tickets</p>
        </div>
        <Switch checked={jiraEnabled} onCheckedChange={setJiraEnabled} />
      </section>
      <p className="text-xs text-muted-foreground">
        {jiraEnabled
          ? "Configure projects, watchers, and results in the Jira tab on the sidebar."
          : "Enable to add a Jira tab to the sidebar, where projects and watchers are configured."}
      </p>
    </div>
  );
}
