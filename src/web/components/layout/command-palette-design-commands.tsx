import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Palette, Plus } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";
import { listDesigns } from "@/lib/design/api-designs";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { DESIGNS_CHANGED_EVENT, NEW_DESIGN_EVENT, requestNewDesign, type NewDesignRequest } from "@/lib/design/design-ui-events";
import { publishCommandSource, type AppCommand } from "@/lib/commands/command-registry";
import type { DesignSummary } from "../../../shared/design-types";

// Lazy: the dialog (and the design API it pulls in) loads the first time it is asked for.
const NewDesignDialog = lazy(() =>
  import("@/components/design/dialogs/new-design-dialog").then((m) => ({ default: m.NewDesignDialog })));

/** A design's own folder or the files that name it; anything deeper is a design's content. */
const DESIGN_LIST_PATH = /^designs\/[^/]+(\/(design\.json|index\.html))?$/;

/**
 * The palette's design entries: New Design, the Designs section, and one "Open Design" per
 * design of the active project. Each opens a dialog, the sidebar or a tab, so none changes
 * data. The list is published to the command registry, which is how the PPM Assistant sees it
 * too — and the Assistant lists commands while the palette is closed, so the designs are
 * fetched for the project shown whether or not the palette is open (the palette is mounted
 * on every layout). They are fetched again each time the palette opens, when this client
 * changes a design, and when a design folder changes on disk (an agent made one).
 */
export function useDesignCommands(projectName: string | null, open: boolean): AppCommand[] {
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => { if (open) setRefresh((n) => n + 1); }, [open]);

  useEffect(() => {
    if (!projectName) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Debounced: a new design arrives as a burst of file events.
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => setRefresh((n) => n + 1), 500); };
    const onFile = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; path?: string }>).detail;
      if (d?.projectName === projectName && DESIGN_LIST_PATH.test(d.path ?? "")) later();
    };
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ projectName?: string }>).detail?.projectName === projectName) setRefresh((n) => n + 1);
    };
    window.addEventListener("file:changed", onFile);
    window.addEventListener(DESIGNS_CHANGED_EVENT, onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("file:changed", onFile);
      window.removeEventListener(DESIGNS_CHANGED_EVENT, onChanged);
    };
  }, [projectName]);

  // Cleared only when the project changes: a refetch keeps the list it is replacing, so a
  // command listed mid-refetch still finds the designs.
  useEffect(() => { setDesigns([]); }, [projectName]);

  useEffect(() => {
    if (!projectName) return;
    let cancelled = false;
    listDesigns(projectName)
      .then((d) => { if (!cancelled) setDesigns(d.designs); })
      .catch(() => {}); // the palette works without them, and a failed refetch keeps the last list
    return () => { cancelled = true; };
  }, [projectName, refresh]);

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
