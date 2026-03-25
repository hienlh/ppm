import { VERSION } from "../../version.ts";
import {
  checkForUpdate,
  applyUpgrade,
  getInstallMethod,
  signalSupervisorUpgrade,
} from "../../services/upgrade.service.ts";

export async function upgradeCmd(options: { check?: boolean }) {
  const method = getInstallMethod();

  if (method === "binary") {
    console.log("  Compiled binary detected — download new version from GitHub releases.");
    process.exit(0);
  }

  const update = await checkForUpdate();

  if (options.check) {
    if (update.available) {
      console.log(`  Update available: v${update.current} → v${update.latest}`);
    } else {
      console.log(`  Already on latest version (v${VERSION})`);
    }
    process.exit(0);
  }

  if (!update.available) {
    console.log(`  Already on latest version (v${VERSION})`);
    process.exit(0);
  }

  console.log(`  Upgrading from v${update.current} to v${update.latest}...`);
  const result = await applyUpgrade();

  if (!result.success) {
    console.error(`  ✗  Upgrade failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`  ✓  Upgraded to v${result.newVersion}`);

  const signal = signalSupervisorUpgrade();
  if (signal.sent) {
    console.log("  Restarting PPM...");
  } else {
    console.log("  Restart PPM manually with `ppm restart`");
  }
}
