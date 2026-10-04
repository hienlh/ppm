/**
 * The one confirmation the git surfaces ask before throwing work away —
 * discarding changes, aborting a merge, dropping a stash.
 *
 * Anchored to whatever asked for it on a desktop (a popover under the trash
 * button, not a dialog across the screen), and a bottom sheet on a phone,
 * where the question has to sit in the thumb zone. Focus lands on Cancel, so
 * Enter never confirms by accident.
 */
import { useRef, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { Trash2, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";

export interface GitConfirmRequest {
  /** What the popover hangs from on a desktop. */
  anchor: HTMLElement | null;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Defaults to a bin; aborting a merge is not throwing a file away. */
  confirmIcon?: ReactNode;
  onConfirm: () => void;
}

export function GitConfirm({ request, onClose }: { request: GitConfirmRequest | null; onClose: () => void }) {
  const isMobile = useIsMobile();
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = request?.anchor ?? null;

  const confirm = () => {
    const run = request?.onConfirm;
    onClose();
    run?.();
  };

  const body = request && (
    <>
      <h5 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-text">
        <TriangleAlert className="size-4 shrink-0 text-error" />
        <span className="min-w-0 break-words">{request.title}</span>
      </h5>
      <div className="mb-3 text-[12.5px] leading-normal text-text-2">{request.body}</div>
      <div className="flex justify-end gap-1.5 max-md:flex-col-reverse max-md:gap-2">
        <Button variant="ghost" size="sm" className="max-md:h-11" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" className="max-md:h-11" onClick={confirm}>
          {request.confirmIcon ?? <Trash2 />}
          {request.confirmLabel}
        </Button>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <BottomSheet open={!!request} onClose={onClose}>
        <div className="px-4 pb-4 pt-1">{body}</div>
      </BottomSheet>
    );
  }

  return (
    <Popover.Root open={!!request} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <Popover.Portal>
        <Popover.Content
          role="alertdialog"
          aria-label={request?.title}
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-panel-2 p-3.5 shadow-lg"
        >
          {body}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
