import { useState } from "react";
import { FileWarning, Music } from "lucide-react";
import { basename } from "@/lib/utils";
import { rawMediaUrl } from "@/lib/media-url";

/** Streams straight from the Range-capable URL — no whole-file blob, instant seek. */
export function AudioPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load audio.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-4 bg-surface">
      <Music className="size-16 text-text-subtle" />
      <p className="text-sm text-text-secondary truncate max-w-xs">{basename(filePath)}</p>
      <audio key={filePath} src={rawMediaUrl(filePath, projectName)} controls preload="metadata" className="w-full max-w-md" onError={() => setError(true)} />
    </div>
  );
}
