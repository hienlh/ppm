import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { configService } from "../../services/config.service.ts";
import { startServer } from "../../server/index.ts";

const PID_DIR = join(homedir(), ".ppm");
const PID_FILE = join(PID_DIR, "ppm.pid");

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start PPM server")
    .option("-p, --port <port>", "Port number")
    .option("-d, --daemon", "Run as background daemon")
    .option("-c, --config <path>", "Config file path")
    .action(async (options: { port?: string; daemon?: boolean; config?: string }) => {
      const config = configService.load(options.config);

      if (options.port) {
        config.port = parseInt(options.port, 10);
      }

      if (options.daemon) {
        // Daemonize: spawn detached child and exit parent
        const scriptPath = new URL(import.meta.url).pathname;
        const args = [scriptPath.replace("/cli/commands/start.ts", "/index.ts"), "start"];
        if (options.config) args.push("-c", options.config);
        if (options.port) args.push("-p", options.port);

        const child = Bun.spawn(["bun", "run", ...args], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });

        if (!existsSync(PID_DIR)) {
          mkdirSync(PID_DIR, { recursive: true });
        }
        writeFileSync(PID_FILE, String(child.pid), "utf8");
        console.log(`PPM daemon started (PID: ${child.pid})`);
        console.log(`PID file: ${PID_FILE}`);
        process.exit(0);
      }

      const { port, stop } = startServer(config);
      console.log(`PPM server running at http://${config.host}:${port}`);
      console.log("Press Ctrl+C to stop.");

      process.on("SIGINT", () => {
        console.log("\nStopping server...");
        stop();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        stop();
        process.exit(0);
      });
    });
}
