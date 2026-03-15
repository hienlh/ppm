import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";

const LOG_FILE = resolve(homedir(), ".ppm", "ppm.log");

export async function showLogs(options: { tail?: string; follow?: boolean; clear?: boolean }) {
  if (options.clear) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(LOG_FILE, "");
    console.log("Logs cleared.");
    return;
  }

  if (!existsSync(LOG_FILE)) {
    console.log("No log file found. Start PPM daemon first.");
    return;
  }

  const lines = parseInt(options.tail ?? "50", 10);
  const content = readFileSync(LOG_FILE, "utf-8");
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
    let lastSize = statSync(LOG_FILE).size;
    console.log("\n--- Following logs (Ctrl+C to stop) ---\n");

    watch(LOG_FILE, () => {
      try {
        const newSize = statSync(LOG_FILE).size;
        if (newSize > lastSize) {
          const fd = Bun.file(LOG_FILE);
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
  if (!existsSync(LOG_FILE)) return "(no logs)";
  const content = readFileSync(LOG_FILE, "utf-8");
  return content.split("\n").slice(-lines).join("\n").trim() || "(empty)";
}
