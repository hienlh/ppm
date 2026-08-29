import { useState, useCallback } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/chat/model-selector";
import { createGroup, type CreateMemberInput } from "@/lib/api-group-chat";
import { randomId } from "@/lib/utils";
import type { Group } from "../../../types/group-chat";

interface GroupCreateDialogProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  projectPath: string;
  providerId?: string;
  onCreated: (group: Group) => void;
}

interface DraftMember {
  key: string;
  name: string;
  persona: string;
  model: string | null;
}

const PALETTE = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444"];

function newMember(): DraftMember {
  return { key: randomId(), name: "", persona: "", model: null };
}

export function GroupCreateDialog({
  open, onClose, projectName, projectPath, providerId = "claude", onCreated,
}: GroupCreateDialogProps) {
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [cap, setCap] = useState(10); // reply-burst cap (max AI turns per message)
  const [leaderName, setLeaderName] = useState("Leader");
  const [leaderPersona, setLeaderPersona] = useState("");
  const [leaderModel, setLeaderModel] = useState<string | null>(null);
  const [members, setMembers] = useState<DraftMember[]>([newMember()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName(""); setCap(10); setLeaderName("Leader"); setLeaderPersona(""); setLeaderModel(null);
    setMembers([newMember()]); setError(null); setSubmitting(false);
  }, []);

  const close = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const updateMember = (key: string, patch: Partial<DraftMember>) =>
    setMembers((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));

  const handleSubmit = useCallback(async () => {
    const gName = name.trim();
    if (!gName) { setError("Group name is required"); return; }
    if (!leaderName.trim()) { setError("Leader name is required"); return; }
    const namedMembers = members.filter((m) => m.name.trim());
    if (namedMembers.length === 0) { setError("Add at least one member"); return; }

    const roster: CreateMemberInput[] = [
      {
        role: "leader",
        name: leaderName.trim(),
        persona: leaderPersona.trim() || null,
        model: leaderModel,
        color: PALETTE[0],
      },
      ...namedMembers.map((m, i) => ({
        role: "member" as const,
        name: m.name.trim(),
        persona: m.persona.trim() || null,
        model: m.model,
        color: PALETTE[(i + 1) % PALETTE.length],
      })),
    ];

    setSubmitting(true);
    setError(null);
    try {
      const group = await createGroup({ projectName, projectPath, name: gName, maxTurns: cap, members: roster });
      onCreated(group);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create group");
      setSubmitting(false);
    }
  }, [name, cap, leaderName, leaderPersona, leaderModel, members, projectName, projectPath, onCreated, close]);

  const inputCls =
    "w-full min-h-[40px] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary";

  const form = (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-1">
      <div>
        <label className="mb-1 block text-xs font-medium text-text-secondary">Group name</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Design Review" autoFocus />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-text-secondary">Reply cap (max AI turns per message, 1–50)</label>
        <input type="number" min={1} max={50} className={inputCls} value={cap}
          onChange={(e) => setCap(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
      </div>

      <div className="rounded-lg border border-border p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">Leader</p>
        <div className="flex flex-col gap-2">
          <input className={inputCls} value={leaderName} onChange={(e) => setLeaderName(e.target.value)}
            placeholder="Leader name" />
          <input className={inputCls} value={leaderPersona} onChange={(e) => setLeaderPersona(e.target.value)}
            placeholder="Persona (optional)" />
          <ModelSelector value={leaderModel} onChange={setLeaderModel}
            projectName={projectName} providerId={providerId} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Members</p>
          <button type="button" onClick={() => setMembers((p) => [...p, newMember()])}
            className="inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-primary hover:underline">
            <Plus className="size-3.5" /> Add
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {members.map((m, idx) => (
            <div key={m.key} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] text-text-subtle">Member {idx + 1}</span>
                {members.length > 1 && (
                  <button type="button" onClick={() => setMembers((p) => p.filter((x) => x.key !== m.key))}
                    className="flex size-8 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-destructive"
                    aria-label="Remove member">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <input className={inputCls} value={m.name}
                  onChange={(e) => updateMember(m.key, { name: e.target.value })} placeholder="Member name" />
                <input className={inputCls} value={m.persona}
                  onChange={(e) => updateMember(m.key, { persona: e.target.value })} placeholder="Persona (optional)" />
                <ModelSelector value={m.model} onChange={(v) => updateMember(m.key, { model: v })}
                  projectName={projectName} providerId={providerId} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={close} disabled={submitting}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting && <Loader2 className="mr-1.5 size-4 animate-spin" />}
          Create group
        </Button>
      </div>
    </div>
  );

  if (!open) return null;

  if (isMobile) {
    return (
      <BottomSheet open onClose={close} className="flex max-h-[90vh] flex-col">
        <div className="flex min-h-0 flex-col px-4 pb-2">
          <h2 className="mb-2 text-base font-semibold text-foreground">New group</h2>
          {form}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
