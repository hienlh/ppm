import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, FileWarning, ExternalLink } from "lucide-react";
import { useBlobUrl } from "./use-blob-url";

export function PdfPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageHashRef = useRef("");

  const { blobUrl, error } = useBlobUrl(filePath, projectName, "application/pdf", refreshKey);

  // Auto-reload: listen for file:changed WS events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;
      // Save current page hash before re-fetch (Chrome PDF viewer uses #page=N&zoom=...)
      try {
        pageHashRef.current = iframeRef.current?.contentWindow?.location.hash || "";
      } catch { /* cross-origin */ }
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener("file:changed", handler);
    return () => window.removeEventListener("file:changed", handler);
  }, [filePath, projectName]);

  const openInNewTab = useCallback(() => { if (blobUrl) window.open(blobUrl, "_blank"); }, [blobUrl]);

  // Append saved page hash to blob URL so PDF viewer restores position
  const iframeSrc = blobUrl
    ? `${blobUrl}${pageHashRef.current}`
    : undefined;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load PDF.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-background shrink-0">
        <span className="text-xs text-text-secondary truncate">{filePath}</span>
        <button onClick={openInNewTab} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
          <ExternalLink className="size-3" /> Open in new tab
        </button>
      </div>
      <iframe ref={iframeRef} src={iframeSrc} title={filePath} className="flex-1 w-full border-none" />
    </div>
  );
}
