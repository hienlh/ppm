/** The frame of every schedule sheet: a bottom sheet on a phone, a dialog on a desktop. */
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

export function ScheduleSheet({ open, onClose, title, wide, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Room for a script. */
  wide?: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} className="max-h-[85vh] flex flex-col">
        <p className="text-sm font-semibold text-center pb-2 px-3 truncate">{title}</p>
        <ScrollArea className="flex-1 min-h-0 px-3 pb-3">{children}</ScrollArea>
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={cn(wide ? "max-w-2xl" : "max-w-md", "max-h-[85vh] overflow-y-auto")}>
        <DialogHeader><DialogTitle className="text-sm truncate">{title}</DialogTitle></DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
