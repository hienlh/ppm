/**
 * macOS process details.
 *
 * Every fixture in here is output a real M1 Max printed, because the parsing is
 * positional and the two hazards are both about spacing: `lstart` spans five
 * tokens and pads a single-digit day with two spaces, and `comm` is a full path
 * that routinely contains spaces of its own.
 *
 * The contract under test is the one the feature exists to restore: a pid that
 * is gone yields `null` (so the route's "no longer running" is true when it is
 * said), and a field this host will not reveal yields `null` for that field
 * alone rather than failing the read.
 */
import { describe, test, expect } from "bun:test";
import {
  parsePsLine, parseThreadCount, parseLsofCwd, readProcessDetailsDarwin, DARWIN_PROCESS_STATES,
} from "../../../../src/services/system-metrics/process-details-darwin.ts";
import type { RunResult, Runner } from "../../../../src/services/host-info/spawn-runner.ts";

/** What `ps -o ppid=,stat=,nice=,lstart=,user=,comm= -p 559` printed for Finder. */
const FINDER = "    1 S     0 Tue Sep  8 10:05:03 2026     thawng /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";

/** The same for a Chrome renderer: six spaces inside the executable path. */
const CHROME = "    1 S     0 Sat Sep 12 20:14:46 2026     thawng /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/153.0.8010.36/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)";

const run = (map: Record<string, Partial<RunResult>>): Runner => async (argv) => {
  const key = argv.includes("-M") ? "threads" : argv[0] === "lsof" ? "lsof" : argv.includes("command=") ? "command" : "ps";
  return { stdout: "", stderr: "", code: 0, timedOut: false, ...map[key] };
};

describe("parsePsLine", () => {
  test("reads every field off a line a Mac actually printed", () => {
    expect(parsePsLine(FINDER)).toEqual({
      ppid: 1,
      state: "Sleeping",
      nice: 0,
      // Local time, because `lstart` is printed in the host's zone.
      startedAt: new Date(2026, 8, 8, 10, 5, 3).getTime(),
      user: "thawng",
      exe: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    });
  });

  test("a single-digit day pads with two spaces and must not shift a field", () => {
    // `Sep  8` against `Sep 12`: the whole reason the split is on `\s+`.
    expect(parsePsLine(FINDER)?.user).toBe("thawng");
    expect(parsePsLine(CHROME)?.user).toBe("thawng");
  });

  test("an executable path with spaces survives, because comm is taken as the tail", () => {
    expect(parsePsLine(CHROME)?.exe).toBe(
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/153.0.8010.36/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
    );
  });

  test("only the first letter of the BSD state is the state", () => {
    // `Ss`, `S+`, `R<` — the rest are flags (session leader, foreground, priority).
    expect(parsePsLine("1747 Ss    0 Sat Sep 12 20:01:41 2026     thawng zsh")?.state).toBe("Sleeping");
    expect(parsePsLine("   1 Rs    0 Tue Sep  8 09:59:57 2026     _windowserver /x")?.state).toBe("Running");
  });

  test("U is uninterruptible sleep here, not Linux's D", () => {
    expect(DARWIN_PROCESS_STATES.U).toBe("Uninterruptible sleep");
    expect(DARWIN_PROCESS_STATES.D).toBeUndefined();
    // 126 of this host's 777 processes were zombies, so Z is not an edge case.
    expect(parsePsLine("   1 Z     0 Tue Sep  8 09:59:57 2026     thawng /x")?.state).toBe("Zombie");
  });

  test("a state letter this table does not know is absent, never guessed", () => {
    expect(parsePsLine("   1 Q     0 Tue Sep  8 09:59:57 2026     thawng /x")?.state).toBeNull();
  });

  test("an empty comm is a process with no readable executable, not a failed line", () => {
    const f = parsePsLine("   1 S     0 Tue Sep  8 09:59:57 2026     root");
    expect(f?.ppid).toBe(1);
    expect(f?.exe).toBeNull();
  });

  test("a negative nice is kept — renicing down is legitimate", () => {
    expect(parsePsLine("   1 S   -20 Tue Sep  8 09:59:57 2026     root /x")?.nice).toBe(-20);
  });

  test.each([
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["too few fields", "1 S 0 thawng /x"],
    ["a non-numeric ppid", "x S     0 Tue Sep  8 09:59:57 2026     thawng /x"],
  ])("%s yields null", (_label, input) => {
    expect(parsePsLine(input as string | null | undefined)).toBeNull();
  });

  test("an unparseable date is 0, which the dialog draws as an em dash", () => {
    // Not `Date.now()`: inventing a start time is worse than admitting none.
    expect(parsePsLine("   1 S     0 Not a real date here     thawng /x")?.startedAt).toBe(0);
  });
});

