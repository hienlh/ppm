import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getPpmDir } from "../../services/ppm-dir.ts";

const logFile = () => resolve(getPpmDir(), "ppm.log");

export async function showLogs(options: { tail?: string; follow?: boolean; clear?: boolean }) {
  if (options.clear) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(logFile(), "");
    console.log("Logs cleared.");
    return;
  }

  if (!existsSync(logFile())) {
    console.log("No log file found. Start PPM daemon first.");
    return;
  }

  const lines = parseInt(options.tail ?? "50", 10);
  const content = readFileSync(logFile(), "utf-8");
  const allLines = content.split("\n");
  const lastN = allLines.slice(-lines).join("\n");

  if (!lastN.trim()) {
    console.log("Log file is empty.");
    return;
  }

  console.log(lastN);

  if (options.follow) {
    // Tail -f behavior
    const { watch } = await import("node:fs");
    let lastSize = statSync(logFile()).size;
    console.log("\n--- Following logs (Ctrl+C to stop) ---\n");

    watch(logFile(), () => {
      try {
        const newSize = statSync(logFile()).size;
        if (newSize > lastSize) {
          const fd = Bun.file(logFile());
          fd.slice(lastSize, newSize).text().then((text) => {
            process.stdout.write(text);
          });
          lastSize = newSize;
        }
      } catch {}
    });
  }
}

/** Get last N lines of log for bug reports */
export function getRecentLogs(lines = 30): string {
  if (!existsSync(logFile())) return "(no logs)";
  const content = readFileSync(logFile(), "utf-8");
  return content.split("\n").slice(-lines).join("\n").trim() || "(empty)";
}
