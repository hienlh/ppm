import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { designSystemStaleness, getDesignSystem } from "@/lib/design/api-design-systems";
import { runDesignSystemSetup } from "@/lib/design/run-design-system-setup";
import { DESIGNS_CHANGED_EVENT } from "@/lib/design/design-ui-events";
import {
  designSystemBannerKey, designSystemBannerKind, parseDismissed, type DesignSystemBannerKind,
} from "@/lib/design/design-system-banner-state";
import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../../shared/design-types";
import { useDesignTab } from "./design-tab-context";

/**
 * A strip across the top of the design tab, above both the chat and the canvas, shown once
 * an app's design system may be outdated. Setting a system up in the first place is no
 * longer offered here or anywhere a user is asked: a design's own first turn does it itself
 * (`design-instructions.ts`). The canvas More menu keeps its "Set up design system" entry for
 * a manual re-run. "Later" hides this banner for that app on this device only.
 */

function readDismissed(key: string): DesignSystemBannerKind[] {
  try { return parseDismissed(localStorage.getItem(key)); } catch { return []; }
}

function writeDismissed(key: string, kinds: DesignSystemBannerKind[]): void {
  try { localStorage.setItem(key, JSON.stringify(kinds)); } catch { /* private mode: hides for this view only */ }
}

/** The app's system, refetched when its files or the designs list change, and after a turn. */
function useDesignSystemForTab(projectName: string, systemId: string, isStreaming: boolean) {
  const [system, setSystem] = useState<DesignSystemSummary | null>(null);
  const [stale, setStale] = useState<DesignSystemStaleInfo | null>(null);

  const load = useCallback(() => {
    getDesignSystem(projectName, systemId)
      .then((s) => {
        setSystem(s);
        if (!s.builtFrom) { setStale(null); return; }
        designSystemStaleness(projectName, systemId).then(setStale).catch(() => setStale(null));
      })
      // No banner rather than a wrong one: the menu entry still works.
      .catch(() => setSystem(null));
  }, [projectName, systemId]);

  // A setup turn that just finished is what turns "not set up" into "ready".
  useEffect(() => { if (!isStreaming) load(); }, [load, isStreaming]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(load, 500); };
    const onFile = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; path?: string }>).detail;
      if (d?.projectName !== projectName) return;
      const path = d.path ?? "";
      if (path.startsWith(`designs/systems/${systemId}/`) || path === "designs/DESIGN.md") later();
    };
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ projectName?: string }>).detail?.projectName === projectName) later();
    };
    window.addEventListener("file:changed", onFile);
    window.addEventListener(DESIGNS_CHANGED_EVENT, onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("file:changed", onFile);
      window.removeEventListener(DESIGNS_CHANGED_EVENT, onChanged);
    };
  }, [projectName, systemId, load]);

  return { system, stale };
}

export function DesignSystemSetupBanner() {
  const { projectName, design, isStreaming } = useDesignTab();
  const systemId = design.system;
  const { system, stale } = useDesignSystemForTab(projectName, systemId, isStreaming);
  const key = designSystemBannerKey(projectName, systemId);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  const [starting, setStarting] = useState(false);
  useEffect(() => { setDismissed(readDismissed(key)); }, [key]);

  const kind = designSystemBannerKind({ system, stale, dismissed, isStreaming: isStreaming || starting });
  if (!kind || !system) return null;

  const start = () => {
    setStarting(true);
    runDesignSystemSetup(projectName, systemId)
      .catch((e: Error) => toast.error("Could not start setup", { description: e.message }))
      .finally(() => setStarting(false));
  };
  const later = () => {
    const next = [...dismissed, kind];
    writeDismissed(key, next);
    setDismissed(next);
  };

  const message = `${system.label}'s design system may be outdated (${stale?.changedFiles ?? "several"} UI files changed since it was made).`;

  return (
    <div role="region" aria-label="Design system"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-primary/10 px-3 py-2">
      <Sparkles className="size-5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 basis-56 text-sm text-foreground">{message}</p>
      <div className="flex items-center gap-1">
        <Button onClick={start} disabled={starting} className="min-h-11 md:min-h-9">
          {starting && <Loader2 className="size-4 animate-spin" />}
          Refresh design system
        </Button>
        <button type="button" onClick={later} aria-label="Later" title="Later"
          className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground md:size-9">
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
