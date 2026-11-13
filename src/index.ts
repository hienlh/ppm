#!/usr/bin/env bun
// PPM CLI entry point — Bun runtime, Hono backend, React frontend, Claude Agent SDK for AI chat
import { Command } from "commander";
import { VERSION } from "./version.ts";
import { isMachineFacing } from "./cli/utils/machine-facing-commands.ts";

/**
 * Assemble the CLI program without parsing argv. Exported so build-time tools
 * (e.g. scripts/generate-ppm-skill.ts) can introspect the Commander tree for
 * auto-generated documentation. `preAction` hooks and action callbacks are
 * registered but not invoked until `.parseAsync()` runs.
 */
export async function buildProgram(): Promise<Command> {
  const program = new Command();

  program
    .name("ppm")
    .description("Personal Project Manager — mobile-first web IDE")
    .version(VERSION)
    .hook("preAction", (_program, actionCommand) => {
      // `--json` output is parsed (by scripts, by the Assistant, and by the AI agents the PPM
      // skill points here), and one banner line in front makes the whole of it unparseable. The
      // same holds for a command whose stdout is always data (`ppm ext run`, an extension alias).
      if (actionCommand.opts().json || isMachineFacing(actionCommand)) return;
      console.log(`  PPM v${VERSION}\n`);
    });

  program
    .command("start")
    .description("Start the PPM server (background by default)")
    .option("--minimal", "Minimal workspace: chat, files, editor and settings")
    .option("-p, --port <port>", "Port to listen on")
    .option("-s, --share", "(deprecated) Tunnel is now always enabled")
    .option("--profile <name>", "DB profile name (e.g. 'dev' → ppm.dev.db)")
    .action(async (options) => {
      const { getDbProfile, setDbProfile } = await import("./services/db.service.ts");
      const { commandProfile } = await import("./cli/utils/profile-argv.ts");
      // `start --profile dev`, or the profile chosen before the command (`ppm --profile dev start`,
      // PPM_PROFILE); naming two different ones is an error.
      let profile: string | null;
      try {
        profile = commandProfile(options.profile, getDbProfile());
      } catch (e) {
        console.error(`  ✗  ${(e as Error).message}`);
        process.exit(1);
      }
      if (profile !== getDbProfile()) setDbProfile(profile);
      options.profile = profile ?? undefined;
      const { hasConfig, initProject } = await import("./cli/commands/init.ts");
      if (!hasConfig()) {
        await initProject();
      }
      const { startServer } = await import("./server/index.ts");
      await startServer(options);
    });

  program
    .command("stop")
    .description("Stop the PPM server (supervisor stays alive)")
    .option("-a, --all", "Kill all PPM and cloudflared processes (including untracked)")
    .option("--kill", "Full shutdown (kills supervisor too)")
    .action(async (options) => {
      if (!options.all) await (await import("./cli/utils/supervised-profile-check.ts")).exitUnlessSupervisedProfile();
      const { stopServer } = await import("./cli/commands/stop.ts");
      await stopServer(options);
    });

  program
    .command("down")
    .description("Fully shut down PPM (supervisor + server + tunnel)")
    .action(async () => {
      await (await import("./cli/utils/supervised-profile-check.ts")).exitUnlessSupervisedProfile();
      const { stopServer } = await import("./cli/commands/stop.ts");
      await stopServer({ kill: true });
    });

  program
    .command("restart")
    .description("Restart the server (keeps tunnel alive)")
    .option("--force", "Force resume from paused state")
    .action(async (options) => {
      await (await import("./cli/utils/supervised-profile-check.ts")).exitUnlessSupervisedProfile();
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
    .action(async () => {
      const { openBrowser } = await import("./cli/commands/open.ts");
      await openBrowser();
    });

  const logs = program
    .command("logs")
    .description("View PPM daemon logs")
    .option("-n, --tail <lines>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output")
    .option("-l, --level <level>", "Only this level and above: debug, info, warn, error, fatal")
    .option("--clear", "Clear log file")
    .action(async (options) => {
      const { showLogs } = await import("./cli/commands/logs.ts");
      await showLogs(options);
    });
  const { registerLogsSubcommands } = await import("./cli/commands/logs-issues-cmd.ts");
  registerLogsSubcommands(logs);

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

  const { registerCommandGroups, registerLaterCommandGroups } = await import("./cli/register-command-groups.ts");
  await registerCommandGroups(program);

  program
    .command("upgrade")
    .description("Check for and install PPM updates")
    .option("--check", "Only check for updates, don't install")
    .action(async (options) => {
      const { upgradeCmd } = await import("./cli/commands/upgrade.ts");
      await upgradeCmd(options);
    });

  await registerLaterCommandGroups(program);

  return program;
}

/**
 * Decide how this process entry should behave from argv.
 *
 * Compiled binaries have no source files to run, so the supervisor and server
 * daemon children re-invoke the binary itself as `<bin> __supervise__ …` /
 * `<bin> __serve__ …`. Those must be routed to the daemon modules (whose
 * top-level guards read the sentinel from argv) instead of the Commander CLI,
 * which would reject them as unknown commands. Source installs spawn the
 * `.ts` files directly and never reach this entry with a sentinel.
 */
export function resolveEntryMode(
  argv: string[],
): "supervise" | "serve" | "edge" | "share-host" | "cli" {
  if (argv.includes("__supervise__")) return "supervise";
  if (argv.includes("__serve__")) return "serve";
  if (argv.includes("__edge__")) return "edge";
  if (argv.includes("__share_host__")) return "share-host";
  return "cli";
}

if (import.meta.main) {
  // Windows: no child may inherit this process's sockets (see the module). Every mode
  // spawns something — the CLI the supervisor, the supervisor the server and the tunnel.
  (await import("./services/windows-socket-inheritance.ts")).installSpawnHandleGuard();
  switch (resolveEntryMode(process.argv)) {
    case "supervise":
      await import("./services/supervisor.ts");
      break;
    case "serve":
      await import("./server/index.ts");
      break;
    case "edge":
      await import("./services/edge-forwarder.ts");
      break;
    case "share-host":
      await import("./services/share-host/share-host-worker.ts");
      break;
    default: {
      // A command's stdout is its output (`--json`, a pipe): log lines go to stderr.
      const { sendConsoleLogsToStderr } = await import("./services/logger.ts");
      sendConsoleLogsToStderr();
      // Which database this command works on, set before anything opens one.
      const { applyCliProfile } = await import("./cli/utils/apply-cli-profile.ts");
      const argv = await applyCliProfile(process.argv);
      const program = await buildProgram();
      // Extension-contributed `ppm <name>` commands; skipped for every built-in command.
      const { shouldLoadAliases, registerExtensionCliAliases } = await import("./cli/commands/extension-cli-alias-cmd.ts");
      if (shouldLoadAliases(argv)) await registerExtensionCliAliases(program);
      program.parse(argv);
    }
  }
}
