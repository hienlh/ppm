import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { ExternalLink, Loader2 } from "lucide-react";
import type { JiraIssue, JiraTransition } from "../../../../src/types/jira";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: number;
  issueKey: string;
  baseUrl?: string;
}

export function JiraTicketDetail({ open, onOpenChange, configId, issueKey, baseUrl }: Props) {
  const [issue, setIssue] = useState<JiraIssue | null>(null);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editSummary, setEditSummary] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!open || !issueKey) return;
    setLoading(true);
    Promise.all([
      api.get<JiraIssue>(`/api/jira/ticket/${configId}/${issueKey}`),
      api.get<JiraTransition[]>(`/api/jira/ticket/${configId}/${issueKey}/transitions`),
    ]).then(([iss, trans]) => {
      setIssue(iss);
      setEditSummary(iss.fields.summary);
      setTransitions(trans);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [open, issueKey, configId]);

  const handleSaveSummary = async () => {
    if (!issue || editSummary === issue.fields.summary) { setEditing(false); return; }
    setSaving(true);
    try {
      await api.put(`/api/jira/ticket/${configId}/${issueKey}`, { fields: { summary: editSummary } });
      setIssue({ ...issue, fields: { ...issue.fields, summary: editSummary } });
      setEditing(false);
    } catch {}
    setSaving(false);
  };

  const handleTransition = async (transitionId: string) => {
    setSaving(true);
    try {
      await api.post(`/api/jira/ticket/${configId}/${issueKey}/transition`, { transitionId });
      // Refresh issue
      const iss = await api.get<JiraIssue>(`/api/jira/ticket/${configId}/${issueKey}`);
      setIssue(iss);
    } catch {}
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {issueKey}
            {baseUrl && (
              <a href={`${baseUrl}/browse/${issueKey}`} target="_blank" rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground">
                <ExternalLink className="size-4" />
              </a>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="size-6 animate-spin" /></div>
        ) : issue ? (
          <div className="space-y-3 text-sm">
            {/* Summary */}
            <div>
              <label className="text-xs text-muted-foreground">Summary</label>
              {editing ? (
                <div className="flex gap-1">
                  <Input value={editSummary} onChange={(e) => setEditSummary(e.target.value)} className="h-8 text-sm" />
                  <Button size="sm" onClick={handleSaveSummary} disabled={saving} className="h-8">
                    {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
                  </Button>
                </div>
              ) : (
                <p className="cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5" onClick={() => setEditing(true)}>
                  {issue.fields.summary}
                </p>
              )}
            </div>

            {/* Status + transition */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground">Status</label>
                <p className="font-medium">{issue.fields.status.name}</p>
              </div>
              {transitions.length > 0 && (
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Transition to</label>
                  <Select onValueChange={handleTransition} disabled={saving}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Change status..." /></SelectTrigger>
                    <SelectContent>
                      {transitions.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name} → {t.to.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Priority & Assignee */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground">Priority</label>
                <p>{issue.fields.priority?.name ?? "None"}</p>
              </div>
              <div className="flex-1">
                <label className="text-xs text-muted-foreground">Assignee</label>
                <p>{issue.fields.assignee?.displayName ?? "Unassigned"}</p>
              </div>
            </div>

            {/* Description */}
            {issue.fields.description && (
              <div>
                <label className="text-xs text-muted-foreground">Description</label>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted/30 rounded p-2 max-h-40 overflow-y-auto">
                  {typeof issue.fields.description === "string"
                    ? issue.fields.description
                    : JSON.stringify(issue.fields.description, null, 2)}
                </p>
              </div>
            )}

            {/* Timestamps */}
            <div className="text-xs text-muted-foreground">
              Updated: {new Date(issue.fields.updated).toLocaleString()}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">Failed to load issue.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
