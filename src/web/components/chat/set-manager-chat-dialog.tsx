/**
 * "Set as manager chat": says what the role means before it is given — PPM Assistant may message
 * the chat without asking, also while the user is away, and in bypass mode nothing in it asks
 * either — and, when the project already has a manager, which chat it replaces. A dialog on a
 * desktop, a bottom sheet on a phone.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "@/lib/icons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { api } from "@/lib/api-client";
import {
  MANAGER_ASSIGN_BYPASS, MANAGER_ASSIGN_CONSEQUENCE, MANAGER_TOOLS_NEXT_START, type ManagerAssignCheck,
} from "../../../shared/assistant-managers";

const TITLE = "Set as manager chat";

export function managersUrl(projectName: string): string {
  return `/api/assistant/managers/${encodeURIComponent(projectName)}`;
}

export function SetManagerChatDialog({ projectName, sessionId, sessionTitle, onClose }: {
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [check, setCheck] = useState<ManagerAssignCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<ManagerAssignCheck>(`${managersUrl(projectName)}/check?sessionId=${encodeURIComponent(sessionId)}`)
      .then((c) => { if (live) setCheck(c); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectName, sessionId]);

  const assign = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(managersUrl(projectName), { sessionId });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const body = (
    <div className="space-y-3 text-sm">
      <p className="text-text-primary">
        <span className="font-medium">{sessionTitle || "This chat"}</span> becomes the {projectName} manager: the chat PPM Assistant talks to about this project.
      </p>
      {!check && !error && <p className="flex items-center gap-2 text-text-subtle"><Loader2 className="size-3.5 animate-spin" /> Checking the chat…</p>}
      {check?.already && <p className="text-text-subtle">This chat already is the {projectName} manager.</p>}
      {check?.replaces && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-text-primary">
          This replaces the current manager, “{check.replaces.title || "Untitled"}”. That chat keeps its history.
        </p>
      )}
      {check && (
        <ul className="list-disc space-y-1 pl-5 text-text-secondary">
          <li>{MANAGER_ASSIGN_CONSEQUENCE}</li>
          {check.permissionMode === "bypassPermissions" && <li className="text-warning">{MANAGER_ASSIGN_BYPASS}</li>}
          <li>{MANAGER_TOOLS_NEXT_START}</li>
        </ul>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">
        <Button type="button" variant="outline" onClick={onClose} className="min-h-11 md:min-h-9">Cancel</Button>
        <Button type="button" onClick={assign} disabled={!check || check.already || saving} className="min-h-11 md:min-h-9">
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {check?.replaces ? "Replace manager" : TITLE}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose}>
        <div className="space-y-3 px-4 pb-4" role="dialog" aria-label={TITLE}>
          <h2 className="text-base font-semibold">{TITLE}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription className="sr-only">{MANAGER_ASSIGN_CONSEQUENCE}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
