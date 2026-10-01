/** The details sheet's words for where a log came from, and a launchd job's command line. */
import { describe, expect, test } from "bun:test";
import {
  argumentsText, logEmptyText, logHeading, logLoadingText, outputText,
} from "../../../src/web/components/system/services/service-details-text";

const files = (...paths: string[]) => ({ kind: "files" as const, paths });
const unified = { kind: "unified" as const, minutes: 5 };
const sinceStart = { kind: "unified" as const, since: "start" as const };
const sinceBoot = { kind: "unified" as const, since: "boot" as const };

describe("the log's heading and its empty text", () => {
  test("systemd reads this boot's journal, whatever the details say", () => {
    expect(logHeading("systemd", undefined)).toBe("Log (this boot)");
    expect(logLoadingText("systemd")).toBe("Reading the journal…");
    expect(logEmptyText("systemd", undefined)).toBe("No entries this boot.");
  });

  test("launchd names the files it read, by name", () => {
    expect(logHeading("launchd", files("/Users/user/Library/Logs/agent.log"))).toBe("Log (agent.log)");
    expect(logHeading("launchd", files("/var/log/out.log", "/var/log/err.log"))).toBe("Log (out.log, err.log)");
    expect(logEmptyText("launchd", files("/var/log/out.log"))).toBe("The log file is empty.");
    expect(logEmptyText("launchd", files("/var/log/out.log", "/var/log/err.log"))).toBe("The log files are empty.");
  });

  test("or how far back the unified log was read: the whole run, or this boot for a stopped job", () => {
    expect(logHeading("launchd", sinceStart)).toBe("Log (since the job started)");
    expect(logEmptyText("launchd", sinceStart)).toBe("No entries since the job started.");
    expect(logHeading("launchd", sinceBoot)).toBe("Log (this boot)");
    expect(logEmptyText("launchd", sinceBoot)).toBe("No entries this boot.");
  });

  test("and only the window it reached when the whole of it took too long, which is all it looked at", () => {
    expect(logHeading("launchd", unified)).toBe("Log (last 5 minutes)");
    expect(logEmptyText("launchd", unified)).toBe("No entries in the last 5 minutes.");
  });

  test("before the details arrive, nothing it cannot know yet", () => {
    expect(logHeading("launchd", undefined)).toBe("Log");
    expect(logLoadingText("launchd")).toBe("Reading the log…");
  });
});

describe("argumentsText", () => {
  test("what follows the program, quoted where a space would split an argument", () => {
    expect(argumentsText(["/usr/bin/ssh-agent", "-l"])).toBe("-l");
    expect(argumentsText(["/bin/sh", "-c", "echo hi", ""])).toBe('-c "echo hi" ""');
  });

  test("no arguments is a dash", () => {
    expect(argumentsText(["/usr/sbin/mDNSResponder"])).toBe("—");
    expect(argumentsText(undefined)).toBe("—");
  });
});

describe("outputText", () => {
  test("one path when stdout and stderr share a file, which most jobs do", () => {
    expect(outputText({ stdoutPath: "/tmp/a.log", stderrPath: "/tmp/a.log" })).toBe("/tmp/a.log");
  });

  test("each stream named when they differ, or when only one goes anywhere", () => {
    expect(outputText({ stdoutPath: "/tmp/o.log", stderrPath: "/tmp/e.log" })).toBe("stdout /tmp/o.log · stderr /tmp/e.log");
    expect(outputText({ stdoutPath: null, stderrPath: "/tmp/e.log" })).toBe("stderr /tmp/e.log");
  });

  test("nowhere is a dash", () => {
    expect(outputText({ stdoutPath: null, stderrPath: null })).toBe("—");
    expect(outputText(null)).toBe("—");
  });
});
