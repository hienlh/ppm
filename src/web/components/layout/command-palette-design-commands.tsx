import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Palette, Plus } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";
import { listDesigns } from "@/lib/design/api-designs";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { NEW_DESIGN_EVENT, requestNewDesign, type NewDesignRequest } from "@/lib/design/design-ui-events";
import type { CommandItem } from "./command-palette";
import type { DesignSummary } from "../../../shared/design-types";

// Lazy: the dialog (and the design API it pulls in) loads the first time it is asked for.
const NewDesignDialog = lazy(() =>
  import("@/components/design/dialogs/new-design-dialog").then((m) => ({ default: m.NewDesignDialog })));

/**
 * The palette's design entries: New Design, the Designs section, and one "Open Design" per
 * design of the active project (listed each time the palette opens, so a design an agent
 * just created is there).
 */
export function useDesignCommands(projectName: string | null, open: boolean, onClose: () => void): CommandItem[] {
  const [designs, setDesigns] = useState<DesignSummary[]>([]);

  useEffect(() => {
    if (!open || !projectName) { setDesigns([]); return; }
    let cancelled = false;
    listDesigns(projectName)
      .then((d) => { if (!cancelled) setDesigns(d.designs); })
      .catch(() => { if (!cancelled) setDesigns([]); }); // the palette works without them
    return () => { cancelled = true; };
  }, [open, projectName]);

  return useMemo(() => {
    if (!projectName) return [];
    const showSection = () => {
      const settings = useSettingsStore.getState();
      if (settings.sidebarCollapsed) settings.toggleSidebar();
      settings.setSidebarActiveTab("designs");
      onClose();
    };
    return [
      {
        id: "new-design", label: "New Design…", icon: Plus, group: "action" as const,
        keywords: "design mockup prototype page slides deck presentation canvas create",
        action: () => { onClose(); requestNewDesign(projectName); },
      },
      { id: "designs", label: "Designs", icon: Palette, group: "action" as const, keywords: "design list canvas", action: showSection },
      ...designs.map((d) => ({
        id: `design:${d.slug}`, label: `Open Design: ${d.title}`, hint: `designs/${d.slug}`, icon: Palette,
        group: "action" as const, keywords: `design ${d.slug} ${d.kind}`,
        action: () => { openDesignTab({ projectName, slug: d.slug, title: d.title }); onClose(); },
      })),
    ];
  }, [projectName, designs, onClose]);
}

/**
 * Hosts the New Design dialog for the whole app. Lives beside the palette because the
 * palette is mounted on every layout, which neither sidebar nor drawer is.
 */
export function NewDesignDialogHost() {
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    const onRequest = (e: Event) => {
      const name = (e as CustomEvent<NewDesignRequest>).detail?.projectName;
      if (name) setProjectName(name);
    };
    window.addEventListener(NEW_DESIGN_EVENT, onRequest);
    return () => window.removeEventListener(NEW_DESIGN_EVENT, onRequest);
  }, []);
  if (!projectName) return null;
  return (
    <Suspense fallback={null}>
      <NewDesignDialog projectName={projectName} onClose={() => setProjectName(null)} />
    </Suspense>
  );
}
