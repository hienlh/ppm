/**
 * AdaptiveContextMenu — drop-in replacement for radix ContextMenu.
 * Desktop: standard right-click context menu (radix).
 * Mobile: long-press opens a bottom sheet.
 *
 * Usage: import from this file instead of "@/components/ui/context-menu".
 * Same component names, same API — behavior adapts automatically.
 */
import React, { useState, useRef, useCallback, type ReactNode } from "react";
import * as Radix from "./context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";
import {
  BottomSheet,
  BottomSheetCtx,
  BottomSheetItem,
  BottomSheetSeparator,
  BottomSheetSubLabel,
  BottomSheetSubContent,
} from "./mobile-bottom-sheet";

const LONG_PRESS_MS = 500;

const IsMobileCtx = React.createContext(false);

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

function ContextMenu({ children, ...props }: React.ComponentProps<typeof Radix.ContextMenu>) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!isMobile) {
    return <Radix.ContextMenu {...props}>{children}</Radix.ContextMenu>;
  }

  return (
    <IsMobileCtx.Provider value={true}>
      <BottomSheetCtx.Provider value={{ open, setOpen }}>
        {children}
      </BottomSheetCtx.Provider>
    </IsMobileCtx.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Trigger                                                            */
/* ------------------------------------------------------------------ */

function ContextMenuTrigger({
  children,
  asChild,
  ...props
}: React.ComponentProps<typeof Radix.ContextMenuTrigger>) {
  const isMobile = React.useContext(IsMobileCtx);
  const { setOpen } = React.useContext(BottomSheetCtx);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const suppressRef = useRef(false);

  if (!isMobile) {
    return (
      <Radix.ContextMenuTrigger asChild={asChild} {...props}>
        {children}
      </Radix.ContextMenuTrigger>
    );
  }

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation(); // prevent parent triggers from also firing
      suppressRef.current = false;
      timerRef.current = setTimeout(() => {
        setOpen(true);
        suppressRef.current = true;
      }, LONG_PRESS_MS);
    },
    [setOpen],
  );

  const handleTouchMove = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  const handleTouchEnd = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressRef.current = false;
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      className="contents"
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Content                                                            */
/* ------------------------------------------------------------------ */

function ContextMenuContent({
  children,
  className,
  ...props
}: React.ComponentProps<typeof Radix.ContextMenuContent>) {
  const isMobile = React.useContext(IsMobileCtx);
  if (!isMobile) {
    return (
      <Radix.ContextMenuContent className={className} {...props}>
        {children}
      </Radix.ContextMenuContent>
    );
  }
  const { open, setOpen } = React.useContext(BottomSheetCtx);
  return (
    <BottomSheet open={open} onClose={() => setOpen(false)} className={cn("p-2", className)}>
      <div className="max-h-[60vh] overflow-y-auto">{children}</div>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Item                                                               */
/* ------------------------------------------------------------------ */

function ContextMenuItem({
  children,
  className,
  variant,
  onClick,
  disabled,
  ...props
}: React.ComponentProps<typeof Radix.ContextMenuItem> & {
  variant?: "default" | "destructive";
}) {
  const isMobile = React.useContext(IsMobileCtx);
  if (!isMobile) {
    return (
      <Radix.ContextMenuItem className={className} variant={variant} disabled={disabled} onClick={onClick} {...props}>
        {children}
      </Radix.ContextMenuItem>
    );
  }
  return (
    <BottomSheetItem
      className={className}
      variant={variant}
      disabled={disabled}
      onClick={onClick as unknown as (e: React.MouseEvent) => void}
    >
      {children}
    </BottomSheetItem>
  );
}

/* ------------------------------------------------------------------ */
/*  Separator                                                          */
/* ------------------------------------------------------------------ */

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Radix.ContextMenuSeparator>) {
  const isMobile = React.useContext(IsMobileCtx);
  if (!isMobile) {
    return <Radix.ContextMenuSeparator className={className} {...props} />;
  }
  return <BottomSheetSeparator className={className} />;
}

/* ------------------------------------------------------------------ */
/*  Sub-menu (flattened on mobile)                                     */
/* ------------------------------------------------------------------ */

function ContextMenuSub({ children, ...props }: React.ComponentProps<typeof Radix.ContextMenuSub>) {
  const isMobile = React.useContext(IsMobileCtx);
  if (!isMobile) return <Radix.ContextMenuSub {...props}>{children}</Radix.ContextMenuSub>;
  return <>{children}</>;
}

function ContextMenuSubTrigger({
  children,
  className,
  ...props
}: React.ComponentProps<typeof Radix.ContextMenuSubTrigger>) {
  const isMobile = React.useContext(IsMobileCtx);
  if (!isMobile) {
    return (
      <Radix.ContextMenuSubTrigger className={className} {...props}>
        {children}
      </Radix.ContextMenuSubTrigger>
    );
  }
  return <BottomSheetSubLabel className={className}>{children}</BottomSheetSubLabel>;
}

function ContextMenuSubContent({
  children,
  className,
  ...props
}: React.ComponentProps<typeof Radix.ContextMenuSubContent>) {
  const isMobile = React.useContext(IsMobileCtx);
  if (!isMobile) {
    return (
      <Radix.ContextMenuSubContent className={className} {...props}>
        {children}
      </Radix.ContextMenuSubContent>
    );
  }
  return <BottomSheetSubContent className={className}>{children}</BottomSheetSubContent>;
}

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
};
