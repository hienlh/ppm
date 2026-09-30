import { cn } from "@/lib/utils";

/** A count on a canvas toolbar button or More-sheet row, e.g. open comments; nothing for 0. */
export function ToolbarBadge({ count, className }: { count: number | null | undefined; className?: string }) {
  if (!count) return null;
  return (
    <span className={cn("flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
