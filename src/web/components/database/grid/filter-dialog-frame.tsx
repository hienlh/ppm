/**
 * The frame the filter dialogs share: DBGate's small modal with OK and Close at its foot on a
 * desktop, a bottom sheet with both in the thumb zone on a phone. Enter in a field is OK. Focus
 * starts on the field marked `data-autofocus`, or else the first one. On a desktop, it goes back
 * to the filter box the dialog was opened from, or else to whatever had it — on a phone that
 * would only bring the keyboard up again.
 */
import { useId, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useOpenerFocus } from "./use-opener-focus";

export function FilterDialogFrame({ title, description, okLabel = "OK", okDisabled = false, onOk, onClose, returnFocus, extraButton, className, children }: {
  title: string;
  /** What the main button says, as the dialog's DBGate original words it. */
  okLabel?: string;
  /** OK has nothing to do yet: the button is greyed and Enter does nothing. */
  okDisabled?: boolean;
  /** Said under the title to screen readers. */
  description: string;
  onOk: () => void;
  onClose: () => void;
  returnFocus?: () => void;
  /** After Close, as DBGate puts Lookup's Customize; given the class that sizes it like the other two. */
  extraButton?: (className: string | undefined) => ReactNode;
  /** The desktop dialog's own: a wider one says `sm:max-w-*`, which is what beats the frame's. */
  className?: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const titleId = useId();
  const backToOpener = useOpenerFocus();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
    // A button answers Enter itself, and Enter in a list of lines is the next line.
    if ((e.target as HTMLElement).closest("button, textarea")) return;
    e.preventDefault();
    if (!okDisabled) onOk();
  };

  const secondary = isMobile ? "h-11 flex-1 text-sm" : undefined;
  const buttons = (
    <>
      <Button type="button" size="sm" onClick={onOk} disabled={okDisabled} className={cn(isMobile && "h-11 flex-[2] text-sm")}>{okLabel}</Button>
      <Button type="button" size="sm" variant="outline" onClick={onClose} className={secondary}>Close</Button>
      {extraButton?.(secondary)}
    </>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} className="popover-solid">
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} className="flex max-h-[calc(var(--sheet-vh,100dvh)*0.85)] flex-col">
          <h2 id={titleId} className="px-4 pb-2 pt-1 text-base font-semibold">{title}</h2>
          <div className="grid min-h-0 content-start gap-3 overflow-y-auto px-4 pb-3">{children}</div>
          <div className="flex gap-2 border-t border-border-soft px-3 pt-2.5">{buttons}</div>
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        onKeyDown={onKeyDown}
        // Not React's autoFocus: the funnel menu that opened the dialog is still closing then, and
        // its focus trap takes focus straight back. By the time the dialog's own trap starts, the
        // menu's has stood down.
        onOpenAutoFocus={(e) => {
          const start = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]");
          if (!start) return;
          e.preventDefault();
          start.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (!returnFocus) { backToOpener(e); return; }
          e.preventDefault();
          returnFocus();
        }}
        className={cn("max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-5 sm:max-w-[470px]", className)}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 grid content-start gap-2.5 overflow-y-auto px-1 py-0.5">{children}</div>
        <div className="flex items-center gap-2">{buttons}</div>
      </DialogContent>
    </Dialog>
  );
}
