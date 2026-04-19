import { Loader2, FileWarning } from "lucide-react";
import { useBlobUrl } from "./use-blob-url";

export function VideoPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const { blobUrl, error } = useBlobUrl(filePath, projectName);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load video.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  return (
    <div className="flex items-center justify-center h-full p-4 bg-surface overflow-auto">
      <video src={blobUrl} controls className="max-w-full max-h-full" />
    </div>
  );
}
