/**
 * One modal presentation for every explorer prompt: a centred dialog on desktop, a
 * bottom sheet below `md`.
 *
 * Properties, the collision prompt and the permanent-delete confirmation all need the
 * same treatment, and the mobile rules say a dialog must become a sheet — doing that once
 * here keeps the three call sites free of breakpoint logic.
 */

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

export interface ExplorerModalShellProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Rendered bottom-right on desktop, stacked full-width in the sheet's thumb zone. */
  footer?: ReactNode;
  className?: string;
}

export function ExplorerModalShell({
  open, onClose, title, description, children, footer, className,
}: ExplorerModalShellProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} className="p-4">
        <div className={cn("space-y-3", className)}>
          <div>
            <h2 className="text-base font-semibold text-text">{title}</h2>
            {description && <p className="mt-1 text-sm text-text-2">{description}</p>}
          </div>
          <div className="max-h-[50vh] overflow-y-auto">{children}</div>
          {/* Primary actions sit at the bottom of the sheet, inside the thumb zone. */}
          {footer && <div className="flex flex-col gap-2 pt-1">{footer}</div>}
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
        <div className="max-h-[60vh] overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 pt-2">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
