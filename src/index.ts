#!/usr/bin/env bun
// PPM CLI entry point — Bun runtime, Hono backend, React frontend, Claude Agent SDK for AI chat
import { Command } from "commander";
import { VERSION } from "./version.ts";

const program = new Command();

program
  .name("ppm")
  .description("Personal Project Manager — mobile-first web IDE")
  .version(VERSION)
  .hook("preAction", () => {
    console.log(`  PPM v${VERSION}\n`);
  });

program
  .command("start")
  .description("Start the PPM server (background by default)")
  .option("-p, --port <port>", "Port to listen on")
  .option("-s, --share", "(deprecated) Tunnel is now always enabled")
  .option("-c, --config <path>", "Path to config file (YAML import into DB)")
  .option("--profile <name>", "DB profile name (e.g. 'dev' → ppm.dev.db)")
  .action(async (options) => {
    // Set DB profile before any DB access
    const { setDbProfile } = await import("./services/db.service.ts");
    if (options.profile) {
      setDbProfile(options.profile);
    } else if (options.config && /dev/i.test(options.config)) {
      setDbProfile("dev");
    }
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
  .option("-a, --all", "Kill all PPM and cloudflared processes (including untracked)")
  .action(async (options) => {
    const { stopServer } = await import("./cli/commands/stop.ts");
    await stopServer(options);
  });

program
  .command("restart")
  .description("Restart the server (keeps tunnel alive)")
  .option("-c, --config <path>", "Path to config file")
  .option("--force", "Force resume from paused state")
  .action(async (options) => {
    const { restartServer } = await import("./cli/commands/restart.ts");
    await restartServer(options);
  });

program
  .command("status")
  .description("Show PPM daemon status")
  .option("-a, --all", "Show all PPM and cloudflared processes (including untracked)")
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

program
  .command("upgrade")
  .description("Check for and install PPM updates")
  .option("--check", "Only check for updates, don't install")
  .action(async (options) => {
    const { upgradeCmd } = await import("./cli/commands/upgrade.ts");
    await upgradeCmd(options);
  });

const { registerAutoStartCommands } = await import("./cli/commands/autostart.ts");
registerAutoStartCommands(program);

const { registerCloudCommands } = await import("./cli/commands/cloud.ts");
registerCloudCommands(program);

const { registerExtCommands } = await import("./cli/commands/ext-cmd.ts");
registerExtCommands(program);

program.parse();
