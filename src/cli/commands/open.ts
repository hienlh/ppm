import type { Command } from "commander";
import { configService } from "../../services/config.service.ts";

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Open PPM web UI in browser")
    .option("-c, --config <path>", "Config file path")
    .action((options: { config?: string }) => {
      const config = configService.load(options.config);
      const host = config.host === "0.0.0.0" ? "localhost" : config.host;
      const url = `http://${host}:${config.port}`;

      console.log(`Opening ${url} ...`);

      const platform = process.platform;
      let cmd: string;
      let args: string[];

      if (platform === "darwin") {
        cmd = "open";
        args = [url];
      } else if (platform === "win32") {
        cmd = "cmd";
        args = ["/c", "start", url];
      } else {
        cmd = "xdg-open";
        args = [url];
      }

      Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] });
    });
}
