/**
 * The popover every chip of the chat footer opens: above the context row on a desktop, a bottom
 * sheet below `md`.
 *
 * Positioned against the context row (`relative`), not against the chip: the chips on the left sit
 * in a box that clips them when the chat is narrow, and an absolutely positioned child whose
 * containing block lies outside that box escapes the clip. So the chip wrappers must not be
 * `relative` themselves.
 *
 * It stays mounted for the 100ms its exit animation takes, so closing reads as leaving rather
 * than vanishing. Outside presses and Escape close it; a press on `anchorRef` is left to the
 * trigger, which toggles it itself.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";

const EXIT_MS = 100;

export function FooterPopover({ open, onClose, align = "left", label, anchorRef, className, children }: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  /** Accessible name of the panel. */
  label: string;
  /** The trigger: a press on it is the trigger's own toggle, not an outside press. */
  anchorRef?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const t = setTimeout(() => { setRendered(false); setClosing(false); }, EXIT_MS);
    return () => clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || isMobile) return;
    // The trigger's own document: in a picture-in-picture window the main document never sees
    // these. Read from the anchor, which exists before the panel has rendered.
    const doc = anchorRef?.current?.ownerDocument ?? panelRef.current?.ownerDocument ?? document;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      // A portalled menu or dialog opened from inside the panel is not an outside press.
      if ((target as Element).closest?.("[data-radix-popper-content-wrapper],[role=dialog]")) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape that something inside already used (a rename being cancelled), or that belongs to
      // a menu or dialog opened over the panel, closes that and not the whole popover.
      if (e.defaultPrevented) return;
      if (doc.querySelector("[data-radix-popper-content-wrapper], [role=dialog][data-state=open], [role=alertdialog]")) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    doc.addEventListener("pointerdown", onPointer);
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("pointerdown", onPointer);
      doc.removeEventListener("keydown", onKey);
    };
  }, [open, isMobile, anchorRef]);

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} className="flex max-h-[85%] flex-col">
        <div role="dialog" aria-label={label} className="flex min-h-0 flex-1 flex-col text-sm">{children}</div>
      </BottomSheet>
    );
  }
  if (!rendered) return null;
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-footer-popover={label}
      className={cn(
        // Capped to the viewport so a short pane still shows the header and the action row.
        "popover-solid absolute bottom-full z-50 mb-1 flex max-h-[min(75vh,560px)] w-[min(100%,360px)] flex-col overflow-hidden rounded-xl border border-border text-xs text-text shadow-[var(--shadow-float)]",
        align === "left" ? "left-0 origin-bottom-left" : "right-0 origin-bottom-right",
        closing ? "footer-pop-out" : "footer-pop-in",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The header line of a footer popover. */
export function FooterPopoverHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-10 shrink-0 items-center gap-2 border-b border-border-soft px-3 py-2 max-md:min-h-12 max-md:px-4", className)}>
      {children}
    </div>
  );
}

/** The action line at the foot of a footer popover — the thumb zone in the phone's sheet. */
export function FooterPopoverFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1 border-t border-border-soft p-2 max-md:gap-2 max-md:px-3", className)}>
      {children}
    </div>
  );
}

/** A plain button of a popover's footer; `primary` and `danger` for the one that matters. */
export function FooterButton({ variant = "plain", className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "plain" | "primary" | "danger" | "danger-fill";
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs transition-[background-color,color,transform] duration-150 motion-safe:active:scale-[0.97] disabled:opacity-50 max-md:h-11 max-md:text-sm [&_svg]:size-3.5 max-md:[&_svg]:size-4",
        variant === "plain" && "text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text",
        variant === "primary" && "ml-auto bg-primary font-medium text-primary-foreground can-hover:hover:bg-primary/90",
        variant === "danger" && "text-error can-hover:hover:bg-error/10",
        variant === "danger-fill" && "bg-error font-medium text-white can-hover:hover:bg-error/90",
        className,
      )}
    />
  );
}
