import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { Loader2 } from "@/lib/icons";
import { beginPreviewLoad, endPreviewLoads, finishPreviewLoad, previewKey } from "@/lib/html-preview-loads";
import { MAX_BRIDGE_ISSUES } from "../../../shared/design-bridge-protocol";
import { newBridgeNonce, useDesignBridge } from "../design/canvas/use-design-bridge";
import { runCanvasCheck } from "../design/canvas/use-design-canvas-check";
import type { CanvasIssue } from "../design/canvas/design-issues-badge";

/** A preview whose page went quiet (it followed a link, say) is left alone: Refresh brings it back. */
const ignoreDeadFrame = () => {};

/**
 * The server also enforces the sandbox, including when a preview URL is opened directly.
 *
 * Every load gets a fresh nonce (`?n=`) for the bridge the server puts in the page, which
 * reports the page's errors and failed loads here and answers the self-check that the AI's
 * `open_preview` tool asks for through `html-preview-loads.ts`.
 */
export function HtmlPreview({ filePath, projectName, revision }: {
  filePath: string;
  projectName?: string;
  revision: number;
}) {
  const [load, setLoad] = useState<{ url: string; nonce: string; seq: number }>();
  const [error, setError] = useState<string>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const issues = useRef<CanvasIssue[]>([]);
  const bridge = useDesignBridge(iframeRef, load?.nonce ?? null, ignoreDeadFrame);
  // The check runs long after the load that registered it; it must use the bridge as it is then.
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const key = previewKey(projectName, filePath);

  useEffect(() => {
    const controller = new AbortController();
    setLoad(undefined);
    setError(undefined);
    const timeout = setTimeout(() => controller.abort(new Error("Preview request timed out. Try Refresh.")), 30_000);
    let active = true;
    api.post<{ url: string }>("/api/html-preview", { filePath, projectName }, { signal: controller.signal })
      .then((data) => {
        if (!active) return;
        issues.current = [];
        const seq = beginPreviewLoad(key, (opts) =>
          runCanvasCheck(bridgeRef.current, { issues: issues.current, frame: opts.frame }, { screenshot: opts.screenshot }));
        setLoad({ url: data.url, nonce: newBridgeNonce(), seq });
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Could not open HTML preview"); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [filePath, projectName, revision, key]);

  useEffect(() => {
    if (!load) return;
    const { seq } = load;
    return () => endPreviewLoads(key, seq);
  }, [key, load]);

  useEffect(() => bridge.on("issue", (m) => {
    if (issues.current.length < MAX_BRIDGE_ISSUES) issues.current.push({ kind: m.kind, message: m.message, source: m.source, line: m.line });
  }), [bridge.on]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div role="alert" className="p-4 text-sm text-destructive">{error}. Use Refresh to retry.</div>;
  if (!load) return <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />Loading preview…</div>;
  return <iframe ref={iframeRef} title="HTML preview" src={`${load.url}?n=${encodeURIComponent(load.nonce)}`}
    sandbox="allow-scripts" referrerPolicy="no-referrer" className="flex-1 min-h-0 w-full border-0 bg-white"
    onLoad={() => { bridge.frameLoaded(); finishPreviewLoad(key, load.seq); }} />;
}
