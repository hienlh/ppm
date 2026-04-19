import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useJiraStore } from "@/stores/jira-store";
import { JiraFilterBuilder } from "./jira-filter-builder";
import { Loader2, Search } from "lucide-react";
import type { JiraWatcher, JiraWatcherMode, JiraIssue } from "../../../../src/types/jira";

const INTERVALS = [
  { label: "30s", value: 30000 }, { label: "1m", value: 60000 },
  { label: "2m", value: 120000 }, { label: "5m", value: 300000 },
  { label: "10m", value: 600000 }, { label: "30m", value: 1800000 },
  { label: "1h", value: 3600000 },
];

interface Props {
  configId: number;
  existing?: JiraWatcher;
  onDone: () => void;
}

export function JiraWatcherForm({ configId, existing, onDone }: Props) {
  const { createWatcher, updateWatcher, testJql } = useJiraStore();
  const [name, setName] = useState(existing?.name ?? "");
  const [jql, setJql] = useState(existing?.jql ?? "");
  const [intervalMs, setIntervalMs] = useState(existing?.intervalMs ?? 120000);
  const [mode, setMode] = useState<JiraWatcherMode>(existing?.mode ?? "debug");
  const [prompt, setPrompt] = useState(existing?.promptTemplate ?? "");
  const [saving, setSaving] = useState(false);

  // Test JQL state
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<JiraIssue[] | null>(null);
  const [testTotal, setTestTotal] = useState(0);
  const [testError, setTestError] = useState<string | null>(null);

  const isEdit = !!existing;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !jql) return;
    setSaving(true);
    try {
      if (isEdit) {
        await updateWatcher(existing.id, {
          name, jql, intervalMs, mode,
          promptTemplate: prompt || null,
        });
      } else {
        await createWatcher({ configId, name, jql, intervalMs, mode, promptTemplate: prompt || undefined });
      }
      onDone();
    } catch {}
    setSaving(false);
  };

  const handleTestJql = async () => {
    if (!jql) return;
    setTesting(true);
    setTestError(null);
    setTestResults(null);
    try {
      const res = await testJql(configId, jql);
      setTestResults(res.issues);
      setTestTotal(res.total);
    } catch (e: any) {
      setTestError(e.message ?? "Test failed");
    }
    setTesting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 min-w-0">
      <div>
        <label className="text-xs text-muted-foreground">Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bug watcher" className="h-9" />
      </div>
      <JiraFilterBuilder value={jql} onChange={setJql} configId={configId} />

      {/* Test JQL button */}
      <Button
        type="button" size="sm" variant="outline"
        className="w-full min-h-[44px]"
        disabled={!jql || testing}
        onClick={handleTestJql}
      >
        {testing ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <Search className="size-4 mr-1.5" />}
        Test Filter
      </Button>

      {/* Test results preview */}
      {testError && (
        <p className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">{testError}</p>
      )}
      {testResults && (
        <div className="border rounded-md max-h-48 overflow-hidden">
          <div className="px-3 py-1.5 border-b bg-muted/50 text-xs text-muted-foreground font-medium">
            {testTotal} ticket{testTotal !== 1 ? "s" : ""} found
            {testTotal > testResults.length && ` (showing ${testResults.length})`}
          </div>
          <div className="overflow-y-auto max-h-[calc(12rem-30px)]">
            {testResults.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No tickets match this filter.</p>
            ) : (
              testResults.map((issue) => (
                <div key={issue.key} className="flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 text-xs min-w-0">
                  <span className="font-mono font-medium shrink-0">{issue.key}</span>
                  <span className="truncate text-muted-foreground flex-1 min-w-0">{issue.fields.summary}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground px-1.5 py-0.5 bg-muted rounded whitespace-nowrap">
                    {issue.fields.status.name}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">Interval</label>
          <Select value={String(intervalMs)} onValueChange={(v) => setIntervalMs(Number(v))}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {INTERVALS.map((i) => <SelectItem key={i.value} value={String(i.value)}>{i.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">Mode</label>
          <Select value={mode} onValueChange={(v) => setMode(v as JiraWatcherMode)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="debug">Debug + Notify</SelectItem>
              <SelectItem value="notify">Notify only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Prompt template (optional)</label>
        <textarea
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          className="w-full h-16 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Debug Jira issue {issue_key}: {summary}"
        />
      </div>
      <Button type="submit" size="sm" disabled={saving || !name || !jql} className="min-h-[44px] w-full">
        {saving ? <Loader2 className="size-4 animate-spin" /> : isEdit ? "Save Changes" : "Create Watcher"}
      </Button>
    </form>
  );
}
