import { useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/chat/model-selector";
import type { GroupMember, MemberRole } from "../../../types/group-chat";

export interface MemberFormValues {
  name: string;
  persona: string | null;
  model: string | null;
  role: MemberRole;
}

interface Props {
  open: boolean;
  /** Editing an existing member, or null when adding a new one. */
  member: GroupMember | null;
  projectName: string;
  providerId?: string;
  onSubmit: (values: MemberFormValues) => Promise<void>;
  onClose: () => void;
}

const inputCls =
  "w-full min-h-[40px] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary";

export function GroupMemberEditDialog({ open, member, projectName, providerId = "claude", onSubmit, onClose }: Props) {
  const isMobile = useIsMobile();
  const [name, setName] = useState(member?.name ?? "");
  const [persona, setPersona] = useState(member?.persona ?? "");
  const [model, setModel] = useState<string | null>(member?.model ?? null);
  const [isLeader, setIsLeader] = useState(member?.role === "leader");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    const n = name.trim();
    if (!n) { setError("Name is required"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ name: n, persona: persona.trim() || null, model, role: isLeader ? "leader" : "member" });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save member");
      setSubmitting(false);
    }
  }, [name, persona, model, isLeader, onSubmit, onClose]);

  const alreadyLeader = member?.role === "leader";

  const form = (
    <div className="flex flex-col gap-3 px-1 py-1">
      <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Member name" autoFocus />
      <input className={inputCls} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Persona (optional)" />
      <ModelSelector value={model} onChange={setModel} projectName={projectName} providerId={providerId} />
      <label className={cnLeader(alreadyLeader)}>
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-primary)]"
          checked={isLeader}
          disabled={alreadyLeader}
          onChange={(e) => setIsLeader(e.target.checked)}
        />
        <span>{alreadyLeader ? "Leader (reassign from another member)" : "Set as leader"}</span>
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting && <Loader2 className="mr-1.5 size-4 animate-spin" />}
          {member ? "Save" : "Add member"}
        </Button>
      </div>
    </div>
  );

  if (!open) return null;
  const title = member ? "Edit member" : "Add member";

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} className="flex max-h-[90vh] flex-col">
        <div className="flex min-h-0 flex-col px-4 pb-2">
          <h2 className="mb-2 text-base font-semibold text-foreground">{title}</h2>
          {form}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex flex-col sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}

/** Label styling for the leader checkbox row (dimmed when already leader). */
function cnLeader(disabled: boolean): string {
  return `flex items-center gap-2 text-sm text-text-secondary ${disabled ? "opacity-60" : ""}`;
}
