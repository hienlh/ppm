#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();

program
  .name("ppm")
  .description("Personal Project Manager — mobile-first web IDE")
  .version("0.1.0");

program
  .command("start")
  .description("Start PPM server")
  .option("-p, --port <port>", "Port number", "8080")
  .option("-d, --daemon", "Run as background daemon")
  .option("-c, --config <path>", "Config file path")
  .action((_options) => {
    console.log("PPM server starting... (not yet implemented)");
  });

program
  .command("stop")
  .description("Stop PPM daemon")
  .action(() => {
    console.log("PPM server stopping... (not yet implemented)");
  });

program
  .command("open")
  .description("Open PPM web UI in browser")
  .action(() => {
    console.log("Opening PPM... (not yet implemented)");
  });

program
  .command("init")
  .description("Initialize PPM in current directory")
  .action(() => {
    console.log("PPM init... (not yet implemented)");
  });

program.parse();