describe("parseThreadCount", () => {
  /** The first five lines of `ps -M -p 559` — a header, then one row per thread. */
  const PS_M = [
    "USER     PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
    "thawng   559   ??    0.0 S    46T   0:48.13   1:14.78 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    "         559         0.0 S    46T   0:21.65   0:14.82 ",
    "         559         0.0 S    20T   0:00.12   0:00.49 ",
    "         559         0.0 S    46T   0:00.01   0:00.02 ",
  ].join("\n");

  test("counts the rows below the header", () => {
    expect(parseThreadCount(PS_M)).toBe(4);
  });

  test("a header on its own is not zero threads — it is a dump we could not use", () => {
    expect(parseThreadCount("USER     PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND")).toBeNull();
    expect(parseThreadCount("")).toBeNull();
    expect(parseThreadCount(null)).toBeNull();
  });
});

describe("parseLsofCwd", () => {
  test("takes the n-prefixed field out of lsof's machine-readable form", () => {
    expect(parseLsofCwd("p1748\nfcwd\nn/Users/thawng\n")).toBe("/Users/thawng");
    expect(parseLsofCwd("p9248\nfcwd\nn/\n")).toBe("/");
  });

  test("another user's process answers exit 0 with nothing, which is absent not empty", () => {
    expect(parseLsofCwd("")).toBeNull();
    expect(parseLsofCwd("p164\n")).toBeNull();
  });
});

describe("readProcessDetailsDarwin", () => {
  test("assembles the dialog's fields from four calls", async () => {
    const d = await readProcessDetailsDarwin(559, run({
      ps: { stdout: FINDER },
      command: { stdout: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder\n" },
      threads: { stdout: "HEADER\na\nb\nc\n" },
      lsof: { stdout: "p559\nfcwd\nn/Users/thawng\n" },
    }));
    expect(d).toMatchObject({
      pid: 559,
      ppid: 1,
      name: "Finder",
      user: "thawng",
      state: "Sleeping",
      threads: 3,
      nice: 0,
      cwd: "/Users/thawng",
      exe: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    });
  });

  test("cgroup is null, because macOS has none — an em dash, not an invention", async () => {
    const d = await readProcessDetailsDarwin(559, run({ ps: { stdout: FINDER } }));
    expect(d?.cgroup).toBeNull();
  });

  test("a pid that is gone is null, so the route's 'no longer running' is true", async () => {
    // `ps -p <gone>` exits 1 with nothing on stdout.
    const d = await readProcessDetailsDarwin(99998, run({ ps: { code: 1 } }));
    expect(d).toBeNull();
  });

  test("a missing `ps` is null too, not a throw escaping the request", async () => {
    // `Bun.spawn` raises synchronously for a binary off PATH; the shared runner
    // turns that into `code: null`, which must not be mistaken for success.
    const d = await readProcessDetailsDarwin(559, run({ ps: { code: null, stderr: "Executable not found in $PATH" } }));
    expect(d).toBeNull();
  });

  test("one failed side call costs that field alone", async () => {
    const d = await readProcessDetailsDarwin(559, run({
      ps: { stdout: FINDER },
      command: { code: 1 },
      threads: { code: 1 },
      lsof: { code: 1 },
    }));
    expect(d?.ppid).toBe(1);
    expect(d?.user).toBe("thawng");
    expect(d?.command).toBeNull();
    expect(d?.threads).toBeNull();
    expect(d?.cwd).toBeNull();
  });

  test("the command line is redacted but not truncated", async () => {
    const long = `/x --token=${"s".repeat(40)} ` + "--flag ".repeat(40);
    const d = await readProcessDetailsDarwin(559, run({ ps: { stdout: FINDER }, command: { stdout: long } }));
    expect(d?.command).not.toContain("s".repeat(40));
    expect(d?.command!.length).toBeGreaterThan(160);
  });

  test.each([0, -1, 1.5, NaN])("pid %p is rejected before anything is spawned", async (pid) => {
    let spawned = 0;
    const counting: Runner = async () => { spawned++; return { stdout: "", stderr: "", code: 0, timedOut: false }; };
    expect(await readProcessDetailsDarwin(pid, counting)).toBeNull();
    expect(spawned).toBe(0);
  });
});
