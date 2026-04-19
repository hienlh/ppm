import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useJiraStore } from "@/stores/jira-store";
import type { JiraWatchResult } from "../../../../src/types/jira";

interface Props {
  result: JiraWatchResult | null;
  onClose: () => void;
}

export function JiraDebugPromptDialog({ result, onClose }: Props) {
  const { watchers, startDebug } = useJiraStore();
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (!result) return;
    const watcher = watchers.find((w) => w.id === result.watcherId);
    const template = watcher?.promptTemplate
      ?? `Debug Jira issue {issue_key}: {summary}`;
    setPrompt(
      template
        .replace(/\{issue_key\}/g, result.issueKey)
        .replace(/\{summary\}/g, result.issueSummary ?? ""),
    );
  }, [result, watchers]);

  const handleStart = async () => {
    if (!result) return;
    try {
      await startDebug(result.id, prompt);
    } catch {}
    onClose();
  };

  return (
    <Dialog open={!!result} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start Debug: {result?.issueKey}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{result?.issueSummary}</p>
        <div>
          <label className="text-xs text-muted-foreground">Debug Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none mt-1"
            placeholder="Debug Jira issue {issue_key}: {summary}"
          />
        </div>
        <Button size="sm" className="w-full min-h-[44px]" onClick={handleStart}>
          Start Debug Session
        </Button>
      </DialogContent>
    </Dialog>
  );
}
