import type { SlashItem } from "./types.ts";

export interface BuiltinSlashCommand {
  name: string;
  summary: string;
  category: "session" | "tools" | "config";
  argumentHint?: string;
  aliases?: string[];
  /** "ppm" = PPM intercepts and executes, "sdk" = passed through to Claude SDK */
  handler: "ppm" | "sdk";
}

/** Static registry of built-in slash commands */
const BUILTIN_COMMANDS: BuiltinSlashCommand[] = [
  // PPM-executed commands (intercepted before SDK)
  { name: "skills", summary: "List available skills and their sources", category: "tools", aliases: ["sk"], handler: "ppm" },
  { name: "version", summary: "Show PPM and SDK version info", category: "session", handler: "ppm" },
  // SDK-passthrough commands (picker hints, SDK handles execution)
  { name: "help", summary: "Show available commands and skills", category: "session", handler: "sdk" },
  { name: "status", summary: "Show session status and context usage", category: "session", handler: "sdk" },
  { name: "cost", summary: "Show token usage and estimated cost", category: "session", handler: "sdk" },
  { name: "compact", summary: "Compact conversation to reduce context", category: "session", handler: "sdk" },
  { name: "model", summary: "View or change the AI model", category: "config", argumentHint: "[model-name]", handler: "sdk" },
  { name: "config", summary: "View or modify configuration", category: "config", handler: "sdk" },
  { name: "memory", summary: "View or edit AI memory", category: "config", handler: "sdk" },
];

/** Convert builtin commands to SlashItem[] for the picker */
export function getBuiltinSlashItems(): SlashItem[] {
  return BUILTIN_COMMANDS.map((cmd) => ({
    type: "builtin" as const,
    name: cmd.name,
    description: cmd.summary,
    argumentHint: cmd.argumentHint,
    scope: "bundled" as const,
    category: cmd.category,
    aliases: cmd.aliases,
  }));
}

/** Look up a builtin command by name (or alias) */
export function getBuiltinByName(name: string): BuiltinSlashCommand | undefined {
  const lower = name.toLowerCase();
  return BUILTIN_COMMANDS.find(
    (cmd) => cmd.name === lower || cmd.aliases?.includes(lower),
  );
}

/** Check if a command name is PPM-handled (not passed through to SDK) */
export function isPpmHandled(name: string): boolean {
  const cmd = getBuiltinByName(name);
  return cmd?.handler === "ppm";
}
