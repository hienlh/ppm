/**
 * A long install prints "still working" lines on stderr while it waits, stops when the request
 * ends (whether it worked or failed), and prints nothing for an ordinary request.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isTimeoutError, withProgress } from "../../../src/cli/utils/request-progress.ts";

const realError = console.error;
afterEach(() => { console.error = realError; });

function captureStderr(): string[] {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  return lines;
}

describe("withProgress", () => {
  it("prints a line while a long request waits, and none after it ends", async () => {
    const lines = captureStderr();
    const answer = await withProgress(() => Bun.sleep(130).then(() => "done"), true, 40);
    expect(answer).toBe("done");
    const printed = lines.length;
    expect(printed).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.startsWith("… still working ("))).toBe(true);
    await Bun.sleep(100);
    expect(lines.length).toBe(printed);
  });

  it("stops on a failure and passes it on", async () => {
    const lines = captureStderr();
    await expect(withProgress(() => Bun.sleep(60).then(() => { throw new Error("install failed"); }), true, 25)).rejects.toThrow("install failed");
    const printed = lines.length;
    await Bun.sleep(80);
    expect(lines.length).toBe(printed);
  });

  it("prints nothing when not asked", async () => {
    const lines = captureStderr();
    await withProgress(() => Bun.sleep(60), false, 10);
    expect(lines).toEqual([]);
  });
});

describe("isTimeoutError", () => {
  it("knows the error an AbortSignal timeout throws, and nothing else", async () => {
    const signal = AbortSignal.timeout(1);
    await Bun.sleep(20);
    expect(isTimeoutError(signal.reason)).toBe(true);
    expect(isTimeoutError(new Error("connection refused"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});
