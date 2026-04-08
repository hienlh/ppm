import type { Command } from "commander";

export function registerCloudCommands(program: Command): void {
  const cmd = program
    .command("cloud")
    .description("PPM Cloud — device registry + tunnel URL sync");

  cmd
    .command("login")
    .description("Sign in with Google")
    .option("--url <url>", "Cloud URL override")
    .option("--device-code", "Force device code flow (for remote terminals)")
    .action(async (options) => {
      const {
        startLoginServer,
        startDeviceCodeLogin,
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

        // Auto-link if not yet linked
        const { getCloudDevice, linkDevice } = await import("../../services/cloud.service.ts");
        if (!getCloudDevice()) {
          try {
            const device = await linkDevice();
            console.log(`  ✓  Machine linked: ${device.name}\n`);
          } catch (linkErr: unknown) {
            const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr);
            console.warn(`  ⚠  Auto-link failed: ${linkMsg}`);
          }
        } else {
          console.log(`  Run 'ppm cloud logout' to switch accounts.`);
        }
        console.log();
        return;
      }

      try {
        let auth;

        // Use device code flow if: forced by flag, running in SSH/PPM terminal, or no display
        const useDeviceCode = options.deviceCode || !process.env.DISPLAY && process.platform === "linux"
          || process.env.PPM_TERMINAL === "1";

        if (useDeviceCode) {
          auth = await startDeviceCodeLogin(cloudUrl);
        } else {
          // Try browser flow, fall back to device code on failure
          try {
            auth = await startLoginServer(cloudUrl);
          } catch {
            console.log("  Browser login failed, switching to device code flow...\n");
            auth = await startDeviceCodeLogin(cloudUrl);
          }
        }

        console.log(`\n  ✓  Logged in as ${auth.email}`);

        // Auto-link device after login
        try {
          const { linkDevice } = await import("../../services/cloud.service.ts");
          const device = await linkDevice();
          console.log(`  ✓  Machine linked: ${device.name}`);
        } catch (linkErr: unknown) {
          const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr);
          console.warn(`  ⚠  Auto-link failed: ${linkMsg}`);
        }
        console.log();
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
      const { removeCloudAuth, getCloudAuth, unlinkDevice, getCloudDevice } = await import(
        "../../services/cloud.service.ts"
      );

      const auth = getCloudAuth();
      if (!auth) {
        console.log(`  Not logged in.\n`);
        return;
      }

      // Auto-unlink device before removing auth
      if (getCloudDevice()) {
        try {
          await unlinkDevice();
          console.log(`  ✓  Machine unlinked`);
        } catch {
          // Non-blocking — still logout even if unlink fails
        }
      }

      removeCloudAuth();
      console.log(`  ✓  Logged out (was: ${auth.email})\n`);
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
        if (auth) console.log(`  Run 'ppm cloud login' to re-link this machine.`);
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
