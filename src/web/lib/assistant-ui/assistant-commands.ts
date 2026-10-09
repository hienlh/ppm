/**
 * The device half of the PPM Assistant's command tools: listing the command registry as this
 * device sees it, and running one command from it. Only ids in the registry run — the same
 * commands, under the same visibility rules, as the command palette offers here.
 *
 * Whether a command changes data is the registry's declaration, reported to the server by
 * `list_commands`; the server asks the user before it asks for such a command to run. This side
 * enforces the same rule again: a command that changes data runs only with the approval the
 * server attached, and only if it is still the command the user approved.
 */
import {
  MAX_ASSISTANT_COMMAND_ID_CHARS, MAX_ASSISTANT_COMMANDS_LISTED,
  type AssistantCommandEntry, type AssistantListCommandsResult, type AssistantRunCommandResult,
} from "../../../shared/assistant-ui-protocol";
import { findCommand, listCommands, type AppCommand } from "@/lib/commands/command-registry";
import { readCommandContext } from "@/lib/commands/read-command-context";

const MAX_QUERY_CHARS = 200;

function entry(cmd: AppCommand): AssistantCommandEntry {
  return {
    id: cmd.id,
    label: cmd.label,
    ...(cmd.hint ? { hint: cmd.hint } : {}),
    ...(cmd.shortcut ? { shortcut: cmd.shortcut } : {}),
    changesData: cmd.changesData,
  };
}

/** Every word of `query` appears in the command's id, label, hint or keywords. */
function matches(cmd: AppCommand, words: string[]): boolean {
  const text = `${cmd.id} ${cmd.label} ${cmd.hint ?? ""} ${cmd.keywords}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

function commandId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_ASSISTANT_COMMAND_ID_CHARS) {
    throw new Error("`id` must be a command id from list_commands.");
  }
  return value;
}

export function listAssistantCommands(args: Record<string, unknown>): AssistantListCommandsResult {
  const ctx = readCommandContext();
  let commands = listCommands(ctx);
  if (args.id !== undefined) {
    const id = commandId(args.id);
    commands = commands.filter((cmd) => cmd.id === id);
  } else if (typeof args.query === "string" && args.query.trim()) {
    const words = args.query.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean);
    commands = commands.filter((cmd) => matches(cmd, words));
  }
  return {
    project: ctx.project?.name ?? null,
    commands: commands.slice(0, MAX_ASSISTANT_COMMANDS_LISTED).map(entry),
    total: commands.length,
  };
}

export async function runAssistantCommand(args: Record<string, unknown>): Promise<AssistantRunCommandResult> {
  const id = commandId(args.id);
  const ctx = readCommandContext();
  const cmd = findCommand(ctx, id);
  if (!cmd) throw new Error(`No command "${id}" is offered on this device right now; list them with list_commands.`);
  if (cmd.changesData) {
    if (args.approved !== true) throw new Error(`"${cmd.label}" changes data and runs only once the user approved it.`);
    if (args.approvedLabel !== cmd.label) {
      throw new Error(`"${id}" is no longer the command the user approved (it is now "${cmd.label}"); nothing was run.`);
    }
  }
  await cmd.run(ctx);
  return { ran: true, id: cmd.id, label: cmd.label, project: ctx.project?.name ?? null };
}
