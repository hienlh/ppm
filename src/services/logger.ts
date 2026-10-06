/**
 * PPM's leveled logger: `const log = createLogger("scope"); log.info("…")`.
 *
 * Every line ends up in `~/.ppm/ppm.log` as `[ISO time] [LEVEL] [scope] message` — the format
 * `ppm logs`, the bug report and `/api/logs/recent` already read — in any process that called
 * `installFileLogSink()`, which is the server child and the supervisor. Anywhere else (tests,
 * one-off scripts) a line goes to the console method of its level, shaped exactly like the
 * `console.*("[scope] …")` call it replaced, so nothing changes for a terminal or a test spying
 * on `console.warn`. CLI commands send every level to stderr (`sendConsoleLogsToStderr`).
 *
 * Levels, lowest first, and what each one is for:
 * - `debug`: per-event chatter (a stream delta, a skipped no-op, protocol detail) — only worth
 *   having while diagnosing something. Off by default.
 * - `info`:  lifecycle and state changes, at a rate a person can read: something started,
 *   stopped, was created, deleted, installed, committed; a background job ran.
 * - `warn`:  unexpected but recovered — a fallback taken, a retry, a refusal, a timeout.
 * - `error`: something that was asked for did not happen.
 * - `fatal`: the process is about to exit, or a core subsystem cannot run at all.
 *
 * A line below the threshold is dropped before anything is formatted. The threshold is
 * `PPM_LOG_LEVEL` when that is set — it pins the level for the life of the process — else the
 * `log_level` config row (`ppm config set log_level debug`, picked up by a running server within
 * seconds, see `log-level-config.ts`), else `info`.
 *
 * Why the level matters here and is not a nicety: before it existed every line was INFO, and 81%
 * of `ppm.log` was one SDK event (`thinking_tokens`, one line per streamed delta). The log is
 * capped at 20 MB × 4 generations, so that chatter rotated everything else out within ~9 hours.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";
import { redactSecrets } from "./redact-secrets.ts";
import { stdioIsLogFile, consumeStdioIsLogEnv } from "./log-rotate.ts";
import { DEFAULT_LOG_LEVEL, logLevelRank, parseLogLevel, type LogLevel } from "../shared/log-levels.ts";

export { LOG_LEVELS, DEFAULT_LOG_LEVEL, parseLogLevel, type LogLevel } from "../shared/log-levels.ts";

/** Pins the level for the life of the process, over whatever the config says. */
export const LOG_LEVEL_ENV = "PPM_LOG_LEVEL";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  /** Whether `level` would be written — guard work done only to build a message. */
  isEnabled(level: LogLevel): boolean;
}

interface FileSink {
  /** Append one record to the file. Only for records that passed the level check. */
  write(level: LogLevel, scope: string | null, args: readonly unknown[]): void;
  /** Show it where the process's console would have, unless that stream is the file. */
  echo(level: LogLevel, scope: string | null, args: readonly unknown[]): void;
}

interface LogState {
  level: LogLevel;
  pinnedByEnv: boolean;
  /** `null` = no file sink installed: write to the console. */
  sink: FileSink | null;
  /** Without a file sink, every level goes to stderr — see `sendConsoleLogsToStderr`. */
  consoleToStderr: boolean;
}

/**
 * Kept on `globalThis` rather than in module scope: `bun --hot` (`bun dev:server`) re-evaluates
 * this module on every reload, and a fresh module-scoped state would silently drop the file sink
 * the server installed once at boot.
 */
const STATE_KEY = "__ppmLogState";
const state: LogState = ((globalThis as Record<string, unknown>)[STATE_KEY] as LogState | undefined)
  ?? ((globalThis as Record<string, unknown>)[STATE_KEY] = initialState());

function initialState(): LogState {
  const fromEnv = parseLogLevel(process.env[LOG_LEVEL_ENV]);
  return { level: fromEnv ?? DEFAULT_LOG_LEVEL, pinnedByEnv: fromEnv !== null, sink: null, consoleToStderr: false };
}

