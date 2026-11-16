/**
 * "While you were away": marks a history row the PPM Assistant wrote in an unattended turn, so the
 * user notices changes nobody watched being made (they can be undone like any AI change).
 */
import { Moon } from "@/lib/icons";
import { cn } from "@/lib/utils";

export function TaskUnattendedBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-[5px] bg-warning/15 px-1.5 text-[10.5px] font-semibold text-text-2", className)}
      data-unattended title="Made by the Assistant while you were away">
      <Moon aria-hidden className="size-3" />
      while you were away
    </span>
  );
}
