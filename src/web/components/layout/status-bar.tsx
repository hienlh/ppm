import { memo } from "react";
import { useExtensionStore, type StatusBarItemUI } from "@/stores/extension-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Fixed status bar at the bottom of the editor area (hidden on mobile) */
export const StatusBar = memo(function StatusBar() {
  const items = useExtensionStore((s) => s.statusBarItems);

  const left = items
    .filter((i) => i.alignment === "left")
    .sort((a, b) => b.priority - a.priority);

  const right = items
    .filter((i) => i.alignment === "right")
    .sort((a, b) => b.priority - a.priority);

  return (
    <div className="hidden md:flex items-center justify-between h-[22px] px-2 bg-surface border-t border-border text-[11px] text-text-subtle select-none shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {left.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {right.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
});

const StatusBarEntry = memo(function StatusBarEntry({ item }: { item: StatusBarItemUI }) {
  const content = (
    <button
      className={`truncate px-1 rounded-sm transition-colors ${
        item.command
          ? "hover:bg-accent/15 hover:text-text-primary cursor-pointer"
          : "cursor-default"
      }`}
      onClick={() => {
        if (item.command) {
          window.dispatchEvent(new CustomEvent("ext:command:execute", {
            detail: { command: item.command },
          }));
        }
      }}
    >
      {item.text}
    </button>
  );

  if (item.tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {item.tooltip}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
});
