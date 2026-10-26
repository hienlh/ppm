import { useCallback, useState } from "react";
import { RefreshCw } from "@/lib/icons";
import type { TreeItemAction } from "@/stores/extension-store";
import { extensionIcon } from "@/lib/extension-icons";
import { cn } from "@/lib/utils";
import { executeExtensionCommand } from "./extension-tree-dispatch";

/** One inline button on a tree row: the action's icon, its tooltip as the accessible name. */
export function ExtensionTreeActionButton({ action }: { action: TreeItemAction }) {
  const [spinning, setSpinning] = useState(false);
  const Icon = extensionIcon(action.icon) ?? RefreshCw;
  const isTrash = action.icon === "trash";

  const handleClick = useCallback((e: React.MouseEvent) => {
    // The row's own click opens the item; an action on it must not.
    e.stopPropagation();
    if (action.icon === "refresh") {
      setSpinning(true);
      setTimeout(() => setSpinning(false), 1000);
    }
    executeExtensionCommand(action.command, action.commandArgs);
  }, [action]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "p-0.5 text-text-subtle transition-colors",
        isTrash ? "hover:text-error" : "hover:text-foreground",
      )}
      title={action.tooltip}
      aria-label={action.tooltip}
    >
      <Icon className={cn("size-3", spinning && "animate-spin")} />
    </button>
  );
}
