/**
 * Reusable mobile bottom sheet component.
 * Shell: portal + backdrop + slide-up panel + drag handle + swipe-to-dismiss.
 * Content is fully consumer-controlled.
 *
 * Also exports context-menu-specific sub-components (BottomSheetItem, etc.)
 * used by adaptive-context-menu.tsx.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useSwipeToDismiss } from "@/hooks/use-swipe-to-dismiss";

/* ------------------------------------------------------------------ */
/*  Core BottomSheet — reusable everywhere                             */
/* ------------------------------------------------------------------ */

/** Quiet period before a viewport change is committed, in ms. Long enough to
 *  outlast the keyboard's slide, short enough not to read as lag. */
const VIEWPORT_SETTLE_MS = 120;

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Override z-index for stacked sheets (default: z-50) */
  zIndex?: number;
}

/**
 * General-purpose bottom sheet with swipe-to-dismiss.
 * Renders portal + backdrop + rounded panel + drag handle.
 * Put any content inside — headers, lists, forms, etc.
 */
export function BottomSheet({ open, onClose, children, className, zIndex = 50 }: BottomSheetProps) {
  const { dragY, swipeHandlers, dragStyle, backdropOpacity, isDragging } =
    useSwipeToDismiss(onClose);

  // Follow the visual viewport so the panel rides above the on-screen keyboard.
  // A `fixed inset-0` container is anchored to the layout viewport, which does
  // not shrink when the keyboard opens — so `bottom-0` would sit behind it.
  // Constraining the container to the visual viewport keeps the panel visible.
  //
  // iOS reports a stream of intermediate sizes while the keyboard slides, and
  // committing each one steps the panel up the screen a frame at a time and
  // fires a resize at anything watching the content. Settling first turns that
  // into one move, which the CSS height transition then animates smoothly.
  const [vv, setVv] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const commit = () => setVv({ top: viewport.offsetTop, height: viewport.height });
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, VIEWPORT_SETTLE_MS);
    };

    commit(); // first paint must be correct, not deferred
    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", settle);
    return () => {
      if (timer) clearTimeout(timer);
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", settle);
    };
  }, [open]);

  if (!open) return null;

  // When tracking the visual viewport, pin the container to it (top + height,
  // bottom auto) instead of the full-page inset-0 default.
  //
  // `--sheet-vh` lets a panel size itself against what is actually visible.
  // `vh` units resolve against the layout viewport, which ignores the keyboard,
  // so a `60vh` panel inside a keyboard-shrunk container overflows its own top.
  const containerStyle = vv
    ? {
        zIndex,
        top: `${vv.top}px`,
        height: `${vv.height}px`,
        bottom: "auto" as const,
        "--sheet-vh": `${vv.height}px`,
      } as React.CSSProperties
    : ({ zIndex, "--sheet-vh": "100dvh" } as React.CSSProperties);

  return createPortal(
    <div className="fixed inset-0" style={containerStyle} onClick={onClose}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in-0 duration-200"
        style={isDragging ? { opacity: backdropOpacity } : undefined}
      />
      {/* Panel */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 rounded-t-2xl bg-popover text-popover-foreground border-t border-border",
          "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
          !isDragging && "animate-in slide-in-from-bottom duration-200",
          className,
        )}
        style={dragStyle}
        onClick={(e) => e.stopPropagation()}
        {...swipeHandlers}
      >
        {/* Drag handle. shrink-0 so a flex-column sheet gives it its own height
            instead of letting `h-full`/`flex-1` content overflow past it. */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>
        {children}
      </div>
    </div>,
    sheetPortalTarget(),
  );
}

/**
 * Portal target for every sheet: the React root, never `document.body`.
 *
 * TabPool reparents live tab DOM into panel slots with `appendChild`, and on
 * mobile the dock's slot lives inside a sheet. A body-level portal would put
 * that node outside the root container React binds its delegated listeners to,
 * so React resolves the node's root container (`#root`) against the container
 * the event fired on (`body`), finds no match, and drops the event — every
 * button inside a dock tab goes dead while native listeners still fire.
 * `#root` carries no styles, so keeping the portal inside it leaves stacking
 * order untouched.
 */
function sheetPortalTarget(): HTMLElement {
  return document.getElementById("root") ?? document.body;
}

/* ------------------------------------------------------------------ */
/*  Context-menu-specific helpers (used by adaptive-context-menu)       */
/* ------------------------------------------------------------------ */

/** Context for adaptive-context-menu to pass open/close state */
export interface BottomSheetState {
  open: boolean;
  setOpen: (v: boolean) => void;
}

export const BottomSheetCtx = createContext<BottomSheetState>({
  open: false,
  setOpen: () => {},
});

/** Menu item styled for touch (44px+ height), auto-closes sheet on click */
export function BottomSheetItem({
  children,
  onClick,
  variant,
  className,
  disabled,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: "default" | "destructive";
  className?: string;
  disabled?: boolean;
}) {
  const { setOpen } = useContext(BottomSheetCtx);

  return (
    <button
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-3 text-sm text-left",
        "active:bg-accent transition-colors select-none",
        "disabled:pointer-events-none disabled:opacity-50",
        variant === "destructive" && "text-destructive",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        setOpen(false);
      }}
    >
      {children}
    </button>
  );
}

/** Separator line */
export function BottomSheetSeparator({ className }: { className?: string }) {
  return <div className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

/** Sub-menu label (flattened on mobile) */
export function BottomSheetSubLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground select-none",
        "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Sub-menu content wrapper (indented on mobile) */
export function BottomSheetSubContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("pl-2", className)}>{children}</div>;
}
