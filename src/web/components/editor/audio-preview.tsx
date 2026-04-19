import { Loader2, FileWarning, Music } from "lucide-react";
import { useBlobUrl } from "./use-blob-url";
import { basename } from "@/lib/utils";

export function AudioPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const { blobUrl, error } = useBlobUrl(filePath, projectName);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load audio.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-4 bg-surface">
      <Music className="size-16 text-text-subtle" />
      <p className="text-sm text-text-secondary truncate max-w-xs">{basename(filePath)}</p>
      <audio src={blobUrl} controls className="w-full max-w-md" />
    </div>
  );
}
