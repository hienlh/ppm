import { useCallback, useEffect, useState } from "react";
import { FileCode, Loader2, Palette, Pencil, Plus, Presentation, Trash2 } from "@/lib/icons";
import { useProjectStore } from "@/stores/project-store";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { formatRelativeDate } from "@/lib/format-date";
import { listDesigns, type DesignList } from "@/lib/design/api-designs";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { DESIGNS_CHANGED_EVENT, requestNewDesign } from "@/lib/design/design-ui-events";
import { RenameDesignDialog } from "./dialogs/rename-design-dialog";
import { DeleteDesignDialog } from "./dialogs/delete-design-dialog";
import type { DesignSummary } from "../../../shared/design-types";

/** Sidebar "Designs" section: the project's designs, newest first; tap to open. */
export function DesignsSidebarPanel({ onNavigate }: { onNavigate?: () => void }) {
  const projectName = useProjectStore((s) => s.activeProject?.name ?? "");
  const [data, setData] = useState<DesignList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DesignSummary | null>(null);
  const [deleting, setDeleting] = useState<DesignSummary | null>(null);

  const load = useCallback(() => {
    if (!projectName) return;
    listDesigns(projectName)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError((e as Error).message || "Could not load designs"));
  }, [projectName]);

  // Refetch after this client changes a design, and when design folders change on disk
  // (an agent, a git checkout). Debounced: a new design arrives as a burst of file events.
  useEffect(() => {
    setData(null);
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(load, 500); };
    const onFile = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; path?: string }>).detail;
      if (d?.projectName === projectName && /^designs\/[^/]+(\/(design\.json|index\.html))?$/.test(d.path ?? "")) later();
    };
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ projectName?: string }>).detail?.projectName === projectName) load();
    };
    window.addEventListener("file:changed", onFile);
    window.addEventListener(DESIGNS_CHANGED_EVENT, onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("file:changed", onFile);
      window.removeEventListener(DESIGNS_CHANGED_EVENT, onChanged);
    };
  }, [projectName, load]);

  const open = (d: DesignSummary) => {
    openDesignTab({ projectName, slug: d.slug, title: d.title });
    onNavigate?.();
  };

  if (!projectName) {
    return <p className="p-4 text-center text-xs text-text-subtle">Select a project to see its designs</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Designs</span>
        <button type="button" onClick={() => { requestNewDesign(projectName); onNavigate?.(); }} aria-label="New design"
          className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground md:size-7">
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? (
          <p className="px-2 py-3 text-xs text-destructive">{error}</p>
        ) : data === null ? (
          <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-primary" /></div>
        ) : data.designs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-text-subtle">
            <Palette className="size-6" />
            No designs yet. Start one and describe what you want; the AI builds it beside a live preview.
            <button type="button" onClick={() => requestNewDesign(projectName)} className="min-h-11 px-3 text-sm text-primary underline">
              New design
            </button>
          </div>
        ) : data.designs.map((d) => {
          const Icon = d.kind === "slides" ? Presentation : FileCode;
          return (
            <ContextMenu key={d.slug}>
              <ContextMenuTrigger asChild>
                <button type="button" onClick={() => open(d)}
                  className="flex w-full min-h-11 select-none items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-elevated md:min-h-9">
                  <Icon className="size-4 shrink-0 text-text-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-secondary">{d.title}</span>
                    <span className="block truncate text-xs text-text-subtle">{formatRelativeDate(d.updatedAt)}</span>
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => open(d)}><Palette className="size-4" /> Open</ContextMenuItem>
                <ContextMenuItem onClick={() => setRenaming(d)}><Pencil className="size-4" /> Rename</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => setDeleting(d)}><Trash2 className="size-4" /> Delete</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {data && !data.system.designMd && data.designs.length > 0 && (
          <p className="px-2 py-3 text-xs text-text-subtle">
            No design system yet. Open a design and choose “Set up design system” to learn this project's look.
          </p>
        )}
      </div>
      {renaming && <RenameDesignDialog projectName={projectName} design={renaming} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteDesignDialog projectName={projectName} design={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
