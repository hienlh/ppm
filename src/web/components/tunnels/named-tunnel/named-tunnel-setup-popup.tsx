/**
 * Mount point for the first-run named-tunnel flow: a centred dialog on
 * desktop, a bottom sheet on mobile (`docs/design-guidelines.md` — dialogs
 * must never be desktop-only). Closing (backdrop, swipe, X) only hides this
 * popup instance — it does not call `dismiss()` and does not cancel an
 * in-progress login; the Tunnel Manager section is the permanent re-entry
 * point, so nothing is lost.
 */
import { useState } from "react";
import { X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useNamedTunnelSetup } from "./use-named-tunnel-setup";
import { NamedTunnelSetupContent } from "./named-tunnel-setup-content";

export function NamedTunnelSetupPopup() {
  const t = useNamedTunnelSetup();
  const isMobile = useIsMobile();
  const [closedByUser, setClosedByUser] = useState(false);

  const visible = t.step.k !== "hidden" && !closedByUser;
  if (!visible) return null;

  const handleClose = () => setClosedByUser(true);

  if (isMobile) {
    return (
      <BottomSheet open={visible} onClose={handleClose} zIndex={45}>
        <div className="px-4 pb-4">
          <NamedTunnelSetupContent step={t.step} t={t} />
        </div>
      </BottomSheet>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-[45] bg-black/40" onClick={handleClose} />
      <div
        className="fixed z-[45] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md max-h-[85vh] overflow-y-auto rounded-xl bg-popover text-popover-foreground border border-border shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="absolute right-3 top-3 size-10 flex items-center justify-center rounded-md hover:bg-surface-elevated transition-colors"
        >
          <X className="size-4" />
        </button>
        <div className="pr-8">
          <NamedTunnelSetupContent step={t.step} t={t} />
        </div>
      </div>
    </>
  );
}
