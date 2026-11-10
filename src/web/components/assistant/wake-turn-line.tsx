/**
 * A turn PPM started on its own that the Assistant answered `[no reply]`: nothing in it was for
 * the user (the reports are already cards), so it shows as one muted line.
 */
import { Bot } from "@/lib/icons";

export function wakeTurnText(reports: number): string {
  if (reports <= 0) return "Assistant read the manager news";
  return `Assistant read ${reports} report${reports === 1 ? "" : "s"}`;
}

export function WakeTurnLine({ reports }: { reports: number }) {
  return (
    <p className="flex items-center gap-1.5 px-1 text-xs text-text-subtle" data-wake-turn="">
      <Bot className="size-3.5 shrink-0" />
      {wakeTurnText(reports)}
    </p>
  );
}
