import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, FileWarning, ExternalLink } from "lucide-react";
import { useBlobUrl } from "./use-blob-url";

export function PdfPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const scrollYRef = useRef(0);

  const { blobUrl, error } = useBlobUrl(filePath, projectName, "application/pdf", refreshKey);

  // Auto-reload: listen for file:changed WS events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;
      // Save scroll position before re-fetch (best-effort for browser PDF viewer)
      try {
        const win = iframeRef.current?.contentWindow;
        if (win) scrollYRef.current = win.scrollY || 0;
      } catch { /* cross-origin or plugin restriction */ }
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener("file:changed", handler);
    return () => window.removeEventListener("file:changed", handler);
  }, [filePath, projectName]);

  // Restore scroll after new blob loads
  useEffect(() => {
    if (!blobUrl || !iframeRef.current || scrollYRef.current === 0) return;
    const iframe = iframeRef.current;
    const saved = scrollYRef.current;
    const onLoad = () => {
      try { iframe.contentWindow?.scrollTo(0, saved); } catch { /* ignore */ }
      scrollYRef.current = 0;
    };
    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, [blobUrl]);

  const openInNewTab = useCallback(() => { if (blobUrl) window.open(blobUrl, "_blank"); }, [blobUrl]);

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
      <iframe ref={iframeRef} src={blobUrl} title={filePath} className="flex-1 w-full border-none" />
    </div>
  );
}
