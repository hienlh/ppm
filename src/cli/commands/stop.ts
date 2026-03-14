import type { Command } from "commander";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PID_FILE = join(homedir(), ".ppm", "ppm.pid");

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop PPM daemon")
    .action(() => {
      if (!existsSync(PID_FILE)) {
        console.log("PPM daemon is not running (no PID file found).");
        process.exit(1);
      }

      const pidStr = readFileSync(PID_FILE, "utf8").trim();
      const pid = parseInt(pidStr, 10);

      if (isNaN(pid)) {
        console.error("Invalid PID file contents.");
        unlinkSync(PID_FILE);
        process.exit(1);
      }

      try {
        process.kill(pid, "SIGTERM");
        unlinkSync(PID_FILE);
        console.log(`PPM daemon stopped (PID: ${pid}).`);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          console.log("PPM daemon was not running. Cleaning up PID file.");
          unlinkSync(PID_FILE);
        } else {
          console.error(`Failed to stop daemon: ${err}`);
          process.exit(1);
        }
      }
    });
}
