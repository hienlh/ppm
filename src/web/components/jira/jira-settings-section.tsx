import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useJiraStore } from "@/stores/jira-store";
import { JiraConfigForm } from "./jira-config-form";
import { JiraWatcherList } from "./jira-watcher-list";

export function JiraSettingsSection() {
  const {
    configs, selectedProjectId, setSelectedProjectId,
    loadConfigs, loadWatchers, projectsWithIds, loadProjectsWithIds,
  } = useJiraStore();

  useEffect(() => { loadConfigs(); loadProjectsWithIds(); }, []);

  const selectedConfig = configs.find((c) => c.projectId === selectedProjectId);

  useEffect(() => {
    if (selectedConfig) loadWatchers(selectedConfig.id);
  }, [selectedConfig?.id]);

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground">Project</label>
        <Select
          value={selectedProjectId ? String(selectedProjectId) : ""}
          onValueChange={(v) => setSelectedProjectId(Number(v))}
        >
          <SelectTrigger className="h-9"><SelectValue placeholder="Select project..." /></SelectTrigger>
          <SelectContent>
            {projectsWithIds.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedProjectId && (
        <>
          <JiraConfigForm
            projectId={selectedProjectId}
            existing={selectedConfig ? { baseUrl: selectedConfig.baseUrl, email: selectedConfig.email, hasToken: selectedConfig.hasToken } : null}
          />
          {selectedConfig && (
            <>
              <Separator />
              <JiraWatcherList configId={selectedConfig.id} />
            </>
          )}
        </>
      )}
    </div>
  );
}
