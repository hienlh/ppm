/**
 * The leveled logger: what is dropped, what reaches `ppm.log`, and in what shape.
 *
 * The file format is the contract here — `ppm logs --level`, the bug report and
 * `/api/logs/recent` all read `[time] [LEVEL] [scope] message` back — and so is the console
 * fallback, which must print exactly what the `console.*("[scope] …")` call it replaced printed.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger, installFileLogSink, setLogLevel, getLogLevel, applyConfiguredLogLevel,
  parseLogLevel, formatLogLine, _resetLoggerForTests, LOG_LEVEL_ENV, sendConsoleLogsToStderr,
} from "../../../src/services/logger.ts";
import { STDIO_IS_LOG_ENV } from "../../../src/services/log-rotate.ts";

let dir: string;
let logPath: string;
let uninstall: () => void = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-logger-"));
  logPath = join(dir, "ppm.log");
  delete process.env[LOG_LEVEL_ENV];
  _resetLoggerForTests();
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
  delete process.env[LOG_LEVEL_ENV];
  delete process.env[STDIO_IS_LOG_ENV];
  _resetLoggerForTests();
  rmSync(dir, { recursive: true, force: true });
});

const fileLines = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n") : []);

describe("level names", () => {
  it("accepts the five levels in any case and rejects the rest", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" warn ")).toBe("warn");
    expect(parseLogLevel("fatal")).toBe("fatal");
    expect(parseLogLevel("verbose")).toBeNull();
    expect(parseLogLevel(3)).toBeNull();
    expect(parseLogLevel(undefined)).toBeNull();
  });
});

describe("without a file sink (CLI, tests)", () => {
  it("prints what the console call it replaced printed", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      createLogger("scope").warn("something odd", 42);
      expect(warn).toHaveBeenCalledWith("[scope] something odd", 42);
    } finally { warn.mockRestore(); }
  });

  it("drops a line below the threshold before printing it", () => {
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const l = createLogger("s");
      l.debug("chatter");
      expect(debug).not.toHaveBeenCalled();
      setLogLevel("debug");
      log.mockClear();
      l.debug("chatter");
      expect(debug).toHaveBeenCalledWith("[s] chatter");
    } finally { debug.mockRestore(); log.mockRestore(); }
  });

  it("keeps a CLI command's stdout for its own output", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      sendConsoleLogsToStderr();
      createLogger("db").info("pool opened");
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("[db] pool opened");
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});

describe("with the file sink", () => {
  it("writes [time] [LEVEL] [scope] message, one line per record", () => {
    uninstall = installFileLogSink({ echo: "stderr", path: logPath });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const l = createLogger("fs-ops");
      l.info("deleted 3 entries");
      l.warn("fell back");
      l.error("failed");
      l.fatal("cannot start");
    } finally { stderr.mockRestore(); }
    const lines = fileLines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[fs-ops\] deleted 3 entries$/);
    expect(lines[1]).toContain("[WARN] [fs-ops] fell back");
    expect(lines[2]).toContain("[ERROR] [fs-ops] failed");
    expect(lines[3]).toContain("[FATAL] [fs-ops] cannot start");
  });

  it("keeps an Error's message and stack instead of writing {}", () => {
    uninstall = installFileLogSink({ echo: "stderr", path: logPath });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      createLogger("x").error("boom:", new Error("disk full"));
    } finally { stderr.mockRestore(); }
    const text = readFileSync(logPath, "utf8");
    expect(text).toContain("[ERROR] [x] boom: Error: disk full");
    expect(text).toContain("    at ");
    expect(text).not.toContain("{}");
  });

  it("redacts secrets in the written line", () => {
    const line = formatLogLine("info", "auth", ["header Bearer abc123", "url ?token=s3cret&x=1"]);
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("s3cret");
    expect(line).toContain("Bearer [REDACTED]");
  });

  it("routes bare console calls by level, under the same threshold", () => {
    process.env[STDIO_IS_LOG_ENV] = "1"; // no echo: keep the test output clean
    uninstall = installFileLogSink({ echo: "console", routeConsole: true, path: logPath });
    console.debug("[sdk] delta"); // below `info`: dropped
    console.log("[chat] turn started");
    console.info("[chat] info alias");
    console.warn("[chat] retrying");
    console.error("[chat] failed");
    uninstall();
    uninstall = () => {};
    const lines = fileLines();
    expect(lines.map((l) => l.replace(/^\[[^\]]+\] /, ""))).toEqual([
      "[INFO] [chat] turn started",
      "[INFO] [chat] info alias",
      "[WARN] [chat] retrying",
      "[ERROR] [chat] failed",
    ]);
  });

  it("still shows a routed console line it keeps out of the file", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      uninstall = installFileLogSink({ echo: "console", routeConsole: true, path: logPath });
      setLogLevel("warn");
      console.log("  ➜  Local: http://localhost:8080/");
      expect(log).toHaveBeenCalledWith("  ➜  Local: http://localhost:8080/");
    } finally { uninstall(); uninstall = () => {}; log.mockRestore(); }
    expect(readFileSync(logPath, "utf8")).not.toContain("Local:");
  });

  it("restores the console methods it replaced", () => {
    const before = console.warn;
    process.env[STDIO_IS_LOG_ENV] = "1";
    const undo = installFileLogSink({ echo: "console", routeConsole: true, path: logPath });
    expect(console.warn).not.toBe(before);
    undo();
    expect(console.warn).toBe(before);
  });

  it("does not echo to a stream that is already the log file", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    process.env[STDIO_IS_LOG_ENV] = "1";
    try {
      uninstall = installFileLogSink({ echo: "console", path: logPath });
      createLogger("s").info("once");
      createLogger("s").warn("once too");
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); }
    expect(fileLines()).toHaveLength(2);
  });

  it("echoes to the console, in the original shape, when stdio is a terminal", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      uninstall = installFileLogSink({ echo: "console", path: logPath });
      createLogger("s").info("hello", { n: 1 });
      expect(log).toHaveBeenCalledWith("[s] hello", { n: 1 });
    } finally { log.mockRestore(); }
  });
});

describe("the configured level", () => {
  it("follows the config, and an unknown value means the default", () => {
    expect(applyConfiguredLogLevel("debug")).toBe(true);
    expect(getLogLevel()).toBe("debug");
    expect(applyConfiguredLogLevel("debug")).toBe(false);
    applyConfiguredLogLevel("nonsense");
    expect(getLogLevel()).toBe("info");
  });

  it("is pinned by PPM_LOG_LEVEL, which the config cannot override", () => {
    process.env[LOG_LEVEL_ENV] = "error";
    _resetLoggerForTests();
    expect(getLogLevel()).toBe("error");
    expect(applyConfiguredLogLevel("debug")).toBe(false);
    expect(getLogLevel()).toBe("error");
  });

  it("puts every change on record, in both directions", () => {
    uninstall = installFileLogSink({ echo: "stderr", path: logPath });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      setLogLevel("warn"); // up from the default
      setLogLevel("debug"); // down
      setLogLevel("warn");
      setLogLevel("error"); // above INFO on both sides
      setLogLevel("fatal");
      setLogLevel("warn");
    } finally { stderr.mockRestore(); }
    const lines = fileLines();
    expect(lines.map((l) => l.replace(/^\[[^\]]+\] /, ""))).toEqual([
      "[INFO] [logger] Log level info → warn",
      "[INFO] [logger] Log level warn → debug",
      "[INFO] [logger] Log level debug → warn",
      "[INFO] [logger] Log level warn → error",
      "[INFO] [logger] Log level error → fatal",
      "[INFO] [logger] Log level fatal → warn",
    ]);
  });
});
