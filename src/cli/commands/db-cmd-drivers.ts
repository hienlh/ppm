import type { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { LONG_REQUEST_TIMEOUT_MS } from "../utils/request-progress.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm db driver`: the drivers some connections need (MySQL / MariaDB, SSH tunnels), through
 * `/api/db/drivers` — so the running PPM installs it and can use it at once. A driver is named by
 * its **id** from PPM's fixed catalog; no request names a package, a version or a registry.
 */

interface DriverRow {
  id: string; displayName: string; usedFor: string; package: string; version: string;
  state: "installed" | "outdated" | "missing"; installed?: { version: string; bytes?: number } | null;
}

const LONG = {
  timeoutMs: LONG_REQUEST_TIMEOUT_MS, progress: true,
  timeoutHint: "PPM keeps installing in the background; check with `ppm db driver list`.",
};

function stateOf(d: DriverRow): string {
  if (d.state === "installed") return "installed";
  if (d.state === "outdated") return `outdated (${d.installed?.version ?? "?"})`;
  return "not installed";
}

export function registerDbDriverCommands(db: Command): void {
  const driver = db.command("driver").description("Install or remove the drivers some connections need (MySQL / MariaDB, SSH tunnels)");

  driver.command("list")
    .description("List database drivers and whether each is installed")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const drivers = await ppmApiRequest<DriverRow[]>("GET", "/db/drivers");
      if (opts.json) return void console.log(JSON.stringify(drivers, null, 2));
      printTable(["ID", "Driver", "For", "Package", "Status"],
        drivers.map((d) => [d.id, d.displayName, d.usedFor, `${d.package}@${d.version}`, stateOf(d)]));
    })());

  driver.command("install <id>")
    .description("Download and install a database driver (e.g. mysql)")
    .action((id: string) => run(async () => {
      console.log(`${C.cyan}Installing${C.reset} the ${id} driver...`);
      const done = await ppmApiRequest<DriverRow>("POST", `/db/drivers/${encodeURIComponent(id)}/install`, {}, LONG);
      console.log(`${C.green}✓${C.reset} Installed ${done.package}@${done.installed?.version ?? done.version}`);
    })());

  driver.command("remove <id>")
    .description("Remove an installed database driver")
    .action((id: string) => run(async () => {
      const drivers = await ppmApiRequest<DriverRow[]>("GET", "/db/drivers");
      const current = drivers.find((d) => d.id === id);
      if (current?.state === "missing") return void console.log(`${C.dim}The ${current.displayName} driver is not installed.${C.reset}`);
      await ppmApiRequest<DriverRow>("DELETE", `/db/drivers/${encodeURIComponent(id)}`, undefined, { timeoutMs: 120_000 });
      console.log(`${C.green}Removed${C.reset} the ${current?.displayName ?? id} driver. A PPM that already loaded it keeps using it until restarted.`);
    })());
}
