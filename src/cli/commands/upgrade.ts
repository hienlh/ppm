import { VERSION } from "../../version.ts";
import { getPpmDir } from "../../services/ppm-dir.ts";
import { recordRestartCaller } from "../../services/restart-news/restart-caller.ts";
import {
  checkForUpdate,
  applyUpgrade,
  signalSupervisorUpgrade,
} from "../../services/upgrade.service.ts";

export async function upgradeCmd(options: { check?: boolean }) {
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

  // Only an upgrade that restarts PPM is recorded; `--check` and "already latest" stop above.
  const signal = signalSupervisorUpgrade(await recordRestartCaller(getPpmDir(), "upgrade"));
  if (signal.sent) {
    console.log("  Restarting PPM...");
  } else {
    console.log("  Restart PPM manually with `ppm restart`");
  }
}
