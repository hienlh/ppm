/**
 * PPM's commands under fixed ids: what the command palette lists, what the global keybindings
 * run, and what the PPM Assistant may list and run on the device the user chats from. One list
 * for all three, so a shortcut, a palette row and an Assistant call can never drift apart.
 *
 * A command receives everything that varies per device and per moment through the
 * {@link CommandContext} it is run with — the project shown, the viewport, the device kind,
 * the keybindings, the extensions loaded — instead of closing over a component's state, which
 * is what makes it callable from outside the palette.
 *
 * Three kinds feed the list, always in this order: the built-in commands, those React hooks
 * publish because they follow state only a hook sees (designs, the database sidebar and table
 * editor), and the commands extensions contribute. An extension's command is opaque to PPM, so
 * it is always declared as changing data.
 */
import type { ElementType } from "react";
import type { ExtensionContributes } from "../../../types/extension";
import { builtInCommands } from "./built-in-commands";
import { extensionCommands } from "./extension-commands";

export interface CommandContext {
  /** The project the device shows; commands that open something open it there. */
  project: { name: string; path?: string } | null;
  /** The viewport is phone-sized (below `md`). */
  isMobile: boolean;
  /** The device's primary pointer is a finger, whatever its width. */
  isTouchOnly: boolean;
  lspEnabled: boolean;
  /** The key combo bound to a keybinding action, user overrides included; "" when unbound. */
  getBinding: (actionId: string) => string;
  extensions: ExtensionContributes | null;
}

export interface AppCommand {
  /** Fixed across releases and devices: how the palette keys a row and the Assistant names it. */
  id: string;
  label: string;
  /** What the palette searches, beside the label. */
  keywords: string;
  /**
   * Whether running it changes data, settings or anything outside the screen. Declared for
   * every command: the Assistant runs one that does only after the user approves it.
   */
  changesData: boolean;
  icon: ElementType;
  hint?: string;
  /** For display, already formatted for this device. */
  shortcut?: string;
  /** The keybinding action that runs this command from the keyboard. */
  binding?: string;
  /** The palette closes before running it rather than after (it opens a dialog of its own). */
  closePaletteFirst?: boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

/** The hooks that publish commands, in the order their commands are listed. */
export const COMMAND_SOURCES = ["design", "db"] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];
export type CommandSourceLists = Partial<Record<CommandSource, readonly AppCommand[]>>;

const published = new Map<CommandSource, readonly AppCommand[]>();

/**
 * A hook's current commands, for every caller that is not the hook's own component. Returns
 * the function that withdraws them — only if they are still the ones published, so an
 * effect's cleanup cannot erase the list its next run already put in place.
 */
export function publishCommandSource(source: CommandSource, commands: readonly AppCommand[]): () => void {
  published.set(source, commands);
  return () => {
    if (published.get(source) === commands) published.delete(source);
  };
}

/** Every command visible in `ctx`, given the hook-published lists to place between the others. */
export function composeCommands(ctx: CommandContext, sources: CommandSourceLists): AppCommand[] {
  return [
    ...builtInCommands(ctx),
    ...COMMAND_SOURCES.flatMap((source) => sources[source] ?? []),
    // Whatever an extension declared, PPM cannot know what its command does.
    ...extensionCommands(ctx).map((cmd) => ({ ...cmd, changesData: true })),
  ];
}

/** Every command visible in `ctx`, with whatever the hooks last published. */
export function listCommands(ctx: CommandContext): AppCommand[] {
  return composeCommands(ctx, Object.fromEntries(published) as CommandSourceLists);
}

/** The command with `id` in `ctx`; undefined when there is none, or it is not offered there. */
export function findCommand(ctx: CommandContext, id: string): AppCommand | undefined {
  return listCommands(ctx).find((cmd) => cmd.id === id);
}

/**
 * Runs `cmd` without letting a failure escape as an unhandled rejection: what the palette and
 * the keybindings do, since neither has anyone to report a failure to but the console.
 */
export function runCommandInBackground(cmd: AppCommand, ctx: CommandContext): void {
  try {
    void Promise.resolve(cmd.run(ctx)).catch((e) => console.error(`[commands] "${cmd.id}" failed:`, e));
  } catch (e) {
    console.error(`[commands] "${cmd.id}" failed:`, e);
  }
}