/**
 * For CLI commands: log lines go to stderr at every level, so a command's stdout — `--json`,
 * a pipe — carries only what the command itself prints, while a terminal still shows both.
 * The services a command runs in-process (a database pool, an SSH tunnel, a git write) log
 * like they do in the server. No effect once a file sink is installed (`ppm start` installs one).
 */
export function sendConsoleLogsToStderr(): void {
  state.consoleToStderr = true;
}

export function getLogLevel(): LogLevel {
  return state.level;
}

export function isLogLevelEnabled(level: LogLevel): boolean {
  return logLevelRank(level) >= logLevelRank(state.level);
}

/**
 * Apply the level the config asks for — unless `PPM_LOG_LEVEL` pinned one. An unset or invalid
 * value means the default. Returns whether the level changed.
 *
 * The change itself is always on record, as one INFO line that neither threshold filters: under
 * the more verbose of the two it would still be dropped between two levels above INFO
 * (`warn` → `error`).
 */
export function applyConfiguredLogLevel(value: unknown): boolean {
  if (state.pinnedByEnv) return false;
  return setLogLevel(parseLogLevel(value) ?? DEFAULT_LOG_LEVEL);
}

/** Set the threshold directly (tests, and `applyConfiguredLogLevel`). Returns whether it changed. */
export function setLogLevel(next: LogLevel): boolean {
  const from = state.level;
  if (next === from) return false;
  state.level = "debug"; // for this one line
  record("info", "logger", [`Log level ${from} → ${next}`]);
  state.level = next;
  return true;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => record("debug", scope, args),
    info: (...args) => record("info", scope, args),
    warn: (...args) => record("warn", scope, args),
    error: (...args) => record("error", scope, args),
    fatal: (...args) => record("fatal", scope, args),
    isEnabled: isLogLevelEnabled,
  };
}

function record(level: LogLevel, scope: string | null, args: readonly unknown[]): void {
  if (logLevelRank(level) < logLevelRank(state.level)) return;
  if (!state.sink) return consoleSink(level, scope, args);
  state.sink.write(level, scope, args);
  state.sink.echo(level, scope, args);
}

/**
 * A routed `console.*` call. Below the threshold it stays out of the file but is still shown:
 * routing the console into the log must never hide what the console used to show — `ppm start`
 * prints its URLs with `console.log`, and `log_level=warn` is a request for a quieter file, not
 * for a silent terminal.
 */
function recordConsole(sink: FileSink, level: LogLevel, args: readonly unknown[]): void {
  if (logLevelRank(level) >= logLevelRank(state.level)) sink.write(level, null, args);
  sink.echo(level, null, args);
}

/**
 * `"[scope] first"` + the remaining arguments: the exact shape of the `console.*` call a logger
 * call replaced, so the terminal output — and a test asserting on it — is unchanged.
 */
function consoleArgs(scope: string | null, args: readonly unknown[]): unknown[] {
  if (!scope) return [...args];
  if (typeof args[0] === "string") return [`[${scope}] ${args[0]}`, ...args.slice(1)];
  return [`[${scope}]`, ...args];
}

/** Looked up per call, not bound once, so a test's `spyOn(console, "warn")` sees the line. */
function consoleSink(level: LogLevel, scope: string | null, args: readonly unknown[]): void {
  const out = consoleArgs(scope, args);
  if (level === "warn") console.warn(...out);
  else if (level === "error" || level === "fatal" || state.consoleToStderr) console.error(...out);
  else if (level === "debug") console.debug(...out);
  else console.log(...out);
}

/** One argument as log text. An `Error` keeps its stack — `JSON.stringify(err)` is `{}`. */
function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg); // circular, BigInt
  }
}

