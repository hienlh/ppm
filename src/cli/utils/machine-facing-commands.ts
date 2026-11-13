import type { Command } from "commander";

/**
 * Commands whose stdout is data for another program (`ppm ext run`, every extension alias), so
 * the `PPM vX` banner every other command prints first must not go there: it would turn
 * `ppm midday list --json` into something no JSON parser accepts. A new `--json` command should
 * be added here too.
 */
const machineFacing = new WeakSet<Command>();

export function markMachineFacing(command: Command): Command {
  machineFacing.add(command);
  return command;
}

export function isMachineFacing(command: Command | undefined): boolean {
  return !!command && machineFacing.has(command);
}
