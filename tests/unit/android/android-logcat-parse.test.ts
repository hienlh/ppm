/**
 * The logcat line parser.
 *
 * This exists because emulator 36.5.10.0's `sort: Parsed` is not implemented and fails *silently*
 * — it streams empty messages rather than erroring (see `android-logcat.ts`). So the structure
 * every filter and every level colour depends on is produced by this regex, and a quiet mistake
 * in it looks like a device that only ever logs at verbose.
 */
import { describe, expect, it } from "bun:test";
import { parseLogcatLine } from "../../../src/services/android/android-logcat.ts";

// Fixed "now" so the year inference is deterministic; `bun test` forces TZ=UTC (CLAUDE.md), and
// the parser builds a local-time Date, so both sides of every timestamp assertion agree.
const NOW = new Date(2026, 8, 21, 13, 10, 0);

describe("parseLogcatLine", () => {
  it("parses a real threadtime line", () => {
    const e = parseLogcatLine("09-21 13:09:42.640  3841  3841 I PPMPROBE: hello from probe", 7, NOW)!;
    expect(e.id).toBe(7);
    expect(e.pid).toBe(3841);
    expect(e.tid).toBe(3841);
    expect(e.level).toBe("info");
    expect(e.tag).toBe("PPMPROBE");
    expect(e.message).toBe("hello from probe");
    expect(e.timestamp).toBe(new Date(2026, 8, 21, 13, 9, 42, 640).getTime());
  });

  it("maps every level letter", () => {
    const levels = { V: "verbose", D: "debug", I: "info", W: "warn", E: "error", F: "fatal", A: "fatal" };
    for (const [letter, expected] of Object.entries(levels)) {
      const e = parseLogcatLine(`09-21 13:09:42.640  1  1 ${letter} T: m`, 1, NOW)!;
      expect(`${letter}=${e.level}`).toBe(`${letter}=${expected}`);
    }
  });

  it("keeps a tag containing dots and a message containing colons", () => {
    const line = "09-21 13:09:43.437   778   778 I vol.VolumeDialogImpl: mDialog.dismiss() reason: volume_controller";
    const e = parseLogcatLine(line, 1, NOW)!;
    expect(e.tag).toBe("vol.VolumeDialogImpl");
    expect(e.message).toBe("mDialog.dismiss() reason: volume_controller");
  });

  it("keeps a line it cannot parse rather than dropping it", () => {
    // A stack-trace continuation and logcat's own banner both look like this, and losing either
    // would cut a crash in half.
    const e = parseLogcatLine("\tat com.example.Foo.bar(Foo.java:12)", 3, NOW)!;
    expect(e.message).toBe("\tat com.example.Foo.bar(Foo.java:12)");
    expect(e.tag).toBe("");
    expect(e.pid).toBe(0);

    const banner = parseLogcatLine("--------- beginning of main", 4, NOW)!;
    expect(banner.message).toBe("--------- beginning of main");
  });

  it("drops an empty line", () => {
    expect(parseLogcatLine("", 1, NOW)).toBeNull();
  });

  it("handles a message that is empty", () => {
    const e = parseLogcatLine("09-21 13:09:42.640  1  2 W Tag:", 1, NOW)!;
    expect(e.tag).toBe("Tag");
    expect(e.message).toBe("");
  });

  it("assumes the current year, and steps back when that lands in the future", () => {
    // Reading a December log on the 1st of January: the naive year makes it 11 months ahead.
    const newYear = new Date(2027, 0, 1, 0, 30, 0);
    const e = parseLogcatLine("12-31 23:59:00.000  1  1 I T: m", 1, newYear)!;
    expect(new Date(e.timestamp).getFullYear()).toBe(2026);
    expect(e.timestamp).toBeLessThan(newYear.getTime());
  });

  it("does not step back for a line a few minutes ahead", () => {
    // Clocks drift; a guest slightly ahead of the host must not be dated a year back.
    const e = parseLogcatLine("09-21 13:15:00.000  1  1 I T: m", 1, NOW)!;
    expect(new Date(e.timestamp).getFullYear()).toBe(2026);
    expect(new Date(e.timestamp).getMonth()).toBe(8);
  });
});
