import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Palette, Smartphone } from "@/lib/icons";
import { ensureShowcaseDesign, designSystemStaleness } from "@/lib/design/api-design-systems";
import { openDesignTab } from "@/lib/design/open-design-tab";
import { designSystemStatusLabel } from "@/lib/design/design-system-status-label";
import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../../shared/design-types";

/**
 * Sidebar "Design systems" group: one row per app, its status, and the git-based stale
 * reminder. Fetched lazily per row (never blocks the designs list) and never automatic —
 * "Refresh" just reopens the same showcase tab, where the user runs the setup brief again.
 */

function SystemRow({ projectName, system, onNavigate }: {
  projectName: string; system: DesignSystemSummary; onNavigate?: () => void;
}) {
  const [stale, setStale] = useState<DesignSystemStaleInfo | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!system.builtFrom) return;
    designSystemStaleness(projectName, system.id)
      .then((info) => { if (!cancelled) setStale(info); })
      .catch(() => { /* the row still shows "Ready"; this is an optional refinement */ });
    return () => { cancelled = true; };
  }, [projectName, system.id, system.builtFrom?.commit]);

  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const showcase = await ensureShowcaseDesign(projectName, system.id);
      openDesignTab({ projectName, slug: showcase.slug, title: showcase.title });
      onNavigate?.();
    } catch (e) {
      toast.error("Could not open the showcase", { description: (e as Error).message });
    } finally {
      setOpening(false);
    }
  };

  return (
    <button type="button" onClick={() => void open()} disabled={opening}
      className="flex w-full min-h-11 select-none items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-elevated disabled:opacity-60 md:min-h-9">
      {opening ? <Loader2 className="size-4 shrink-0 animate-spin text-text-subtle" />
        : system.platform === "mobile" ? <Smartphone className="size-4 shrink-0 text-text-subtle" />
        : <Palette className="size-4 shrink-0 text-text-subtle" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-secondary">{system.label}</span>
        <span className="block truncate text-xs text-text-subtle">{designSystemStatusLabel(system, stale)}</span>
      </span>
    </button>
  );
}

export function DesignSystemsSidebarGroup({ projectName, systems, onNavigate }: {
  projectName: string; systems: DesignSystemSummary[]; onNavigate?: () => void;
}) {
  if (systems.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">Design systems</p>
      {systems.map((s) => <SystemRow key={s.id} projectName={projectName} system={s} onNavigate={onNavigate} />)}
    </div>
  );
}
