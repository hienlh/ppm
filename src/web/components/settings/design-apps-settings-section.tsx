import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Palette, Pencil, Plus, Smartphone, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { listDesignSystems, designSystemStaleness } from "@/lib/design/api-design-systems";
import { designSystemStatusLabel } from "@/lib/design/design-system-status-label";
import { announceDesignsChanged } from "@/lib/design/design-ui-events";
import { DesignAppFormDialog } from "./design-app-form-dialog";
import { DesignAppRemoveDialog } from "./design-app-remove-dialog";
import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../../shared/design-types";

/** One row's status text, fetched lazily so the list itself never waits on a git diff. */
function AppRow({ projectName, system, onEdit, onRemove }: {
  projectName: string; system: DesignSystemSummary; onEdit: () => void; onRemove: () => void;
}) {
  const [stale, setStale] = useState<DesignSystemStaleInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!system.builtFrom) return;
    designSystemStaleness(projectName, system.id).then((info) => { if (!cancelled) setStale(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectName, system.id, system.builtFrom?.commit]);

  return (
    <div className="flex items-center gap-2 rounded-md border border-border p-2">
      {system.platform === "mobile" ? <Smartphone className="size-4 shrink-0 text-text-subtle" /> : <Palette className="size-4 shrink-0 text-text-subtle" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-secondary">{system.label}</p>
        <p className="truncate text-xs text-text-subtle">
          {system.root === "." ? "Project root" : system.root} · {designSystemStatusLabel(system, stale)}
        </p>
      </div>
      <button type="button" onClick={onEdit} aria-label={`Edit ${system.label}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground md:size-8">
        <Pencil className="size-4" />
      </button>
      {system.id !== "default" && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${system.label}`}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-destructive md:size-8">
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Settings → Design's "Apps in this project": declare, edit and remove the design systems
 * of the active project (one for a normal repo, several for a container of separate
 * frontends). No auto-detection — every app here was typed in by the user.
 */
export function DesignAppsSettingsSection({ projectName }: { projectName: string }) {
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DesignSystemSummary | null | "new">(null);
  const [removing, setRemoving] = useState<DesignSystemSummary | null>(null);

  const load = useCallback(() => {
    listDesignSystems(projectName)
      .then((list) => { setSystems(list); setError(null); })
      .catch((e) => setError((e as Error).message || "Could not load this project's apps"));
  }, [projectName]);

  useEffect(() => { setSystems(null); load(); }, [projectName, load]);

  const refreshed = () => {
    setEditing(null);
    setRemoving(null);
    load();
    announceDesignsChanged(projectName);
    toast.success("Saved");
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Apps in this project</p>
        <Button size="sm" variant="outline" className="min-h-9 gap-1 text-xs" onClick={() => setEditing("new")}>
          <Plus className="size-3.5" /> Add app
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-text-subtle">
        One design system per app — a separate frontend in a monorepo, or a mobile app. A
        project with none declared uses one default app at its own root.
      </p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      ) : systems === null ? (
        <div className="flex justify-center py-4"><Loader2 className="size-4 animate-spin text-primary" /></div>
      ) : (
        <div className="space-y-2">
          {systems.map((s) => (
            <AppRow key={s.id} projectName={projectName} system={s}
              onEdit={() => setEditing(s)} onRemove={() => setRemoving(s)} />
          ))}
        </div>
      )}
      {editing && (
        <DesignAppFormDialog projectName={projectName} editing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)} onSaved={refreshed} />
      )}
      {removing && (
        <DesignAppRemoveDialog projectName={projectName} system={removing}
          onClose={() => setRemoving(null)} onRemoved={refreshed} />
      )}
    </div>
  );
}
