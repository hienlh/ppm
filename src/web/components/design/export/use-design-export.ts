import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { sendToChat } from "@/lib/send-to-chat";
import { buildHandoffPrompt } from "@/lib/design/design-handoff-prompt";
import {
  fetchDesignExport, mintDesignView, saveBlobAsFile, type DesignViewPurpose,
} from "@/lib/design/design-export-client";
import type { SlideDoc } from "../../../../shared/design-slide-doc";
import type { DesignTabContextValue } from "../design-tab-context";
import { newBridgeNonce, type DesignBridge } from "../canvas/use-design-bridge";

/**
 * The Export menu's state and actions, plus "Hand off to code".
 *
 * The print and standalone views open in a new tab, and a tab opened after an `await` is
 * eaten by popup blockers. Their tokens are therefore minted when the menu opens (`prepare`),
 * so the menu can render them as plain links the user clicks. A token lives 10 minutes and
 * cannot be refreshed, so one older than {@link VIEW_REMINT_MS} is minted again on reopen.
 */

export type DesignExportJob = "zip" | "html" | "pptx";

export interface DesignExportWarnings {
  title: string;
  items: string[];
}

export interface DesignExportFeature {
  views: Record<DesignViewPurpose, string | null>;
  viewError: string | null;
  busy: DesignExportJob | null;
  canPptx: boolean;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  prepare: () => void;
  downloadZip: () => void;
  downloadHtml: () => void;
  exportPptx: () => void;
  handOff: () => void;
  warnings: DesignExportWarnings | null;
  dismissWarnings: () => void;
}

export const VIEW_REMINT_MS = 8 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 60_000;

/** Ask the bridge to measure the deck; resolves with its answer to this request only. */
function extractSlides(bridge: DesignBridge): Promise<SlideDoc> {
  return new Promise((resolve, reject) => {
    const requestId = newBridgeNonce();
    const cleanup = (): void => { offData(); offError(); clearTimeout(timer); };
    const offData = bridge.on("slides-data", (m) => { if (m.requestId === requestId) { cleanup(); resolve(m.doc); } });
    const offError = bridge.on("slides-error", (m) => { if (m.requestId === requestId) { cleanup(); reject(new Error(m.message)); } });
    const timer = setTimeout(() => { cleanup(); reject(new Error("The canvas did not answer in time")); }, EXTRACT_TIMEOUT_MS);
    if (!bridge.ready || !bridge.send({ type: "slides-extract", requestId })) {
      cleanup();
      reject(new Error("The canvas is still loading; try again in a moment"));
    }
  });
}

export function useDesignExport(tab: DesignTabContextValue, bridge: DesignBridge): DesignExportFeature {
  const { projectName, slug, design } = tab;
  const [views, setViews] = useState<Record<DesignViewPurpose, string | null>>({ print: null, standalone: null });
  const [viewError, setViewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<DesignExportJob | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [warnings, setWarnings] = useState<DesignExportWarnings | null>(null);
  const mintedAt = useRef(0);
  const minting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Another design (or project) means other tokens.
  useEffect(() => {
    mintedAt.current = 0;
    setViews({ print: null, standalone: null });
  }, [projectName, slug]);

  const prepare = useCallback(() => {
    if (minting.current || Date.now() - mintedAt.current < VIEW_REMINT_MS) return;
    minting.current = true;
    setViews({ print: null, standalone: null });
    setViewError(null);
    Promise.all([mintDesignView(projectName, slug, "print"), mintDesignView(projectName, slug, "standalone")])
      .then(([print, standalone]) => {
        if (!alive.current) return;
        mintedAt.current = Date.now();
        setViews({ print: print.url, standalone: standalone.url });
      })
      .catch((e: unknown) => { if (alive.current) setViewError((e as Error).message || "Could not prepare the views"); })
      .finally(() => { minting.current = false; });
  }, [projectName, slug]);

  const run = useCallback(async (job: DesignExportJob, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(job);
    try {
      await work();
    } catch (e) {
      toast.error("Export failed", { description: (e as Error).message });
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [busy]);

  const download = useCallback((kind: "zip" | "html") => run(kind, async () => {
    const file = await fetchDesignExport(projectName, slug, kind);
    saveBlobAsFile(file.blob, file.filename);
    if (file.warningCount > 0) {
      setWarnings({ title: `${file.warningCount} item${file.warningCount === 1 ? "" : "s"} left linked`, items: file.warnings });
    } else {
      toast.success(`Saved ${file.filename}`);
    }
  }), [run, projectName, slug]);

  const exportPptx = useCallback(() => run("pptx", async () => {
    const doc = await extractSlides(bridge);
    const { exportSlidesToPptx } = await import("./pptx-export");
    const notes = await exportSlidesToPptx(doc, { fileName: `${slug}.pptx`, title: design.title });
    if (notes.length) setWarnings({ title: "PowerPoint approximations", items: notes });
    else toast.success(`Saved ${slug}.pptx`);
  }), [run, bridge, slug, design.title]);

  const handOff = useCallback(() => {
    try {
      sendToChat({
        text: buildHandoffPrompt({ slug, title: design.title, kind: design.kind, entry: design.entry }),
        projectName,
        newTab: true,
      });
    } catch (e) {
      toast.error("Could not start the hand-off", { description: (e as Error).message });
    }
  }, [slug, design.title, design.kind, design.entry, projectName]);

  return useMemo(() => ({
    views, viewError, busy, canPptx: design.kind === "slides", sheetOpen, setSheetOpen, prepare,
    downloadZip: () => void download("zip"), downloadHtml: () => void download("html"),
    exportPptx: () => void exportPptx(), handOff, warnings, dismissWarnings: () => setWarnings(null),
  }), [views, viewError, busy, design.kind, sheetOpen, prepare, download, exportPptx, handOff, warnings]);
}
