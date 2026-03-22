import type { Command } from "commander";

export function registerCloudCommands(program: Command): void {
  const cmd = program
    .command("cloud")
    .description("PPM Cloud — device registry + tunnel URL sync");

  cmd
    .command("login")
    .description("Sign in with Google (opens browser)")
    .option("--url <url>", "Cloud URL override")
    .action(async (options) => {
      const {
        startLoginServer,
        getCloudAuth,
        DEFAULT_CLOUD_URL,
      } = await import("../../services/cloud.service.ts");
      const { configService } = await import("../../services/config.service.ts");

      const cloudUrl =
        options.url ||
        configService.get("cloud_url") ||
        DEFAULT_CLOUD_URL;

      // Check if already logged in
      const existing = getCloudAuth();
      if (existing) {
        console.log(`  Already logged in as ${existing.email}`);
        console.log(`  Run 'ppm cloud logout' to switch accounts.\n`);
        return;
      }

      try {
        const auth = await startLoginServer(cloudUrl);
        console.log(`  ✓  Logged in as ${auth.email}\n`);
        console.log(`  Next: run 'ppm cloud link' to register this machine.\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗  Login failed: ${msg}\n`);
        process.exit(1);
      }
    });

  cmd
    .command("logout")
    .description("Sign out from PPM Cloud")
    .action(async () => {
      const { removeCloudAuth, getCloudAuth } = await import(
        "../../services/cloud.service.ts"
      );

      const auth = getCloudAuth();
      removeCloudAuth();
      if (auth) {
        console.log(`  ✓  Logged out (was: ${auth.email})\n`);
      } else {
        console.log(`  Not logged in.\n`);
      }
    });

  cmd
    .command("link")
    .description("Register this machine with PPM Cloud")
    .option("-n, --name <name>", "Machine display name")
    .action(async (options) => {
      const { linkDevice } = await import("../../services/cloud.service.ts");

      try {
        const device = await linkDevice(options.name);
        console.log(`  ✓  Machine linked`);
        console.log(`     Name: ${device.name}`);
        console.log(`     ID: ${device.device_id}`);
        console.log(`\n  Run 'ppm start --share' to sync tunnel URL to cloud.\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗  Link failed: ${msg}\n`);
        process.exit(1);
      }
    });

  cmd
    .command("unlink")
    .description("Remove this machine from PPM Cloud")
    .action(async () => {
      const { unlinkDevice, getCloudDevice } = await import(
        "../../services/cloud.service.ts"
      );

      const device = getCloudDevice();
      if (!device) {
        console.log(`  Not linked to cloud.\n`);
        return;
      }

      try {
        await unlinkDevice();
        console.log(`  ✓  Machine unlinked (was: ${device.name})\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗  Unlink failed: ${msg}\n`);
        process.exit(1);
      }
    });

  cmd
    .command("status")
    .description("Show PPM Cloud connection status")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const { getCloudAuth, getCloudDevice } = await import(
        "../../services/cloud.service.ts"
      );

      const auth = getCloudAuth();
      const device = getCloudDevice();

      if (options.json) {
        console.log(
          JSON.stringify({
            logged_in: !!auth,
            email: auth?.email ?? null,
            cloud_url: auth?.cloud_url ?? null,
            linked: !!device,
            device_name: device?.name ?? null,
            device_id: device?.device_id ?? null,
          }),
        );
        return;
      }

      console.log(`\n  PPM Cloud status\n`);

      if (auth) {
        console.log(`  Logged in:  ${auth.email}`);
        console.log(`  Cloud URL:  ${auth.cloud_url}`);
      } else {
        console.log(`  Logged in:  no`);
        console.log(`  Run 'ppm cloud login' to sign in.`);
      }

      if (device) {
        console.log(`  Machine:    ${device.name} (${device.device_id.slice(0, 8)}...)`);
        console.log(`  Linked at:  ${device.linked_at}`);
      } else {
        console.log(`  Machine:    not linked`);
        if (auth) console.log(`  Run 'ppm cloud link' to register this machine.`);
      }

      console.log();
    });

  cmd
    .command("devices")
    .description("List all registered devices from cloud")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const { listDevices } = await import("../../services/cloud.service.ts");

      try {
        const devices = await listDevices();

        if (options.json) {
          console.log(JSON.stringify({ devices }));
          return;
        }

        if (devices.length === 0) {
          console.log(`  No devices registered.\n`);
          return;
        }

        console.log(`\n  PPM Cloud devices (${devices.length})\n`);
        for (const d of devices) {
          const status = d.computedStatus === "online" ? "● online " : "○ offline";
          const url = d.tunnelUrl || "(no tunnel)";
          const lastSeen = d.lastHeartbeat
            ? new Date(d.lastHeartbeat).toLocaleString()
            : "never";
          console.log(`  ${d.name}`);
          console.log(`    Status:    ${status}`);
          console.log(`    Tunnel:    ${url}`);
          console.log(`    Last seen: ${lastSeen}`);
          console.log(`    Version:   ${d.version || "unknown"}`);
          console.log();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗  Failed: ${msg}\n`);
        process.exit(1);
      }
    });
}
