import type { Command } from "commander";
import type { MetricsSnapshot, ProcessDetails, ProcessInfo } from "../../types/system-metrics.ts";
import { C, fail, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";
import { freshSnapshot, systemRequest } from "./system-cmd-request.ts";
import { registerSystemSignalCommands } from "./system-cmd-signals.ts";
import { registerSystemServiceCommands } from "./system-cmd-services.ts";

/**
 * `ppm system`: the Task Manager and the Services page from a terminal, through the running PPM's
 * own routes and guards. Reading the process table subscribes to the metrics stream for a moment
 * and ends that subscription before printing.
 */

type ProcessSort = "cpu" | "mem";

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Rows matching `filter` (a pid, or text in the name or command line), sorted, at most `limit`. */
export function pickProcesses(rows: readonly ProcessInfo[], sort: ProcessSort, limit: number, filter?: string): ProcessInfo[] {
  const needle = filter?.trim().toLowerCase();
  const matching = needle
    ? rows.filter((p) => String(p.pid) === needle || p.name.toLowerCase().includes(needle) || p.command.toLowerCase().includes(needle))
    : [...rows];
  matching.sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu || b.ramMB - a.ramMB : b.ramMB - a.ramMB || b.cpu - a.cpu));
  return matching.slice(0, limit);
}

function positiveInt(raw: string, what: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0) fail(`${what} must be a positive integer`);
  return n;
}

function printResources(s: MetricsSnapshot): void {
  const { cpu, mem } = s.system;
  console.log(`CPU     ${cpu.total.toFixed(1)}%  (${cpu.cores.length} cores, ${cpu.model})`);
  console.log(`Memory  ${mem.usedMB.toLocaleString()} / ${mem.totalMB.toLocaleString()} MB  (${mem.percent.toFixed(1)}%)`);
  if (mem.swapTotalMB) console.log(`Swap    ${(mem.swapUsedMB ?? 0).toLocaleString()} / ${mem.swapTotalMB.toLocaleString()} MB`);
  if (cpu.uptimeSec !== undefined) console.log(`Uptime  ${(cpu.uptimeSec / 3600).toFixed(1)} h`);
  for (const w of s.warnings) console.log(`${C.yellow}! ${w}${C.reset}`);
}

function printDetails(d: ProcessDetails): void {
  const rows: Array<[string, string | number | null]> = [
    ["PID", d.pid], ["Parent", d.ppid], ["Name", d.name],
    ["Started", d.startedAt ? new Date(d.startedAt).toLocaleString() : null],
    ["User", d.user], ["State", d.state], ["Threads", d.threads], ["Nice", d.nice],
    ["Executable", d.exe], ["Folder", d.cwd], ["Cgroup", d.cgroup], ["Command", d.command],
  ];
  for (const [label, value] of rows) console.log(`${label.padEnd(11)}${value ?? "—"}`);
}

export function registerSystemCommands(program: Command): void {
  const system = program.command("system").description("This machine's processes and services, through PPM's Task Manager");

  system
    .command("processes")
    .description("List running processes (CPU is measured between two samples, so --sort cpu takes a few seconds)")
    .option("--sort <key>", "cpu or mem", "mem")
    .option("-n, --limit <count>", "How many rows", "20")
    .option("--filter <text>", "Only processes whose pid, name or command line matches")
    .option("--json", "Print JSON")
    .action((opts: { sort: string; limit: string; filter?: string; json?: boolean }) => run(async () => {
      if (opts.sort !== "cpu" && opts.sort !== "mem") fail("--sort must be cpu or mem");
      const sort = opts.sort as ProcessSort;
      const limit = positiveInt(opts.limit, "-n");
      // The first fresh sample has no CPU to show; only a CPU sort waits for the second.
      const snapshot = await freshSnapshot("full", sort === "cpu" ? 2 : 1);
      const rows = pickProcesses(snapshot.processes, sort, limit, opts.filter);
      const cpuMeasured = sort === "cpu";
      if (opts.json) return void console.log(JSON.stringify({ sort, cpuMeasured, total: snapshot.processes.length, processes: rows }, null, 2));
      const headers = cpuMeasured ? ["PID", "Name", "CPU %", "RAM MB", "Command"] : ["PID", "Name", "RAM MB", "Command"];
      printTable(headers, rows.map((p) => [
        String(p.pid), p.name + (p.protected ? " *" : ""),
        ...(cpuMeasured ? [p.cpu.toFixed(1)] : []), p.ramMB.toFixed(0), shorten(p.command, 60),
      ]));
      console.log(`${C.dim}${rows.length} of ${snapshot.processes.length} processes. * = PPM refuses to end it.${cpuMeasured ? "" : " Use --sort cpu for CPU."}${C.reset}`);
    })());

  system
    .command("process <pid>")
    .description("Show one process: command line, folder, user, state")
    .option("--json", "Print JSON")
    .action((pid: string, opts: { json?: boolean }) => run(async () => {
      const details = await systemRequest<ProcessDetails>("GET", `/resources/process/${positiveInt(pid, "PID")}`);
      if (opts.json) return void console.log(JSON.stringify(details, null, 2));
      printDetails(details);
    })());

  registerSystemSignalCommands(system);

  system
    .command("resources")
    .description("CPU, memory and swap of this machine right now (takes a few seconds to measure CPU)")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const snapshot = await freshSnapshot("light", 2);
      if (opts.json) return void console.log(JSON.stringify({ ts: snapshot.ts, platform: snapshot.platform, ...snapshot.system, warnings: snapshot.warnings }, null, 2));
      printResources(snapshot);
    })());

  registerSystemServiceCommands(system);
}
