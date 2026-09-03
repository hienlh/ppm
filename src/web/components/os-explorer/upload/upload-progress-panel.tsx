/**
 * Global upload progress surface — mounted once at the app root (`app.tsx`), reading straight
 * from `upload-store.ts`. Replaces the old "Uploading N files… NN%" toast: desktop gets a
 * persistent bottom-right card per batch (a normal fixed panel, not a modal — `z-30` keeps it
 * under the floating-window band's own max of `z-38` and well under Radix's `z-50`); mobile
 * collapses every batch behind a small pinned pill that opens a bottom sheet, so the keyboard
 * dock and thumb zone stay clear.
 */

import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { UploadBatchCard } from "./upload-batch-card";
import { useUploadStore, type UploadBatch } from "./upload-store";

// `useShallow` keeps this selector's returned array reference-stable across renders that
// don't actually change any batch — the plain `.map().filter()` used before it built a new
// array identity on every call, and zustand's `useSyncExternalStore` subscription then saw
// a "changed" snapshot on every single render, looping forever ("Maximum update depth
// exceeded") the moment any batch existed.
function useActiveBatches(): UploadBatch[] {
  return useUploadStore(
    useShallow((s) => s.order.map((id) => s.batches[id]).filter((b): b is UploadBatch => b != null)),
  );
}

export function UploadProgressPanel() {
  const isMobile = useIsMobile();
  const batches = useActiveBatches();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (batches.length === 0) return null;

  if (!isMobile) {
    return (
      <div
        className="fixed bottom-4 right-4 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
        data-testid="upload-progress-panel"
      >
        {batches.map((batch) => (
          <UploadBatchCard key={batch.id} batch={batch} />
        ))}
      </div>
    );
  }

  const uploading = batches.filter((b) => !b.settled).length;
  const label = uploading > 0
    ? `Uploading ${batches.reduce((n, b) => n + b.items.length, 0)}…`
    : "Uploads finished";

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        data-testid="upload-progress-pill"
        className="fixed bottom-20 right-3 z-30 flex h-11 items-center gap-2 rounded-full border border-border bg-panel px-4 text-sm text-text shadow-lg"
      >
        {label}
      </button>
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} className="max-h-[70vh] overflow-y-auto p-2">
        <div className="flex flex-col gap-2 px-2 pb-2">
          {batches.map((batch) => (
            <UploadBatchCard key={batch.id} batch={batch} />
          ))}
        </div>
      </BottomSheet>
    </>
  );
}
