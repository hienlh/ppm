import { useState } from "react";
import { Loader2, ImageOff } from "lucide-react";
import { useBlobUrl } from "@/hooks/use-blob-url";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { basename } from "@/lib/utils";

/**
 * Thumbnail of an image a tool read, so the user sees what the assistant saw.
 * Fetched as a blob with an Authorization header, which keeps the auth token out of the
 * image URL (and therefore out of browser history and referrers).
 */
export function ToolImagePreview({
  filePath,
  projectName,
}: {
  filePath: string;
  projectName: string;
}) {
  const { blobUrl, error: fetchFailed } = useBlobUrl(filePath, projectName);
  // A path can serve 200 and still not decode — e.g. a text file named *.png.
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const isMobile = useIsMobile();
  const name = basename(filePath);
  const error = fetchFailed || decodeFailed;

  if (error) {
    return (
      <div className="flex items-center gap-1.5 border-t border-border pt-1.5 text-[10px] text-text-subtle">
        <ImageOff className="size-3 shrink-0" />
        Image unavailable — file may have been moved or deleted
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-1.5">
      {blobUrl ? (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          title={`Open ${name}`}
          className="block overflow-hidden rounded-lg border border-border transition-colors hover:border-text-3 cursor-zoom-in"
        >
          <img
            src={blobUrl}
            alt={name}
            onError={() => setDecodeFailed(true)}
            className="max-h-40 max-w-full object-contain"
          />
        </button>
      ) : (
        // Fixed height while loading so the card does not jump when the image lands
        <div className="flex h-24 items-center justify-center rounded-lg border border-border bg-panel-2/40">
          <Loader2 className="size-4 animate-spin text-text-subtle" />
        </div>
      )}

      {zoomed && blobUrl && (
        isMobile ? (
          <BottomSheet open onClose={() => setZoomed(false)}>
            <div className="space-y-2 px-4 pb-6">
              <p className="truncate font-mono text-xs text-text-secondary">{name}</p>
              <img
                src={blobUrl}
                alt={name}
                className="max-h-[70vh] w-full rounded-lg object-contain"
              />
            </div>
          </BottomSheet>
        ) : (
          <Dialog open onOpenChange={(open) => { if (!open) setZoomed(false); }}>
            <DialogContent className="max-w-[92vw] sm:max-w-3xl">
              <DialogTitle className="truncate font-mono text-xs text-text-secondary">
                {name}
              </DialogTitle>
              <img
                src={blobUrl}
                alt={name}
                className="max-h-[80vh] w-full object-contain"
              />
            </DialogContent>
          </Dialog>
        )
      )}
    </div>
  );
}
