/**
 * A button a hosted tab puts in its window's titlebar, styled like the skin's own caption buttons:
 * a 46 px column on Windows, a small square beside picture-in-picture on macOS.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TitleExtrasButton({ skin, label, onClick, children, wide }: {
  skin: "windows" | "macos";
  label: string;
  onClick: () => void;
  children: ReactNode;
  /** Carries a word as well as an icon ("Open in project"). */
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 text-text-2 transition-colors can-hover:hover:bg-surface-elevated can-hover:hover:text-text",
        skin === "windows" ? "self-stretch" : "h-6 rounded",
        wide ? "px-2.5 text-[11.5px] font-medium" : skin === "windows" ? "w-[46px]" : "w-6",
      )}
    >
      {children}
    </button>
  );
}
