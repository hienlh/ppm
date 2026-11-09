/**
 * Summarise the memory monitor's log: how fast private bytes grew in each recent run, which
 * spawned commands went with that growth, and which gauges climbed.
 *
 *   bun scripts/mem-diag-report.ts                     # <ppm dir>/mem-diag.log, last 3 runs
 *   bun scripts/mem-diag-report.ts --supervisor        # mem-diag-supervisor.log
 *   bun scripts/mem-diag-report.ts --edge              # mem-diag-edge.log
 *   bun scripts/mem-diag-report.ts path/to/log --runs 5
 *
 * Read-only: it opens the log file and nothing else (no database).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPpmDir } from "../src/services/ppm-dir.ts";
import { buildReport } from "../src/services/memory-diagnostics-report.ts";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 3) : 3;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--runs");
const file = positional[0]
  ?? join(getPpmDir(), args.includes("--supervisor") ? "mem-diag-supervisor.log"
    : args.includes("--edge") ? "mem-diag-edge.log" : "mem-diag.log");

if (!existsSync(file)) {
  console.error(`No log at ${file}. The monitor writes it only while PPM_MEM_DIAG=1 is set.`);
  process.exit(1);
}
const text = [`${file}.1`, file].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
console.log(`${file}`);
for (const line of buildReport(text, runs)) console.log(line);
