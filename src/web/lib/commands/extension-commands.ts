/**
 * The commands extensions contribute, as registry commands. PPM cannot see what an extension's
 * command does — it runs in the extension host, on the server — so every one of them is
 * declared as changing data, and the Assistant runs none without the user's approval.
 */
import { Puzzle } from "@/lib/icons";
import { extensionIcon } from "@/lib/extension-icons";
import { dispatchExtCommand } from "@/lib/ext-command-dispatch";
import { formatShortcut, isMac } from "./format-shortcut";
import type { AppCommand, CommandContext } from "./command-registry";

export const EXTENSION_COMMAND_PREFIX = "ext:";

/** Runs an extension's command in the project the device shows, from a palette row or a key. */
export function runExtensionCommand(command: string): Promise<void> {
  return dispatchExtCommand(command);
}

/** The key combo that runs `command`: the user's override, else the extension's own default. */
export function extensionKeyCombo(ctx: Pick<CommandContext, "getBinding">, kb: { command: string; key: string; mac?: string }): string {
  return ctx.getBinding(`${EXTENSION_COMMAND_PREFIX}${kb.command}`) || ((isMac && kb.mac) ? kb.mac : kb.key);
}

export function extensionCommands(ctx: CommandContext): AppCommand[] {
  const keybindings = ctx.extensions?.keybindings ?? [];
  return (ctx.extensions?.commands ?? []).map((cmd) => {
    const kb = keybindings.find((k) => k.command === cmd.command);
    const combo = kb ? extensionKeyCombo(ctx, kb) : "";
    return {
      id: `${EXTENSION_COMMAND_PREFIX}${cmd.command}`,
      label: cmd.title,
      hint: cmd.category,
      icon: extensionIcon(cmd.icon) ?? Puzzle,
      keywords: `extension ${cmd.command} ${cmd.category ?? ""}`,
      shortcut: combo ? formatShortcut(combo) : undefined,
      changesData: true,
      run: () => runExtensionCommand(cmd.command),
    };
  });
}
