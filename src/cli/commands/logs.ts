import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getPpmDir } from "../../services/ppm-dir.ts";
import { createLogLineFilter, filterLogLines, LOG_LEVELS, parseLogLevel } from "../../shared/log-levels.ts";
import { redactForBugReport } from "../../services/redact-secrets.ts";

const logFile = () => resolve(getPpmDir(), "ppm.log");

export async function showLogs(options: { tail?: string; follow?: boolean; clear?: boolean; level?: string }) {
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

  const minLevel = options.level === undefined ? null : parseLogLevel(options.level);
  if (options.level !== undefined && !minLevel) {
    console.error(`Unknown level "${options.level}". Use one of: ${LOG_LEVELS.join(", ")}.`);
    process.exit(1);
  }

  const lines = parseInt(options.tail ?? "50", 10);
  const content = readFileSync(logFile(), "utf-8");
  const allLines = content.split("\n");
  const shown = minLevel ? filterLogLines(allLines, minLevel) : allLines;
  const lastN = shown.slice(-lines).join("\n");

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

    // With a level, whole lines only: a chunk can end mid-line, and a continuation line
    // belongs to the record above it, so both the partial line and that decision carry over.
    const keep = minLevel ? createLogLineFilter(minLevel) : null;
    let partial = "";
    const emit = (text: string) => {
      if (!keep) return process.stdout.write(text);
      const parts = (partial + text).split("\n");
      partial = parts.pop() ?? "";
      const out = parts.filter((line) => keep(line));
      if (out.length) process.stdout.write(out.join("\n") + "\n");
    };

    watch(logFile(), () => {
      try {
        const newSize = statSync(logFile()).size;
        if (newSize > lastSize) {
          const fd = Bun.file(logFile());
          fd.slice(lastSize, newSize).text().then(emit);
          lastSize = newSize;
        }
      } catch {}
    });
  }
}

/** Get last N lines of log for bug reports — never DEBUG, which can hold tool output. */
export function getRecentLogs(lines = 30): string {
  if (!existsSync(logFile())) return "(no logs)";
  const content = readFileSync(logFile(), "utf-8");
  return redactForBugReport(filterLogLines(content.split("\n"), "info").slice(-lines).join("\n").trim()) || "(empty)";
}
