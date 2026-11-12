import type { Command } from "commander";

/**
 * The `ppm` command groups that live in their own files, registered in the order `--help` lists
 * them. `buildProgram()` (src/index.ts) adds the process commands around them; the CLI reference
 * generator walks the tree both build.
 */
export async function registerCommandGroups(program: Command): Promise<void> {
  const { registerProjectsCommands } = await import("./commands/projects.ts");
  registerProjectsCommands(program);

  const { registerConfigCommands } = await import("./commands/config-cmd.ts");
  registerConfigCommands(program);

  const { registerGitCommands } = await import("./commands/git-cmd.ts");
  registerGitCommands(program);

  const { registerChatCommands } = await import("./commands/chat-cmd.ts");
  registerChatCommands(program);

  const { registerTagsCommands } = await import("./commands/tags-cmd.ts");
  registerTagsCommands(program);
}

/** The groups `--help` lists after `upgrade`. */
export async function registerLaterCommandGroups(program: Command): Promise<void> {
  const { registerAutoStartCommands } = await import("./commands/autostart.ts");
  registerAutoStartCommands(program);

  const { registerCloudCommands } = await import("./commands/cloud.ts");
  registerCloudCommands(program);

  const { registerSkillsCommands } = await import("./commands/skills-cmd.ts");
  registerSkillsCommands(program);

  const { registerExtCommands } = await import("./commands/ext-cmd.ts");
  registerExtCommands(program);

  const { registerDbCommands } = await import("./commands/db-cmd.ts");
  registerDbCommands(program);

  const { registerBackupCommands } = await import("./commands/backup-cmd.ts");
  registerBackupCommands(program);

  const { registerJiraCommands } = await import("./commands/jira-cmd.ts");
  await registerJiraCommands(program);

  const { registerScheduleCommands } = await import("./commands/schedule-cmd.ts");
  registerScheduleCommands(program);

  const { registerExportCommands } = await import("./commands/export-cmd.ts");
  registerExportCommands(program);
}
