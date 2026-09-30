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
import { runCanvasCheck, type CanvasCheckContext } from "../canvas/use-design-canvas-check";

/**
 * The Export menu's state and actions, plus "Build in new chat".
 *
 * The print and standalone views open in a new tab, and a tab opened after an `await` is
 * eaten by popup blockers. Their tokens are therefore minted when the menu opens (`prepare`),
 * so the menu can render them as plain links the user clicks. A token lives 10 minutes and
 * cannot be refreshed, so one older than {@link VIEW_REMINT_MS} is minted again on reopen.
 *
 * "Build in new chat" reuses the same self-check screenshot the `design_check` tool asks
 * for (`runCanvasCheck`): a failure there (canvas loading, the screenshot library not
 * loading) is not fatal — the brief still opens, just without the image, with a toast saying so.
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
  buildInNewChat: () => void;
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

/** `file` is the variant on screen: the views, the HTML download and the hand-off are of it. */
export function useDesignExport(
  tab: DesignTabContextValue, bridge: DesignBridge, file: string, checkContext: () => CanvasCheckContext,
): DesignExportFeature {
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

  // Another design, project or variant means other views.
  const viewsFor = useRef(file);
  viewsFor.current = file;
  useEffect(() => {
    mintedAt.current = 0;
    setViews({ print: null, standalone: null });
  }, [projectName, slug, file]);

  const prepare = useCallback(() => {
    if (minting.current || Date.now() - mintedAt.current < VIEW_REMINT_MS) return;
    minting.current = true;
    setViews({ print: null, standalone: null });
    setViewError(null);
    Promise.all([mintDesignView(projectName, slug, "print", file), mintDesignView(projectName, slug, "standalone", file)])
      .then(([print, standalone]) => {
        // A switch while minting: these views show the variant that is no longer on screen.
        if (!alive.current || viewsFor.current !== file) return;
        mintedAt.current = Date.now();
        setViews({ print: print.url, standalone: standalone.url });
      })
      .catch((e: unknown) => { if (alive.current) setViewError((e as Error).message || "Could not prepare the views"); })
      .finally(() => { minting.current = false; });
  }, [projectName, slug, file]);

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
    // The zip is the whole folder, every variant included; the single HTML file is one page.
    const out = await fetchDesignExport(projectName, slug, kind, kind === "html" ? file : undefined);
    saveBlobAsFile(out.blob, out.filename);
    if (out.warningCount > 0) {
      setWarnings({ title: `${out.warningCount} item${out.warningCount === 1 ? "" : "s"} left linked`, items: out.warnings });
    } else {
      toast.success(`Saved ${out.filename}`);
    }
  }), [run, projectName, slug, file]);

  const exportPptx = useCallback(() => run("pptx", async () => {
    const doc = await extractSlides(bridge);
    const { exportSlidesToPptx } = await import("./pptx-export");
    const notes = await exportSlidesToPptx(doc, { fileName: `${slug}.pptx`, title: design.title });
    if (notes.length) setWarnings({ title: "PowerPoint approximations", items: notes });
    else toast.success(`Saved ${slug}.pptx`);
  }), [run, bridge, slug, design.title]);

  const buildInNewChat = useCallback(() => {
    const text = buildHandoffPrompt({ slug, title: design.title, kind: design.kind, entry: file });
    // A missing screenshot must never block the brief itself: catch turns any failure
    // (canvas still loading, the screenshot library not loading) into "no image".
    runCanvasCheck(bridge, checkContext(), { screenshot: true })
      .then((report) => report.screenshot?.dataUrl)
      .catch(() => undefined)
      .then((dataUrl) => {
        try {
          sendToChat({
            text, projectName, newTab: true,
            ...(dataUrl ? { imageDataUrl: dataUrl, imageName: `${slug}-${file.replace(/\.html?$/i, "")}.jpg` } : {}),
          });
          if (!dataUrl) toast.info("Opened without a screenshot", { description: "The canvas could not be captured just now." });
        } catch (e) {
          toast.error("Could not start the new chat", { description: (e as Error).message });
        }
      });
  }, [bridge, checkContext, slug, design.title, design.kind, file, projectName]);

  return useMemo(() => ({
    views, viewError, busy, canPptx: design.kind === "slides", sheetOpen, setSheetOpen, prepare,
    downloadZip: () => void download("zip"), downloadHtml: () => void download("html"),
    exportPptx: () => void exportPptx(), buildInNewChat, warnings, dismissWarnings: () => setWarnings(null),
  }), [views, viewError, busy, design.kind, sheetOpen, prepare, download, exportPptx, buildInNewChat, warnings]);
}
