import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

/**
 * One modal presentation for every design dialog: a centred dialog on desktop, a bottom
 * sheet below `md` with its actions stacked at the bottom, inside the thumb zone.
 */
export function DesignResponsiveDialog({ open, onClose, title, description, children, footer, className }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  /** Primary action last: rightmost on desktop, lowest in the sheet. */
  footer?: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} className="max-h-[85vh] p-4">
        <div className={cn("flex flex-col gap-3", className)}>
          <div>
            <h2 className="text-base font-semibold text-text">{title}</h2>
            {description && <p className="mt-1 text-sm text-text-2">{description}</p>}
          </div>
          {children && <div className="max-h-[55vh] overflow-y-auto">{children}</div>}
          {footer && <div className="flex flex-col gap-2 pt-1 [&>*]:min-h-11">{footer}</div>}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className={cn("sm:max-w-md", className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children && <div className="max-h-[60vh] overflow-y-auto">{children}</div>}
        {footer && <div className="flex justify-end gap-2 pt-2">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
