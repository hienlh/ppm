/**
 * The dialogs of Settings → PPM Assistant: a dialog on a desktop, a bottom sheet below `md`
 * (design guidelines), with the same body either way. `ConfirmDialog` is the yes/no one.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

export function AssistantSettingsDialog({ open, title, description, wide, onClose, children }: {
  open: boolean;
  title: string;
  /** One line under the title; read out to a screen reader either way. */
  description?: string;
  /** A wider dialog on a desktop, for an editor. */
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (!open) return null;
  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} className="flex max-h-[85dvh] flex-col">
        <div role="dialog" aria-label={title} className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="text-sm text-text-secondary">{description}</p>}
          {children}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className={cn("max-h-[90dvh] overflow-y-auto", wide && "sm:max-w-2xl")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : "sr-only"}>{description ?? title}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Buttons at the foot of a dialog: stacked full-width on a phone, right-aligned on a desktop. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">{children}</div>;
}

export const DIALOG_BUTTON = "min-h-11 md:min-h-9";

export function ConfirmDialog({ open, title, confirmLabel, destructive, onConfirm, onClose, children }: {
  open: boolean;
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <AssistantSettingsDialog open={open} title={title} onClose={onClose}>
      <p className="text-sm text-text-secondary">{children}</p>
      <DialogActions>
        <Button type="button" variant="outline" onClick={onClose} className={DIALOG_BUTTON}>Cancel</Button>
        <Button type="button" variant={destructive ? "destructive" : "default"} onClick={onConfirm} className={DIALOG_BUTTON}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </AssistantSettingsDialog>
  );
}
