import { Loader2, FileWarning } from "@/lib/icons";
import { useBlobUrl } from "@/hooks/use-blob-url";
import { ZoomableImage } from "@/components/media/zoomable-image";

export function ImagePreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const { blobUrl, error } = useBlobUrl(filePath, projectName);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load image.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  return (
    <div className="h-full p-4 bg-surface">
      <ZoomableImage src={blobUrl} alt={filePath} />
    </div>
  );
}