export function formatLogArgs(args: readonly unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

/** The line as written to the file, newline included. Secrets are redacted here. */
export function formatLogLine(level: LogLevel, scope: string | null, args: readonly unknown[], now = new Date()): string {
  const prefix = scope ? `[${scope}] ` : "";
  return `[${now.toISOString()}] [${level.toUpperCase()}] ${prefix}${redactSecrets(formatLogArgs(args))}\n`;
}

export interface FileLogSinkOptions {
  /**
   * Where a line also goes when it is not already reaching the file through stdio:
   * - `"console"`: the console method of its level, as the original call would have printed it
   *   (the server child, so `bun dev:server` keeps its terminal output).
   * - `"stderr"`: the formatted line on stderr (the supervisor, whose stderr is the journal).
   */
  echo: "console" | "stderr";
  /**
   * Also make bare `console.*` calls log lines of their level: `debug` → DEBUG, `log`/`info` →
   * INFO, `warn` → WARN, `error` → ERROR. Most of the codebase still logs through `console.*`
   * with the scope written into the string (`"[sdk] …"`), and this is what puts those calls
   * under the same threshold, file and redaction as `createLogger()`. Only together with the
   * file sink: routed into the console sink, a console call would call itself.
   */
  routeConsole?: boolean;
  /** Defaults to `<ppm dir>/ppm.log`. */
  path?: string;
}

/**
 * Send this process's log lines to `ppm.log`. Once per process; returns an undo for tests.
 *
 * The supervisor hands its children `stdio: ["ignore", logFd, logFd]` where `logFd` is `ppm.log`
 * itself, so for them a console echo would be the same event arriving a second time — and
 * unredacted, since only the appended copy goes through `redactSecrets()`. Where a stream
 * already reaches the file, the echo to it is skipped (see `log-rotate.ts`).
 */
export function installFileLogSink(options: FileLogSinkOptions): () => void {
  if (state.sink) return () => {};
  const path = options.path ?? resolve(getPpmDir(), "ppm.log");
  const stdoutIsLog = stdioIsLogFile(1, path);
  const stderrIsLog = stdioIsLogFile(2, path);
  // Read once, then dropped: terminals, SDK children and `ppm` invocations spawned from this
  // process inherit its environment, and none of their stdouts is the log file.
  consumeStdioIsLogEnv();

  // Captured before `routeConsole` replaces them, or an echo would loop back in here.
  const original = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  state.sink = {
    write(level, scope, args) {
      try { appendFileSync(path, formatLogLine(level, scope, args)); } catch { /* a log that cannot be written must not throw into its caller */ }
    },
    echo(level, scope, args) {
      const toStderr = level === "warn" || level === "error" || level === "fatal";
      if (options.echo === "stderr") {
        if (stderrIsLog) return;
        try { process.stderr.write(formatLogLine(level, scope, args)); } catch { /* closed stderr */ }
        return;
      }
      if (toStderr ? stderrIsLog : stdoutIsLog) return;
      const out = consoleArgs(scope, args);
      if (level === "debug") original.debug.apply(console, out);
      else if (level === "info") original.log.apply(console, out);
      else if (level === "warn") original.warn.apply(console, out);
      else original.error.apply(console, out);
    },
  };

  if (options.routeConsole) {
    // Falls back to the original method once the sink is gone, rather than through the
    // console sink — which would call the routed method, i.e. itself.
    const route = (level: LogLevel, fallback: (...args: unknown[]) => void) => (...args: unknown[]) => {
      if (state.sink) recordConsole(state.sink, level, args);
      else fallback.apply(console, args);
    };
    console.debug = route("debug", original.debug);
    console.log = route("info", original.log);
    console.info = route("info", original.info);
    console.warn = route("warn", original.warn);
    console.error = route("error", original.error);
  }

  return () => {
    if (options.routeConsole) Object.assign(console, original);
    state.sink = null;
  };
}

/** Tests only: back to the console sink at the default (or env-pinned) level. */
export function _resetLoggerForTests(): void {
  Object.assign(state, initialState());
}
