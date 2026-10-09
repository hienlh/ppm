import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Palette, Plus } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";
import { listDesigns } from "@/lib/design/api-designs";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { NEW_DESIGN_EVENT, requestNewDesign, type NewDesignRequest } from "@/lib/design/design-ui-events";
import { publishCommandSource, type AppCommand } from "@/lib/commands/command-registry";
import type { DesignSummary } from "../../../shared/design-types";

// Lazy: the dialog (and the design API it pulls in) loads the first time it is asked for.
const NewDesignDialog = lazy(() =>
  import("@/components/design/dialogs/new-design-dialog").then((m) => ({ default: m.NewDesignDialog })));

/**
 * The palette's design entries: New Design, the Designs section, and one "Open Design" per
 * design of the active project (listed each time the palette opens, so a design an agent
 * just created is there). Each opens a dialog, the sidebar or a tab, so none changes data. The
 * list is published to the command registry, which is how the PPM Assistant sees it too.
 */
export function useDesignCommands(projectName: string | null, open: boolean): AppCommand[] {
  const [designs, setDesigns] = useState<DesignSummary[]>([]);

  useEffect(() => {
    if (!open || !projectName) { setDesigns([]); return; }
    let cancelled = false;
    listDesigns(projectName)
      .then((d) => { if (!cancelled) setDesigns(d.designs); })
      .catch(() => { if (!cancelled) setDesigns([]); }); // the palette works without them
    return () => { cancelled = true; };
  }, [open, projectName]);

  const commands = useMemo<AppCommand[]>(() => {
    if (!projectName) return [];
    return [
      {
        id: "new-design", label: "New Design…", icon: Plus, changesData: false, closePaletteFirst: true,
        keywords: "design mockup prototype page slides deck presentation canvas create",
        run: () => requestNewDesign(projectName),
      },
      { id: "designs", label: "Designs", icon: Palette, keywords: "design list canvas", changesData: false, run: showDesignsSection },
      ...designs.map((d): AppCommand => ({
        id: `design:${d.slug}`, label: `Open Design: ${d.title}`, hint: `designs/${d.slug}`, icon: Palette,
        keywords: `design ${d.slug} ${d.kind}`, changesData: false,
        run: () => { openDesignTab({ projectName, slug: d.slug, title: d.title }); },
      })),
    ];
  }, [projectName, designs]);

  useEffect(() => publishCommandSource("design", commands), [commands]);
  return commands;
}

/** The sidebar's Designs section, expanding a collapsed sidebar. */
function showDesignsSection(): void {
  const settings = useSettingsStore.getState();
  if (settings.sidebarCollapsed) settings.toggleSidebar();
  settings.setSidebarActiveTab("designs");
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
