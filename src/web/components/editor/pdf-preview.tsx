import { useCallback } from "react";
import { Loader2, FileWarning, ExternalLink } from "lucide-react";
import { useBlobUrl } from "./use-blob-url";

export function PdfPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const { blobUrl, error } = useBlobUrl(filePath, projectName, "application/pdf");

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
      <iframe src={blobUrl} title={filePath} className="flex-1 w-full border-none" />
    </div>
  );
}
