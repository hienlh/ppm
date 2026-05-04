import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, FileWarning, ExternalLink } from "lucide-react";
import { projectUrl, getAuthToken } from "@/lib/api-client";

export function PdfPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // Build stable direct URL (no blob) so reload() preserves scroll
  const iframeSrc = useMemo(() => {
    const isExternal = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
    const base = isExternal
      ? `/api/fs/raw?path=${encodeURIComponent(filePath)}`
      : `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    return token ? `${base}&token=${encodeURIComponent(token)}` : base;
  }, [filePath, projectName]);

  // Auto-reload on file change — reload() preserves browser PDF viewer scroll
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;
      try {
        iframeRef.current?.contentWindow?.location.reload();
      } catch { /* cross-origin fallback — shouldn't happen for same-origin */ }
    };
    window.addEventListener("file:changed", handler);
    return () => window.removeEventListener("file:changed", handler);
  }, [filePath, projectName]);

  const openInNewTab = useCallback(() => { window.open(iframeSrc, "_blank"); }, [iframeSrc]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load PDF.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full">
      {!loaded && (
        <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>
      )}
      <div className={`flex flex-col h-full ${loaded ? "" : "hidden"}`}>
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-background shrink-0">
          <span className="text-xs text-text-secondary truncate">{filePath}</span>
          <button onClick={openInNewTab} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
            <ExternalLink className="size-3" /> Open in new tab
          </button>
        </div>
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title={filePath}
          className="flex-1 w-full border-none"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      </div>
    </div>
  );
}
