#!/usr/bin/env bun
import { Command } from "commander";
import { VERSION } from "./version.ts";

const program = new Command();

program
  .name("ppm")
  .description("Personal Project Manager — mobile-first web IDE")
  .version(VERSION);

program
  .command("start")
  .description("Start the PPM server (background by default)")
  .option("-p, --port <port>", "Port to listen on")
  .option("-f, --foreground", "Run in foreground (default: background daemon)")
  .option("-d, --daemon", "Run as background daemon (default, kept for compat)")
  .option("-s, --share", "Share via public URL (Cloudflare tunnel)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (options) => {
    // Auto-init on first run
    const { hasConfig, initProject } = await import("./cli/commands/init.ts");
    if (!hasConfig()) {
      await initProject();
    }
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
  .command("restart")
  .description("Restart the server (keeps tunnel alive)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (options) => {
    const { restartServer } = await import("./cli/commands/restart.ts");
    await restartServer(options);
  });

program
  .command("status")
  .description("Show PPM daemon status")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const { showStatus } = await import("./cli/commands/status.ts");
    await showStatus(options);
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
  .command("logs")
  .description("View PPM daemon logs")
  .option("-n, --tail <lines>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output")
  .option("--clear", "Clear log file")
  .action(async (options) => {
    const { showLogs } = await import("./cli/commands/logs.ts");
    await showLogs(options);
  });

program
  .command("report")
  .description("Report a bug on GitHub (pre-fills env info + logs)")
  .action(async () => {
    const { reportBug } = await import("./cli/commands/report.ts");
    await reportBug();
  });

program
  .command("init")
  .description("Initialize PPM configuration (interactive or via flags)")
  .option("-p, --port <port>", "Port to listen on")
  .option("--scan <path>", "Directory to scan for git repos")
  .option("--auth", "Enable authentication")
  .option("--no-auth", "Disable authentication")
  .option("--password <pw>", "Set access password")
  .option("--share", "Pre-install cloudflared for sharing")
  .option("-y, --yes", "Non-interactive mode (use defaults + flags)")
  .action(async (options) => {
    const { initProject } = await import("./cli/commands/init.ts");
    await initProject(options);
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
