import type { Command } from "commander";
import { configService } from "../../services/config.service.ts";

export function registerAutoStartCommands(program: Command): void {
  const cmd = program
    .command("autostart")
    .description("Manage auto-start on boot (enable/disable/status)");

  cmd
    .command("enable")
    .description("Register PPM to start automatically on boot")
    .option("-p, --port <port>", "Override port")
    .option("-s, --share", "(deprecated) Tunnel is now always enabled")
    .option("--profile <name>", "DB profile name")
    .action(async (options) => {
      const { enableAutoStart } = await import("../../services/autostart-register.ts");

      configService.load();
      const port = parseInt(options.port ?? String(configService.get("port")), 10);
      const host = configService.get("host") ?? "0.0.0.0";

      const config = {
        port,
        host,
        share: !!options.share,
        profile: options.profile,
      };

      try {
        console.log("  Registering auto-start...\n");
        const servicePath = await enableAutoStart(config);
        console.log(`  ✓  Auto-start enabled`);
        console.log(`     Service: ${servicePath}`);
        console.log(`     Port: ${port}`);
        if (options.share) console.log(`     Tunnel: enabled`);
        console.log(`\n  PPM will start automatically on boot.`);

        if (process.platform === "darwin") {
          console.log(`\n  Note: On macOS Ventura+, you may need to allow PPM in`);
          console.log(`  System Settings > General > Login Items.`);
        }
        if (process.platform === "linux") {
          console.log(`\n  Note: 'loginctl enable-linger' was called to allow`);
          console.log(`  boot-time start without login.`);
        }
        console.log();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗  Failed to enable auto-start: ${msg}\n`);
        process.exit(1);
      }
    });

  cmd
    .command("disable")
    .description("Remove PPM auto-start registration")
    .action(async () => {
      const { disableAutoStart } = await import("../../services/autostart-register.ts");

      try {
        await disableAutoStart();
        console.log("  ✓  Auto-start disabled. PPM will no longer start on boot.\n");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗  Failed to disable auto-start: ${msg}\n`);
        process.exit(1);
      }
    });

  cmd
    .command("status")
    .description("Show auto-start status")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const { getAutoStartStatus } = await import("../../services/autostart-register.ts");

      const status = getAutoStartStatus();

      if (options.json) {
        console.log(JSON.stringify(status));
        return;
      }

      console.log(`\n  Auto-start status\n`);
      console.log(`  Platform:  ${status.platform}`);
      console.log(`  Enabled:   ${status.enabled ? "yes" : "no"}`);
      console.log(`  Running:   ${status.running ? "yes" : "no"}`);
      if (status.servicePath) console.log(`  Service:   ${status.servicePath}`);
      console.log(`  Details:   ${status.details}`);
      console.log();
    });
}
