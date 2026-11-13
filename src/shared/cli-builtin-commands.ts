/**
 * Every top-level `ppm` command and alias `buildProgram()` registers. An extension's CLI alias
 * may never take one of these names, so no extension can shadow `ppm start` or `ppm stop`.
 * Kept here, rather than read from the program, so deciding whether `ppm <name>` is built in
 * never has to build the whole program first. A unit test keeps it equal to `buildProgram()`:
 * a new command fails that test until it is listed.
 */
export const BUILTIN_CLI_COMMANDS: readonly string[] = [
  "start", "stop", "down", "restart", "status", "open", "logs", "report", "init",
  "projects", "config", "git", "chat", "upgrade", "autostart", "cloud", "skills", "ext",
  "db", "backup", "restore", "bot", "jira", "schedule", "export",
];

/** Names Commander answers itself, on top of the registered commands. */
export const RESERVED_CLI_NAMES: readonly string[] = ["help"];

export function isBuiltinCliName(name: string): boolean {
  return BUILTIN_CLI_COMMANDS.includes(name) || RESERVED_CLI_NAMES.includes(name);
}
