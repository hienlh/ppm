#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();

program
  .name("ppm")
  .description("Personal Project Manager — mobile-first web IDE")
  .version("0.1.0");

program
  .command("start")
  .description("Start the PPM server")
  .option("-p, --port <port>", "Port to listen on")
  .option("-d, --daemon", "Run as background daemon")
  .option("-c, --config <path>", "Path to config file")
  .action(async (options) => {
    const { startServer } = await import("./server/index.ts");
    await startServer(options);
  });

program
  .command("stop")
  .description("Stop the PPM daemon")
  .action(async () => {
    const { stopServer } = await import("./cli/commands/stop.ts");
    await stopServer();
  });

program
  .command("open")
  .description("Open PPM in browser")
  .option("-c, --config <path>", "Path to config file")
  .action(async () => {
    const { openBrowser } = await import("./cli/commands/open.ts");
    await openBrowser();
  });

program
  .command("init")
  .description("Initialize PPM configuration — scan for git repos, create config")
  .action(async () => {
    const { initProject } = await import("./cli/commands/init.ts");
    await initProject();
  });

const { registerProjectsCommands } = await import("./cli/commands/projects.ts");
registerProjectsCommands(program);

const { registerConfigCommands } = await import("./cli/commands/config-cmd.ts");
registerConfigCommands(program);

const { registerGitCommands } = await import("./cli/commands/git-cmd.ts");
registerGitCommands(program);

const { registerChatCommands } = await import("./cli/commands/chat-cmd.ts");
registerChatCommands(program);

program.parse();
