import { Command } from "commander";
import { registerInitCommand } from "./commands/init.ts";
import { registerStartCommand } from "./commands/start.ts";
import { registerStopCommand } from "./commands/stop.ts";
import { registerOpenCommand } from "./commands/open.ts";

export function createCli(): Command {
  const program = new Command();

  program
    .name("ppm")
    .description("Personal Project Manager — mobile-first web IDE")
    .version("0.1.0");

  registerInitCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerOpenCommand(program);

  return program;
}
