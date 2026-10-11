import type { ElementType } from "react";
import { runCommandInBackground, type AppCommand, type CommandContext } from "@/lib/commands/command-registry";

/** One row of the command palette: an action, a project file, a filesystem path or a table. */
export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: ElementType;
  action: () => void;
  keywords?: string;
  group: "action" | "file" | "fs" | "db";
  connectionColor?: string | null;
  shortcut?: string;
  /** True if gitignored — rendered with muted style for visual cue */
  isIgnored?: boolean;
}

/**
 * A registry command as a palette row. Picking it closes the palette — before running it when
 * the command opens a dialog of its own, after otherwise.
 */
export function paletteItemFromCommand(cmd: AppCommand, ctx: CommandContext, onClose: () => void): CommandItem {
  return {
    id: cmd.id,
    label: cmd.label,
    hint: cmd.hint,
    icon: cmd.icon,
    keywords: cmd.keywords,
    group: "action",
    shortcut: cmd.shortcut,
    action: () => {
      if (cmd.closePaletteFirst) onClose();
      runCommandInBackground(cmd, ctx);
      if (!cmd.closePaletteFirst) onClose();
    },
  };
}
