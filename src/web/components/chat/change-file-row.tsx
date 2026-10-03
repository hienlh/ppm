/**
 * The +added −removed pair the change tray, the changes bar and the Review tab all show.
 */
import { cn } from "@/lib/utils";

export function ChangeCounts({ added, removed, editCount, className }: {
  added: number;
  removed: number;
  editCount?: number;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-[5px] tabular-nums", className)}>
      <span className="text-success">+{added}</span>
      <span className="text-error">{"−"}{removed}</span>
      {editCount != null && editCount > 1 && (
        <span className="text-text-subtle">{"×"}{editCount}</span>
      )}
    </span>
  );
}
