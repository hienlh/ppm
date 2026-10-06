/** PPM's log levels, lowest first. What each one is for: `src/services/logger.ts`. */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

export function logLevelRank(level: LogLevel): number {
  return RANK[level];
}

/** `"WARN"`, `" warn "`, `"warn"` → `"warn"`; anything else → `null`. */
export function parseLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : null;
}

const RECORD_PREFIX = /^\[[^\]]*\] \[(DEBUG|INFO|WARN|ERROR|FATAL)\] /;

/**
 * A line-by-line test for "is this part of a record at `min` or above", for reading `ppm.log`
 * back. A line without the `[time] [LEVEL]` prefix continues the record above it — a stack
 * trace, a multi-line message — and goes wherever that record went. Lines before the first
 * record are dropped: in a tail they are the end of a record whose level was cut off, and that
 * record may have been DEBUG. Stateful: feed lines in file order.
 */
export function createLogLineFilter(min: LogLevel): (line: string) => boolean {
  let keep = false;
  return (line) => {
    const m = RECORD_PREFIX.exec(line);
    if (m) keep = RANK[m[1]!.toLowerCase() as LogLevel] >= RANK[min];
    return keep;
  };
}

export function filterLogLines(lines: readonly string[], min: LogLevel): string[] {
  const keep = createLogLineFilter(min);
  return lines.filter((line) => keep(line));
}
