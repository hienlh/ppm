import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  createAiResource, duplicateAiResource,
  type AiResourceType, type CreatableScope, type AiResourceItem,
} from "@/lib/api-ai-resources";

interface CreateResourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "duplicate";
  /** Source item when duplicating. */
  source?: AiResourceItem | null;
  /** Preselected type when creating (from the New menu). */
  initialType?: AiResourceType;
  project: string;
  hasProject: boolean;
  onSuccess: (filePath: string) => void;
}

export function CreateResourceDialog({
  open, onOpenChange, mode, source, initialType, project, hasProject, onSuccess,
}: CreateResourceDialogProps) {
  const [type, setType] = useState<AiResourceType>("skill");
  const [scope, setScope] = useState<CreatableScope>(hasProject ? "project" : "user");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType(mode === "duplicate" && source ? source.type : (initialType ?? "skill"));
    setName(mode === "duplicate" && source ? `${source.name}-copy` : "");
    setScope(hasProject ? "project" : "user");
    setBusy(false);
  }, [open, mode, source, initialType, hasProject]);

  const nameValid = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);

  async function submit() {
    if (!nameValid || busy) return;
    setBusy(true);
    try {
      const res =
        mode === "duplicate" && source
          ? await duplicateAiResource(source.filePath, type, scope, name, project)
          : await createAiResource(type, scope, name, project);
      toast.success(mode === "duplicate" ? "Resource duplicated" : "Resource created");
      onOpenChange(false);
      onSuccess(res.filePath);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "duplicate" ? "Duplicate resource" : "New resource"}</DialogTitle>
          <DialogDescription>
            {mode === "duplicate"
              ? "Copy this resource into a writable scope under a new name."
              : "Create a new skill, agent, or command from a template."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as AiResourceType)} disabled={mode === "duplicate"}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="skill">Skill</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="command">Command</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as CreatableScope)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="project" disabled={!hasProject}>
                  Project{hasProject ? "" : " (no project selected)"}
                </SelectItem>
                <SelectItem value="user">User (~/.claude)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              autoFocus
              placeholder="my-resource"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
            {name && !nameValid && (
              <p className="text-[11px] text-destructive">
                Use letters, numbers, dots, dashes, underscores (no spaces or slashes).
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!nameValid || busy}>
            {busy ? "Working…" : mode === "duplicate" ? "Duplicate" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
